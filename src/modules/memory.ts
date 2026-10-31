// 记忆库：对话原文全量落库，按会话键取用；上下文预算裁剪也在这一层做完。
import type { DB } from '../core/db.ts';
import type { LLMMessage, Session, StoredMessage } from '../core/types.ts';
import { estimateTokens } from '../core/util.ts';
import { makeLogger } from '../core/logger.ts';
import { getFavor } from './favor.ts';
import { isMasterQq } from '../core/config.ts';

const log = makeLogger('memory');

/** 开启「记忆共享」的会话共用一个桶，群与私聊的记忆可以互通 */
const SHARED_KEY = 'shared';

type Row = Record<string, unknown>;

function str(v: unknown, d = ''): string { return v === null || v === undefined ? d : String(v); }
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** 库里 role 有 CHECK 约束，这里再做一层兜底，脏数据一律当 user */
function toRole(v: unknown): 'user' | 'assistant' | 'system' {
  const s = str(v);
  return s === 'assistant' || s === 'system' ? s : 'user';
}

function rowToMessage(r: Row): StoredMessage {
  return {
    id: num(r.id),
    sessionKey: str(r.session_key),
    role: toRole(r.role),
    content: str(r.content),
    senderId: r.sender_id === null || r.sender_id === undefined ? null : String(r.sender_id),
    senderName: r.sender_name === null || r.sender_name === undefined ? null : String(r.sender_name),
    msgId: r.msg_id === null || r.msg_id === undefined ? null : String(r.msg_id),
    createdAt: num(r.created_at),
    senderRole: r.sender_role === null || r.sender_role === undefined ? null : String(r.sender_role),
    senderTitle: r.sender_title === null || r.sender_title === undefined ? null : String(r.sender_title),
    dialogTag: r.dialog_tag === null || r.dialog_tag === undefined ? null : String(r.dialog_tag),
  };
}

/** 群身份给模型看的中文名，老版就是这么写的 */
const ROLE_TEXT: Record<string, string> = { owner: '群主', admin: '管理员', member: '成员' };

