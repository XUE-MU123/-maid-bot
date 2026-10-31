// 「不想理某人」名单：每人每次被标记都留一条记录，次数只增不减。
// 时长由框架按次数决定，AI 只负责说「不想理谁」，规则不发给它。
import type { DB } from '../core/db.ts';
import { getMeta, setMeta } from '../core/db.ts';
import { makeLogger } from '../core/logger.ts';

const log = makeLogger('ignore');

/** 永久拉黑的到期时间：9999 年 */
export const FOREVER = 253402300799000;

/**
 * 阶梯时长（毫秒）——第 1 次到第 6 次。
 * 老大定的标准：10 分钟 → 1 小时 → 半小时 → 6 小时 → 1 天 → 永久。
 * 这个表只在框架里用，**不写进提示词**。
 */
const LADDER_MS: number[] = [
  10 * 60_000,
  60 * 60_000,
  30 * 60_000,
  6 * 3600_000,
  24 * 3600_000,
  FOREVER,
];

export interface IgnoreEntry {
  sessionKey: string;
  qq: string;
  /** 累计被标记过几次 */
  times: number;
  /** 到期时间戳；0 表示当前没生效 */
  until: number;
  /** 还剩多少秒，负数表示已过期 */
  remainSec: number;
  /** 是不是永久 */
  forever: boolean;
  /** 本次判了多久（人话） */
  durationText: string;
  lastAt: number;
}

interface Row {
  session_key?: string;
  qq?: string;
  times?: number;
  until?: number;
  last_at?: number;
}

type Raw = Record<string, unknown>;

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function str(v: unknown, d = ''): string {
  return v === null || v === undefined ? d : String(v);
}

/** 把剩余秒数说成人话 */
export function humanRemain(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rm = m % 60;
    return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

/** 这一档要关多久（第 n 次） */
export function durationFor(times: number): number {
  const idx = Math.min(Math.max(times, 1), LADDER_MS.length) - 1;
  return LADDER_MS[idx];
}

/** 当前是不是在「不理」状态（过期的只标记失效，不删记录） */
export function isIgnored(db: DB, sessionKey: string, qq: string, now = Date.now()): boolean {
  if (!sessionKey || !qq) return false;
  try {
    const r = db.prepare('SELECT until FROM ignore_state WHERE session_key = ? AND qq = ?')
      .get(sessionKey, qq) as Raw | undefined;
    if (!r) return false;
    const until = num(r.until);
    return until > now;
  } catch {
    return false;
  }
}

/**
 * 记一次「不理」。次数 +1，时长按阶梯算。
 * 返回这次判了多久。
 */
export function markIgnore(db: DB, sessionKey: string, qq: string, who = '柚子'): { times: number; until: number; durationMs: number } | null {
  if (!sessionKey || !qq) return null;
  try {
    const row = db.prepare('SELECT times FROM ignore_state WHERE session_key = ? AND qq = ?')
      .get(sessionKey, qq) as Raw | undefined;
    const times = num(row?.times) + 1;
    const durationMs = durationFor(times);
    const until = durationMs >= FOREVER ? FOREVER : Date.now() + durationMs;
    db.prepare(`
      INSERT INTO ignore_state (session_key, qq, times, until, last_at) VALUES (?,?,?,?,?)
      ON CONFLICT(session_key, qq) DO UPDATE SET times = excluded.times, until = excluded.until, last_at = excluded.last_at
    `).run(sessionKey, qq, times, until, Date.now());
    const label = until >= FOREVER ? '永久拉黑' : humanRemain(durationMs / 1000);
    log.info(`${who} 第 ${times} 次标记不理 ${qq}（${sessionKey}）：${label}`);
    return { times, until, durationMs };
  } catch (err) {
    log.warn(`标记不理失败：${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

/** 手动解除：只把 until 归零，次数和历史都留着 */
export function releaseIgnore(db: DB, sessionKey: string, qq: string, who = '面板'): void {
  try {
    db.prepare('UPDATE ignore_state SET until = 0 WHERE session_key = ? AND qq = ?').run(sessionKey, qq);
    log.info(`${who} 解除不理 ${qq}（${sessionKey}），历史次数保留`);
  } catch {
    /* 忽略 */
  }
}

/** 当前生效的名单（过期的也会带出来，标记 expired） */
export function listIgnores(db: DB, now = Date.now()): IgnoreEntry[] {
  let rows: Row[] = [];
  try {
    rows = db.prepare('SELECT session_key, qq, times, until, last_at FROM ignore_state ORDER BY until DESC').all() as Row[];
  } catch {
    return [];
  }
  const out: IgnoreEntry[] = [];
  for (const r of rows) {
    const qq = str(r.qq);
    if (!/^\d{4,12}$/.test(qq)) continue;
    const until = num(r.until);
    const forever = until >= FOREVER;
    const remainSec = Math.round((until - now) / 1000);
    if (!forever && remainSec <= 0) continue;   // 已过期的先不显示，记录仍在表里
    out.push({
      sessionKey: str(r.session_key),
      qq,
      times: num(r.times),
      until,
      remainSec,
      forever,
      durationText: forever ? '永久' : humanRemain(remainSec),
      lastAt: num(r.last_at),
    });
  }
  return out.sort((a, b) => (b.forever ? 1 : 0) - (a.forever ? 1 : 0) || a.remainSec - b.remainSec);
}

/** 老数据搬家：以前存在 meta 里的 ignore:<会话>:<QQ> 迁到新表 */
export function migrateLegacyIgnores(db: DB): void {
  try {
    const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'ignore:%'").all() as Array<{ key?: string; value?: string }>;
    if (!rows.length) return;
    for (const r of rows) {
      const key = String(r.key ?? '');
      const idx = key.lastIndexOf(':');
      if (idx <= 'ignore:'.length) continue;
      const sessionKey = key.slice('ignore:'.length, idx);
      const qq = key.slice(idx + 1);
      const until = Number(r.value);
      if (!/^\d{4,12}$/.test(qq) || !Number.isFinite(until)) continue;
      db.prepare(`
        INSERT INTO ignore_state (session_key, qq, times, until, last_at) VALUES (?,?,?,?,?)
        ON CONFLICT(session_key, qq) DO UPDATE SET until = MAX(ignore_state.until, excluded.until)
      `).run(sessionKey, qq, 1, until, Date.now());
      setMeta(db, key, null);
    }
    log.info(`已把 ${rows.length} 条老的不理记录迁到新表`);
  } catch {
    /* 迁移失败不影响使用 */
  }
}
