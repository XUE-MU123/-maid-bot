// AI 工具集：模型（function calling）能调用的 11 个动作。
// 好感度直接写 SQL（favor 表见 core/db.ts），不 import memory.ts / favor.ts，避免被别人进度卡住。
import { makeLogger } from '../core/logger.ts';
import { fmtTime, todayStr } from '../core/util.ts';
import type { DB } from '../core/db.ts';
import type { ToolCall, ToolDef, ToolResult } from '../core/types.ts';
import type { ToolContext } from './context.ts';
import { humanRemain, listIgnores } from './ignore.ts';

const log = makeLogger('tools');

/** 禁言上限：30 天 */
export const MAX_BAN_SEC = 2592000;
/** 禁言默认时长：10 分钟 */
export const DEFAULT_BAN_SEC = 600;
/** 好感度边界：与 favor.ts 的 LOW/HIGH 一致 */
export const FAVOR_MIN = -999999;
export const FAVOR_MAX = 999999;

type Args = Record<string, unknown>;

// ---------- 小工具 ----------

function asStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function asNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true') return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** 形如 12345 的 QQ 号（不强制 5 位以上，测试号也放行） */
function isQq(s: string): boolean {
  return /^\d{1,15}$/.test(s);
}

const ok = (content: string): ToolResult => ({ ok: true, content });
const fail = (content: string): ToolResult => ({ ok: false, content });

const isGroup = (ctx: ToolContext): boolean => ctx.msg.type === 'group' && !!ctx.msg.targetId;

/** 群管权限：必须群聊，且是老大或群主/管理员 */
export function hasAdmin(ctx: ToolContext): boolean {
  return isGroup(ctx) && (ctx.isMaster || ctx.msg.senderRole === 'owner' || ctx.msg.senderRole === 'admin');
}

/** 把人话留给模型：原始错误翻一句中文，别把 retcode 直接扔出去 */
export function humanError(err: unknown): string {
  const m = String((err as Error)?.message ?? err);
  if (m.includes('超时') || /timeout/i.test(m)) return 'QQ 接口没响应，过一会儿再试。';
  if (m.includes('未连接') || /ECONNREFUSED|closed|WebSocket/i.test(m)) return '我现在没连上 QQ，等连接恢复再说。';
  if (m.includes('retcode=1') || /权限|denied|forbidden|no permission/i.test(m)) return '权限不够，这个操作被拒绝了。';
  return `操作失败了：${m.slice(0, 120)}`;
}

/** 被保护的人：老大自己和机器人自己，不给动 */
export function protectedTarget(ctx: ToolContext, qq: string): string | null {
  if (ctx.config.bot.masterIds.includes(qq)) return '老大不能被这样对待，这个我不做。';
  if (ctx.config.bot.selfIds.includes(qq)) return '我不能对自己下手。';
  return null;
}

// ---------- 好感度（直接 SQL，语义对齐 favor.ts：分数 ±999999、正分受每日上限约束、set 不封顶） ----------

interface FavorRow { score: number; dailyGain: number; day: string }

function readFavorRow(db: DB, qq: string): FavorRow {
  const row = db.prepare('SELECT score, daily_gain, day FROM favor WHERE qq = ?').get(qq) as Record<string, unknown> | undefined;
  if (!row) return { score: 0, dailyGain: 0, day: '' };
  return { score: Number(row.score ?? 0), dailyGain: Number(row.daily_gain ?? 0), day: String(row.day ?? '') };
}

/** set_favor / add_favor 的公共实现 */
function changeFavor(ctx: ToolContext, args: Args, mode: 'set' | 'add'): ToolResult {
  const qq = asStr(args.user_id) ?? ctx.msg.senderId;
  if (!qq) return fail('我不知道要改谁的好感度。');
  const n = asNum(mode === 'set' ? args.score : args.delta);
  if (n === undefined) return fail(mode === 'set' ? '没告诉我设成多少分。' : '没告诉我加多少分。');
  return applyFavorDelta(ctx, qq, n, mode === 'set' ? '设置好感度' : '调整好感度', mode);
}

/**
 * 统一的好感度写入入口：
 * mode=add 时 value 是相对变化量（正分吃每日额度），mode=set 时 value 是目标分数（不封顶）。
 * 只写 favor / favor_log 两张表，不 import favor.ts（那边同事还在改）。
 */
