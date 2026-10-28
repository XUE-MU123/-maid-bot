// 好感度：十档关系、每日加分封顶、扣分不限；老大永久锁定在最高档。
import type { DB } from '../core/db.ts';
import type { FavorChange, FavorLevel, FavorState } from '../core/types.ts';
import { clamp, todayStr } from '../core/util.ts';
import { makeLogger } from '../core/logger.ts';

const log = makeLogger('favor');

/** 分数开口区间：上下限只给面板画图用，不参与判定 */
const LOW = -999999;
const HIGH = 999999;

/**
 * 十档关系，index 0 最差、9 最好。
 * 区间：≤-101 / -100..-61 / -60..-31 / -30..-11 / -10..0 / 1..20 / 21..60 / 61..120 / 121..200 / ≥201
 */
export const LEVELS: FavorLevel[] = [
  { index: 0, name: '极恶宿敌', min: LOW, max: -101 },
  { index: 1, name: '深恶痛绝', min: -100, max: -61 },
  { index: 2, name: '厌烦嫌弃', min: -60, max: -31 },
  { index: 3, name: '冷淡防备', min: -30, max: -11 },
  { index: 4, name: '生疏克制', min: -10, max: 0 },
  { index: 5, name: '初识客套', min: 1, max: 20 },
  { index: 6, name: '友善熟络', min: 21, max: 60 },
  { index: 7, name: '信赖好友', min: 61, max: 120 },
  { index: 8, name: '深厚挚友', min: 121, max: 200 },
  { index: 9, name: '特等贵客', min: 201, max: HIGH },
];

/** 老大的档位：同样在 9 级，但名字要标出至高主权 */
const MASTER_LEVEL: FavorLevel = { index: 9, name: '至高主权', min: 201, max: HIGH };
const MASTER_SCORE = 999;

/** 给系统提示词用的口味说明，和 LEVELS 一一对应 */
const HINTS = [
  '，已经彻底撕破脸，只做最低限度回应，能不接就不接。',
  '，极其反感，回复冷淡简短，别主动搭话。',
  '，看着就烦，能敷衍就敷衍，不要顺着对方聊。',
  '，保持距离，客气但疏离，不主动分享任何事。',
  '，刚认识，礼貌克制，不冷不热。',
  '，还算客气的点头之交，正常聊天即可。',
  '，聊得来的熟人，可以开玩笑、多说两句。',
  '，信得过的好友，语气亲近，愿意主动关心。',
  '，交情很深的挚友，可以掏心窝子说话。',
  '，最亲近的贵客，热情周到，事事上心。',
];

interface FavorRow {
  qq: string;
  score: number;
  dailyGain: number;
  day: string;
  updatedAt: number;
}

type Row = Record<string, unknown>;

function str(v: unknown, d = ''): string { return v === null || v === undefined ? d : String(v); }
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
function normQq(qq: unknown): string { return String(qq ?? '').trim(); }

/** 按分数取档位；区间首尾相接，落在哪个档就是哪个档 */
export function levelAt(score: number): FavorLevel {
  const s = Math.trunc(Number.isFinite(Number(score)) ? Number(score) : 0);
  if (s <= LEVELS[0].max) return LEVELS[0];
  for (let i = 1; i < LEVELS.length; i++) {
    if (s <= LEVELS[i].max) return LEVELS[i];
  }
  return LEVELS[LEVELS.length - 1];
}

function readRow(db: DB, qq: string): FavorRow | null {
  const r = db.prepare('SELECT qq, score, daily_gain, day, updated_at FROM favor WHERE qq = ?').get(qq) as Row | undefined;
  if (!r) return null;
  return {
    qq: str(r.qq),
    score: num(r.score),
    dailyGain: num(r.daily_gain),
    day: str(r.day),
    updatedAt: num(r.updated_at),
  };
}

function masterState(qq: string): FavorState {
  return {
    qq,
    score: MASTER_SCORE,
    levelIndex: MASTER_LEVEL.index,
    levelName: MASTER_LEVEL.name,
    isMaster: true,
    dailyGain: 0,
    updatedAt: 0,
  };
}

/** 取某人当前好感；老大恒为 9 级，且不读库、不落库 */
export function getFavor(db: DB, qq: string, isMaster: boolean): FavorState {
  const id = normQq(qq);
  if (isMaster) return masterState(id);
  const row = id ? readRow(db, id) : null;
  if (!row) {
    const lv = levelAt(0);
    return { qq: id, score: 0, levelIndex: lv.index, levelName: lv.name, isMaster: false, dailyGain: 0, updatedAt: 0 };
  }
  const lv = levelAt(row.score);
  return {
    qq: id,
    score: row.score,
    levelIndex: lv.index,
    levelName: lv.name,
    isMaster: false,
    dailyGain: row.day === todayStr() ? row.dailyGain : 0,
    updatedAt: row.updatedAt,
  };
}

/**
 * 按模型打分调整好感。
 * - 老大直接返回 null（不记分）；
 * - delta 夹在 -5..5；
 * - 当天净加分不超过 dailyGainCap（扣分不受限，且不回补当天已用额度以外的东西）；
 * - 实际有变化才写 favor_log。
 */
