// 记忆库：对话原文全量落库，按会话键取用；上下文预算裁剪也在这一层做完。
import type { DB } from '../core/db.ts';
import type { LLMMessage, Session, StoredMessage } from '../core/types.ts';
import { estimateTokens } from '../core/util.ts';
import { makeLogger } from '../core/logger.ts';

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
  };
}

/** 提示词里拿不到真人昵称时至少能区分说话人，但名字必须符合接口的字符要求 */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

function toLLMMessage(m: StoredMessage): LLMMessage {
  const out: LLMMessage = { role: m.role, content: m.content };
  if (m.role === 'user' && m.senderName && SAFE_NAME.test(m.senderName)) out.name = m.senderName;
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
}): number {
  const res = db.prepare(`
    INSERT INTO messages (session_key, role, content, sender_id, sender_name, msg_id, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    input.sessionKey,
    input.role,
    input.content ?? '',
    input.senderId ?? null,
    input.senderName ?? null,
    input.msgId ?? null,
    Date.now(),
  );
  const id = Number(res.lastInsertRowid);
  // 表不能无限长：每写 50 条顺手清一次最老的超额记录（保留最近 maxRows 条）
  if (id % 50 === 0) pruneMessages(db, MAX_ROWS);
  return id;
}

/** 消息表总行数上限，超出后从最老的开始删，保证库不会撑爆硬盘 */
export const MAX_ROWS = 30000;

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
export function buildContext(db: DB, session: Session, opts: { limit: number; maxTokens: number }): LLMMessage[] {
  const limit = Math.floor(Number(opts.limit));
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const msgs = recentMessages(db, session, limit);
  if (msgs.length === 0) return [];

  const budget = Number.isFinite(opts.maxTokens) ? opts.maxTokens : 0;
  const picked: StoredMessage[] = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const cost = estimateTokens(m.content) + 2;
    // 从新往旧收，预算不够就停：留下的是连续的一段后缀
    if (picked.length > 0 && used + cost > budget) break;
    picked.push(m);
    used += cost;
  }
  picked.reverse();
  return picked.map(toLLMMessage);
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