export function applyFavorDelta(
  ctx: ToolContext, qq: string, value: number, reason: string, mode: 'add' | 'set' = 'add',
): ToolResult {
  if (!isQq(qq)) return fail(`QQ 号 ${qq} 看起来不对，没改。`);
  if (ctx.config.bot.masterIds.includes(qq)) return fail('老大的好感度是锁定的，不用打分啦。');

  const row = readFavorRow(ctx.db, qq);
  const today = todayStr();
  const gainToday = row.day === today ? row.dailyGain : 0;
  const cap = Math.max(0, Math.floor(ctx.config.bot.dailyGainCap));

  // 老大亲自下令：加减多少就是多少，不看每日额度，也不占对方的额度
  const boss = !!ctx.isMaster;
  let after: number;
  let gain = gainToday;
  let capped = false;
  if (mode === 'set') {
    after = clampInt(value, FAVOR_MIN, FAVOR_MAX);
  } else {
    const d = Math.round(value);
    if (d > 0) {
      if (boss) {
        after = row.score + d;
      } else {
        const room = Math.max(0, cap - gainToday);
        const add = Math.min(d, room);
        after = row.score + add;
        gain = gainToday + add;
        capped = add < d;
      }
    } else {
      after = row.score + d; // 扣分不限
    }
  }
  after = clampInt(after, FAVOR_MIN, FAVOR_MAX);
  const diff = after - row.score;
  if (diff === 0) {
    const why = capped ? '（今天的好感度已经加满了）' : '（到边界了）';
    return ok(`${qq} 的好感度还是 ${row.score}，这次没变化${why}。`);
  }

  const now = Date.now();
  try {
    ctx.db.prepare(`
      INSERT INTO favor (qq, score, daily_gain, day, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(qq) DO UPDATE SET score = excluded.score, daily_gain = excluded.daily_gain,
        day = excluded.day, updated_at = excluded.updated_at
    `).run(qq, after, gain, today, now);
    ctx.db.prepare(`
      INSERT INTO favor_log (qq, session_key, delta, before, after, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(qq, ctx.session.key, diff, row.score, after, reason, now);
  } catch (err) {
    log.warn(`好感度写库失败：${String(err)}`);
    return fail('好感度没写进数据库，稍后再试。');
  }
  ctx.note(`好感度 ${qq}: ${row.score} → ${after}`);
  const tip = capped ? `（今日额度只剩这么多，封顶 ${cap}）` : '';
  return ok(`好感度更新：${qq} ${row.score} → ${after}（${diff >= 0 ? '+' : ''}${diff}）${tip}`);
}

// ---------- 工具 schema ----------

/** JSON Schema 没有默认值语义，默认值在 handler 里处理 */
export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'ban_member',
    description: '禁言群里某个成员（仅群聊）。不给 user_id 就禁言当前说话的人；不给秒数默认 600 秒。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '要禁言的 QQ 号，省略表示当前消息发送者' },
        duration_sec: { type: 'number', description: `禁言秒数，默认 ${DEFAULT_BAN_SEC}，最长 ${MAX_BAN_SEC}（30 天）；填 0 表示解禁` },
      },
      required: [],
    },
  },
  {
    name: 'unban_member',
    description: '解除某个群成员的禁言（仅群聊）。',
    parameters: {
      type: 'object',
      properties: { user_id: { type: 'string', description: '要解禁的 QQ 号' } },
      required: ['user_id'],
    },
  },
  {
    name: 'set_whole_ban',
    description: '开启或关闭全员禁言（仅群聊）。',
    parameters: {
      type: 'object',
      properties: { enable: { type: 'boolean', description: 'true 开启全员禁言，false 解除' } },
      required: ['enable'],
    },
  },
  {
    name: 'recall_message',
    description: '撤回一条消息。不给 message_id 就撤回当前这条消息。',
    parameters: {
      type: 'object',
      properties: { message_id: { type: 'string', description: '要撤回的消息 ID，省略表示当前消息' } },
      required: [],
    },
  },
  {
    name: 'get_muted_list',
    description: '查看本群当前被禁言的成员名单（仅群聊）。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_favor',
    description: '把某个 QQ 的好感度直接设置为指定值（-100 到 100）。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '目标 QQ 号' },
        score: { type: 'number', description: '要设置的好感度数值，-100 到 100' },
      },
      required: ['user_id', 'score'],
    },
  },
  {
    name: 'add_favor',
    description: '给某个 QQ 的好感度加减分（-100 到 100 之间增减）。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '目标 QQ 号' },
        delta: { type: 'number', description: '增减分数，正数加分、负数扣分' },
      },
      required: ['user_id', 'delta'],
    },
  },
  {
    name: 'clear_memory',
    description: '清理记忆。scope=session 只清当前会话，scope=all 清空全部会话（只有老大可以）。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'all'], description: '清理范围，默认 session' },
      },
      required: [],
    },
  },
  {
    name: 'search_history',
    description: '按关键词搜索本群/本会话的历史消息，按时间倒序返回。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜索的关键词' },
        limit: { type: 'number', description: '最多返回几条，默认 5，最多 20' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'get_member_info',
    description: '查询群成员的资料：昵称、群名片、身份、入群时间等（仅群聊）。',
    parameters: {
      type: 'object',
      properties: { user_id: { type: 'string', description: '要查询的 QQ 号' } },
      required: ['user_id'],
    },
  },
  {
    name: 'list_ignore',
    description: '查看当前被标记为「不想理」的人，以及各自还剩多久自动解除。老大问"你不理谁了""黑名单还有谁"时调用。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'favor_rank',
    description: '查好感度排行榜。群聊里只排本群成员（已经退群的不会出现），私聊里排全部记录。想知道谁最讨你喜欢、给谁排个名次就调它。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '要几个，默认 10，最多 50' },
        order: { type: 'string', description: 'desc 从高到低（默认），asc 从低到高' },
      },
      required: [],
    },
  },
];

/** 场景裁剪：私聊里不给群管工具；是否有权限由 handler 判定，好让模型收到人话提示 */
const GROUP_ONLY = new Set(['ban_member', 'unban_member', 'set_whole_ban', 'get_muted_list', 'get_member_info']);

export function toolDefsFor(ctx: ToolContext): ToolDef[] {
  if (isGroup(ctx)) return TOOL_DEFS;
  return TOOL_DEFS.filter((d) => !GROUP_ONLY.has(d.name));
}

// ---------- 各工具实现（全部返回 ToolResult，绝不抛错） ----------

type Handler = (ctx: ToolContext, args: Args) => Promise<ToolResult>;

const handlers: Record<string, Handler> = {
  async ban_member(ctx, args) {
    if (!hasAdmin(ctx)) return fail('这个操作需要管理员身份');
    const target = asStr(args.user_id) ?? ctx.msg.senderId;
    if (!target) return fail('我不知道该禁言谁。');
    if (!isQq(target)) return fail(`QQ 号 ${target} 看起来不对，没执行。`);
    const blocked = protectedTarget(ctx, target);
    if (blocked) return fail(blocked);
    const sec = clampInt(asNum(args.duration_sec) ?? DEFAULT_BAN_SEC, 0, MAX_BAN_SEC);
    await ctx.client.setGroupBan(ctx.msg.targetId, target, sec);
    ctx.note(`禁言 ${target} ${sec}s`);
    if (sec === 0) return ok(`已解除 ${target} 的禁言。`);
    return ok(sec >= 60 ? `已禁言 ${target}，${sec} 秒（约 ${Math.round(sec / 60)} 分钟）。` : `已禁言 ${target}，${sec} 秒。`);
  },

  async unban_member(ctx, args) {
    if (!hasAdmin(ctx)) return fail('这个操作需要管理员身份');
    const target = asStr(args.user_id);
    if (!target) return fail('没告诉我要解禁谁。');
    if (!isQq(target)) return fail(`QQ 号 ${target} 看起来不对，没执行。`);
    await ctx.client.setGroupBan(ctx.msg.targetId, target, 0);
    ctx.note(`解禁 ${target}`);
    return ok(`已解除 ${target} 的禁言。`);
  },

  async set_whole_ban(ctx, args) {
    if (!hasAdmin(ctx)) return fail('这个操作需要管理员身份');
    const enable = asBool(args.enable);
    if (enable === undefined) return fail('没告诉我是开启还是解除全员禁言。');
    await ctx.client.setGroupWholeBan(ctx.msg.targetId, enable);
    ctx.note(`全员禁言 ${enable ? '开' : '关'}`);
    return ok(enable ? '已开启全员禁言。' : '已解除全员禁言。');
  },

  async recall_message(ctx, args) {
    // 群里的消息要管理员才能撤回；私聊里撤自己的消息不设门槛
    if (isGroup(ctx) && !hasAdmin(ctx)) return fail('这个操作需要管理员身份');
    const mid = asStr(args.message_id) ?? ctx.msg.messageId;
    if (!mid) return fail('没有可撤回的消息 ID。');
    await ctx.client.deleteMsg(mid);
    ctx.note(`撤回消息 ${mid}`);
    return ok(`已撤回消息 ${mid}。`);
  },

  async get_muted_list(ctx) {
    if (!isGroup(ctx)) return fail('这个操作需要管理员身份');
    const list = await ctx.client.getMutedList(ctx.msg.targetId);
    if (list.length === 0) return ok('现在没人被禁言。');
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = list.map((m) => {
      const leftMin = Math.max(0, Math.ceil((m.until - nowSec) / 60));
      const left = leftMin >= 60 ? `${Math.floor(leftMin / 60)} 小时 ${leftMin % 60} 分` : `${leftMin} 分钟`;
      return `${m.name || m.userId}（${m.userId}）还剩 ${left}`;
    });
    return ok(`当前被禁言的成员 ${list.length} 人：\n${lines.join('\n')}`);
  },

  async set_favor(ctx, args) {
    return changeFavor(ctx, args, 'set');
  },

  async add_favor(ctx, args) {
    return changeFavor(ctx, args, 'add');
  },

  async clear_memory(ctx, args) {
    const scope = asStr(args.scope) ?? 'session';
    if (scope !== 'session' && scope !== 'all') return fail('scope 只能是 session 或 all。');
    if (scope === 'all') {
      if (!ctx.isMaster) return fail('清空全部记忆只有老大能做。');
      const r = ctx.db.prepare('DELETE FROM messages').run();
      ctx.note('清空全部会话记忆');
      return ok(`已清空全部会话记忆，删掉 ${Number(r.changes ?? 0)} 条消息。`);
    }
    const r = ctx.db.prepare('DELETE FROM messages WHERE session_key = ?').run(ctx.session.key);
    ctx.note(`清空会话记忆 ${ctx.session.key}`);
    return ok(`已清空本会话记忆，删掉 ${Number(r.changes ?? 0)} 条消息。`);
  },

  async search_history(ctx, args) {
    const kw = asStr(args.keyword);
    if (!kw) return fail('没告诉我要搜什么。');
    const limit = clampInt(asNum(args.limit) ?? 5, 1, 20);
    const rows = ctx.db.prepare(`
      SELECT role, sender_name, sender_id, content, created_at
      FROM messages WHERE session_key = ? AND content LIKE ?
      ORDER BY id DESC LIMIT ?
    `).all(ctx.session.key, `%${kw}%`, limit) as Array<Record<string, unknown>>;
    if (rows.length === 0) return ok(`没找到跟「${kw}」有关的历史消息。`);
    const lines = rows.map((r) => {
      const raw = Number(r.created_at ?? 0);
      const ms = raw > 1e12 ? raw : raw * 1000;
      const who = String(r.role) === 'assistant' ? '我' : String(r.sender_name || r.sender_id || '某人');
      const txt = String(r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return `[${fmtTime(ms)}] ${who}：${txt}`;
    });
    return ok(`找到 ${rows.length} 条跟「${kw}」有关：\n${lines.join('\n')}`);
  },

  async list_ignore(ctx) {
    if (!ctx.isMaster) return fail('这份名单只有老大能看。');
    const rows = listIgnores(ctx.db);
    if (!rows.length) return ok('现在没有不理任何人，谁都能找我说话。');
    const lines = rows.map((r, i) => {
      const row = ctx.db.prepare('SELECT sender_name FROM messages WHERE sender_id = ? ORDER BY id DESC LIMIT 1').get(r.qq) as { sender_name?: string } | undefined;
      const nick = String(row?.sender_name ?? '').trim();
      const who = nick ? `${nick}(${r.qq})` : r.qq;
      const where = r.sessionKey.startsWith('p:') ? '私聊' : '群';
      const left = r.forever ? '永久' : `还剩 ${humanRemain(r.remainSec)}`;
      return `${i + 1}. ${who} — ${where} ${r.sessionKey.replace(/^[gp]:/, '')}，${left}（累计第 ${r.times} 次）`;
    });
    return ok(`现在不理这些人（到点自动解除）：\n${lines.join('\n')}`);
  },

  async favor_rank(ctx, args) {
    const limit = clampInt(asNum(args.limit) ?? 10, 1, 50);
    const asc = String(asStr(args.order) ?? 'desc').toLowerCase() === 'asc';
    const isGroup = ctx.msg.type === 'group';

    // 群聊：先拿成员名单，只要在群里的
    let members: Map<string, string> | null = null;
    if (isGroup) {
      try {
        const list = await ctx.client.getGroupMemberList(ctx.msg.targetId);
        members = new Map();
        for (const m of list) {
          const uid = String((m as Record<string, unknown>).user_id ?? '');
          if (!uid) continue;
          const card = String((m as Record<string, unknown>).card ?? '').trim();
          const nick = String((m as Record<string, unknown>).nickname ?? '').trim();
          members.set(uid, card || nick || uid);
        }
      } catch {
        members = null;   // 拿不到名单就退回全量，但会在文案里说明
      }
    }

    const rows = ctx.db.prepare(
      `SELECT qq, score FROM favor ORDER BY score ${asc ? 'ASC' : 'DESC'} LIMIT 500`,
    ).all() as Array<{ qq: string; score: number }>;

    const picked: Array<{ qq: string; score: number; name: string }> = [];
    for (const r of rows) {
      const qq = String(r.qq);
      if (members && !members.has(qq)) continue;   // 不在本群的人不出现
      picked.push({ qq, score: Number(r.score), name: members?.get(qq) ?? '' });
      if (picked.length >= limit) break;
    }
    if (!picked.length) {
      return ok(isGroup ? '这个群里还没有任何好感度记录。' : '还没有任何好感度记录。');
    }
    const lines = picked.map((p, i) => {
      const who = p.name ? `${p.name}(${p.qq})` : p.qq;
      return `${i + 1}. ${who} — ${p.score} 分`;
    });
    const scope = isGroup
      ? (members ? `本群（${members.size} 人）范围内` : '本群范围内（成员名单没取到，可能含已退群的人）')
      : '全部记录';
    ctx.note(`好感排行 ${picked.length} 条`);
    return ok(`${scope}好感度排行（${asc ? '从低到高' : '从高到低'}）：\n${lines.join('\n')}`);
  },

  async get_member_info(ctx, args) {
    if (!isGroup(ctx)) return fail('这个操作需要管理员身份');
    const target = asStr(args.user_id);
    if (!target) return fail('没告诉我要查谁。');
    if (!isQq(target)) return fail(`QQ 号 ${target} 看起来不对，没执行。`);
    const members = await ctx.client.getGroupMemberList(ctx.msg.targetId);
    const m = members.find((x) => String(x.user_id ?? '') === target);
    if (!m) return ok(`群成员里没找到 QQ ${target}，可能已经退群了。`);
    const roleMap: Record<string, string> = { owner: '群主', admin: '管理员', member: '群成员' };
    const secDate = (v: unknown): string => {
      const sec = Number(v ?? 0);
      return sec > 0 ? fmtTime(sec * 1000).slice(0, 10) : '不知道';
    };
    const shut = Number(m.shut_up_timestamp ?? 0);
    const muted = shut > Math.floor(Date.now() / 1000) ? `禁言中，到 ${fmtTime(shut * 1000)}` : '没被禁言';
    const favor = readFavorRow(ctx.db, target).score;
    return ok([
      `QQ ${target}：`,
      `昵称：${String(m.nickname ?? '不知道')}`,
      `群名片：${String(m.card ?? '') || '（没设）'}`,
      `身份：${roleMap[String(m.role ?? 'member')] ?? '群成员'}`,
      `入群：${secDate(m.join_time)}`,
      `最后发言：${secDate(m.last_sent_time)}`,
      `状态：${muted}`,
      `好感度：${favor}`,
    ].join('\n'));
  },
};

/** 工具调度：未知工具、参数错误、接口异常都在这里兜成人话 */
export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const handler = handlers[call.name];
  if (!handler) return fail(`我不认识这个工具：${call.name}`);
  try {
    return await handler(ctx, call.args ?? {});
  } catch (err) {
    log.warn(`工具 ${call.name} 失败：${String(err)}`);
    return fail(humanError(err));
  }
}