export function applyDelta(db: DB, qq: string, delta: number, opts: {
  sessionKey: string;
  reason?: string;
  dailyGainCap: number;
  isMaster: boolean;
  now?: number;
}): FavorChange | null {
  const id = normQq(qq);
  if (opts.isMaster || !id) return null;

  const d = clamp(Math.round(num(delta)), -5, 5);
  if (d === 0) return null;

  const nowMs = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const day = todayStr(new Date(nowMs));
  const cap = Math.max(0, Math.floor(num(opts.dailyGainCap)));

  const row = readRow(db, id);
  const before = row ? row.score : 0;
  // 跨天则当天额度归零
  const gainToday = row && row.day === day ? row.dailyGain : 0;

  let after = before;
  let gain = gainToday;
  let capped = false;
  if (d > 0) {
    const room = Math.max(0, cap - gainToday);
    const add = Math.min(d, room);
    after = before + add;
    gain = gainToday + add;
    capped = add < d;
  } else {
    after = before + d; // 扣分不限
  }
  after = clamp(after, LOW, HIGH);
  const applied = after - before;

  db.prepare(`
    INSERT INTO favor (qq, score, daily_gain, day, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(qq) DO UPDATE SET score = excluded.score, daily_gain = excluded.daily_gain,
      day = excluded.day, updated_at = excluded.updated_at
  `).run(id, after, gain, day, nowMs);

  if (applied !== 0) {
    db.prepare(`
      INSERT INTO favor_log (qq, session_key, delta, before, after, reason, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, opts.sessionKey ?? '', applied, before, after, opts.reason ?? '', nowMs);
    log.debug(`好感 ${id}：${before} → ${after}（${applied > 0 ? '+' : ''}${applied}）${capped ? ' 已封顶' : ''}`);
  }

  return { qq: id, before, after, delta: applied, levelName: levelAt(after).name, capped };
}

/** 面板手动改分：不封顶、可扣到负数，写一条 favor_log 留痕 */
export function setScore(db: DB, qq: string, score: number, opts?: { sessionKey?: string; reason?: string }): FavorChange {
  const id = normQq(qq);
  const target = clamp(Math.round(num(score)), LOW, HIGH);
  if (!id) {
    // 空号不改库，返回零变更让调用方自己提示
    return { qq: '', before: 0, after: 0, delta: 0, levelName: levelAt(0).name, capped: false };
  }

  const nowMs = Date.now();
  const day = todayStr();
  const row = readRow(db, id);
  const before = row ? row.score : 0;
  const gain = row && row.day === day ? row.dailyGain : 0;
  const applied = target - before;

  db.prepare(`
    INSERT INTO favor (qq, score, daily_gain, day, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(qq) DO UPDATE SET score = excluded.score, daily_gain = excluded.daily_gain,
      day = excluded.day, updated_at = excluded.updated_at
  `).run(id, target, gain, day, nowMs);

  if (applied !== 0) {
    db.prepare(`
      INSERT INTO favor_log (qq, session_key, delta, before, after, reason, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(id, opts?.sessionKey ?? '', applied, before, target, opts?.reason ?? '面板调整', nowMs);
  }
  log.info(`手动设置好感 ${id}：${before} → ${target}`);

  return { qq: id, before, after: target, delta: applied, levelName: levelAt(target).name, capped: false };
}

/** 榜单：老大置顶（锁定状态），其余按分数从高到低 */
export function listFavors(db: DB, limit: number, masterIds: string[]): FavorState[] {
  const n = Math.floor(num(limit));
  if (!Number.isFinite(n) || n <= 0) return [];

  const masters: string[] = [];
  const seen = new Set<string>();
  for (const raw of masterIds ?? []) {
    const id = normQq(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    masters.push(id);
  }

  const rows = db.prepare(`
    SELECT qq, score, daily_gain, day, updated_at FROM favor
    ORDER BY score DESC, updated_at DESC, qq ASC
  `).all() as Row[];

  const day = todayStr();
  const rest: FavorState[] = [];
  for (const r of rows) {
    const id = str(r.qq);
    if (!id || seen.has(id)) continue;
    const score = num(r.score);
    const lv = levelAt(score);
    rest.push({
      qq: id,
      score,
      levelIndex: lv.index,
      levelName: lv.name,
      isMaster: false,
      dailyGain: str(r.day) === day ? num(r.daily_gain) : 0,
      updatedAt: num(r.updated_at),
    });
  }
  return [...masters.map(masterState), ...rest].slice(0, n);
}

/** 给系统提示词的一行中文；qq 为空返回空串，调用方再判断 */
export function favorLine(db: DB, qq: string, isMaster: boolean): string {
  const id = normQq(qq);
  if (!id) return '';
  if (isMaster) {
    return `老大（QQ ${id}）：至高主权，好感锁定为「${MASTER_LEVEL.name}」，永远尊重老大，合理要求优先照办。`;
  }
  const st = getFavor(db, id, false);
  return `你对 TA（QQ ${id}）的好感：${st.levelName}（第 ${st.levelIndex + 1}/10 档，${st.score} 分）${HINTS[st.levelIndex] ?? ''}`;
}