function stamp(ts: number): string {
  const d = new Date(Number.isFinite(ts) ? ts : Date.now());
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 身份牌：[名称:昵称| QQ:号|身份:群主|好感度:20分(初识客套)|群头衔:xxx]
 * 正文信封和「@某人」共用这一个格式，保证模型看到的身份写法永远一致。
 */
export function identityBlock(
  who: { qq: string; name?: string | null; role?: string | null; title?: string | null },
  db: DB,
  masterIds: string[],
): string {
  const uin = String(who.qq ?? '').trim();
  const isBoss = isMasterQq(uin, masterIds);
  // 昵称里塞 5 位以上数字想冒充 QQ 号的，直接糊掉
  const nick = String(who.name ?? '').replace(/\d{5,}/g, '［违规］').trim() || '未知';

  let s = `[名称:${nick}| QQ:${uin || '未知'}`;
  // 群内身份（群主/管理员/成员）单独一项，老大的身份不覆盖它，另起一个「老大」字段
  const identity = ROLE_TEXT[String(who.role ?? '')] ?? '';
  if (identity) s += `|身份:${identity}`;
  if (isBoss) s += '|老大:是';
  if (uin) {
    if (isBoss) {
      s += '|好感度:至高主权(锁定)';
    } else {
      const st = getFavor(db, uin, false);
      s += `|好感度:${st.score}分(${st.levelName})`;
    }
  }
  if (who.title) s += `|群头衔:${who.title}`;
  return s + ']';
}

/**
 * 老版 V9.8.5 的消息包装，一字不差照搬：
 * `[当前对话:群聊|群名:xxx|群号:xxx][名称:昵称| QQ:号|身份:群主|好感度:20分(初识客套)|群头衔:xxx|msgId:1|时间:...]消息内容:[正文]`
 * 目的是让模型每句话都能看见「这人是谁、什么身份、什么头衔」，而不是靠猜。
 */
export function envelope(m: StoredMessage, db: DB, masterIds: string[]): string {
  let s = m.dialogTag ?? '';
  s += identityBlock(
    { qq: m.senderId ?? '', name: m.senderName, role: m.senderRole, title: m.senderTitle },
    db,
    masterIds,
  );
  if (m.msgId && m.msgId !== '0') s = s.slice(0, -1) + `|msgId:${m.msgId}|时间:${stamp(m.createdAt)}]`;
  else s = s.slice(0, -1) + `|时间:${stamp(m.createdAt)}]`;
  s += `消息内容:[${m.content}]`;
  return s;
}

function toLLMMessage(m: StoredMessage, db: DB, masterIds: string[]): LLMMessage {
  if (m.role !== 'user') return { role: m.role, content: m.content };
  const out: LLMMessage = { role: 'user', content: envelope(m, db, masterIds) };
  // 身份同时放一份进 name 字段（老版做法：name = "QQ:号码"）
  if (m.senderId) out.name = `QQ:${m.senderId}`;
  return out;
}

/** LIKE 的通配符要转义，否则用户搜 "%" 会命中全部 */
function likeEsc(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * 追加一条消息，返回自增 id。
 * 调用方负责先决定写哪个会话键（memoryShared 时通常直接传 'shared'）。
 */
export function appendMessage(db: DB, input: {
  sessionKey: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  senderId?: string | null;
  senderName?: string | null;
  msgId?: string | null;
  senderRole?: string | null;
  senderTitle?: string | null;
  dialogTag?: string | null;
}): number {
  const res = db.prepare(`
    INSERT INTO messages (session_key, role, content, sender_id, sender_name, msg_id, sender_role, sender_title, dialog_tag, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    input.sessionKey,
    input.role,
    input.content ?? '',
    input.senderId ?? null,
    input.senderName ?? null,
    input.msgId ?? null,
    input.senderRole ?? null,
    input.senderTitle ?? null,
    input.dialogTag ?? null,
    Date.now(),
  );
  const id = Number(res.lastInsertRowid);
  // 表不能无限长：每写 50 条顺手清一次最老的超额记录（保留最近 maxRows 条）
  if (id % 50 === 0) pruneMessages(db, MAX_ROWS);
  return id;
}

/** 消息表总行数上限，超出后从最老的开始删，保证库不会撑爆硬盘 */
export const MAX_ROWS = 200000; // 现在每条群消息都存，3 万条只够两三天，放到 20 万（约 150MB）

/** 手动裁剪：保留最近 maxRows 条，返回删掉的条数 */
export function pruneMessages(db: DB, maxRows = MAX_ROWS): number {
  const cap = Math.floor(Number(maxRows));
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const total = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as Row).c;
  const n = Number(total);
  if (!Number.isFinite(n) || n <= cap) return 0;
  const extra = n - cap;
  const res = db.prepare('DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY id ASC LIMIT ?)').run(extra);
  const removed = Number(res.changes ?? 0);
  if (removed > 0) log.info(`消息表已到上限，清理最旧的 ${removed} 条`);
  return removed;
}

/** 会话实际读写记忆用的键：共享记忆的会话统一落到 'shared' */
export function effectiveKey(session: Session): string {
  return session.memoryShared ? SHARED_KEY : session.key;
}

/** 最近 limit 条，按时间正序（旧 → 新）返回 */
export function recentMessages(db: DB, session: Session, limit: number): StoredMessage[] {
  const n = Math.floor(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return [];
  const rows = db.prepare(`
    SELECT * FROM messages WHERE session_key = ? ORDER BY id DESC LIMIT ?
  `).all(effectiveKey(session), n) as Row[];
  // id 自增即插入顺序，比 created_at 更稳（同毫秒也不乱）
  return rows.map(rowToMessage).reverse();
}

/**
 * 组装送进模型的上下文：旧 → 新，超 token 预算时从最旧开始丢，
 * 最后一条（刚触发回复的那句）无论如何都保留。
 */
export function buildContext(db: DB, session: Session, opts: { limit: number; maxTokens: number; masterIds?: string[] }): LLMMessage[] {
  const limit = Math.floor(Number(opts.limit));
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const msgs = recentMessages(db, session, limit);
  if (msgs.length === 0) return [];

  const budget = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 0;
  const masters = opts.masterIds ?? [];
  // 先包成信封再量：身份/好感度/时间这些字段也占 token，
  // 按裸正文算预算会低估一大截，实际发出去就超了 maxContextTokens
  const packed: LLMMessage[] = msgs.map((m) => toLLMMessage(m, db, masters));
  const picked: LLMMessage[] = [];
  let used = 0;
  for (let i = packed.length - 1; i >= 0; i--) {
    const m = packed[i];
    const cost = estimateTokens(m.content) + 2;
    // 从新往旧收，预算不够就停：留下的是连续的一段后缀
    if (picked.length > 0 && used + cost > budget) break;
    picked.push(m);
    used += cost;
  }
  picked.reverse();
  return picked;
}

/** 清空记忆：key 省略 = 清全部；返回删除条数 */
export function clearMemory(db: DB, key?: string): number {
  const res = key === undefined || key === null
    ? db.prepare('DELETE FROM messages').run()
    : db.prepare('DELETE FROM messages WHERE session_key = ?').run(key);
  const n = Number(res.changes);
  log.info(`清空记忆：${key ? key : '全部会话'}，删除 ${n} 条`);
  return n;
}

/** 记忆条数：key 省略 = 全库 */
export function messageCount(db: DB, key?: string): number {
  const row = (key === undefined || key === null
    ? db.prepare('SELECT COUNT(*) AS n FROM messages').get()
    : db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_key = ?').get(key)) as Row | undefined;
  return num(row?.n);
}

/** 关键词搜索，返回最新的在前，方便「翻历史」直接看最近的 */
export function searchHistory(db: DB, keyword: string, limit: number): StoredMessage[] {
  const kw = String(keyword ?? '').trim();
  const n = Math.floor(Number(limit));
  if (!kw || !Number.isFinite(n) || n <= 0) return [];
  const rows = db.prepare(`
    SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?
  `).all(`%${likeEsc(kw)}%`, n) as Row[];
  return rows.map(rowToMessage);
}

/** 全库概览：总条数 + 有记忆的会话数 */
export function historyStats(db: DB): { total: number; sessions: number } {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COUNT(DISTINCT session_key) AS sessions FROM messages
  `).get() as Row | undefined;
  return { total: num(row?.total), sessions: num(row?.sessions) };
}
