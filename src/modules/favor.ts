// 好感度：十档关系、每日加分封顶、扣分不限；老大永久锁定在最高档。
import type { DB } from '../core/db.ts';
import type { FavorChange, FavorLevel, FavorState } from '../core/types.ts';
import { clamp, todayStr } from '../core/util.ts';
import { MASTER_QQS } from '../core/config.ts';
import { makeLogger } from '../core/logger.ts';

const log = makeLogger('favor');

/** 分数开口区间：上下限只给面板画图用，不参与判定 */
const LOW = -999999;
const HIGH = 999999;

/**
 * 十档关系，index 0 最差、9 最好。
 * 阈值照老版 V9.8.5 原样搬：≤-500 / -499..-300 / -299..-150 / -149..-50 / -49..-1 /
 * 0..49 / 50..149 / 150..299 / 300..499 / ≥500
 */
export const LEVELS: FavorLevel[] = [
  { index: 0, name: '极恶宿敌', min: LOW, max: -500 },
  { index: 1, name: '深恶痛绝', min: -499, max: -300 },
  { index: 2, name: '厌烦嫌弃', min: -299, max: -150 },
  { index: 3, name: '冷淡防备', min: -149, max: -50 },
  { index: 4, name: '生疏克制', min: -49, max: -1 },
  { index: 5, name: '初识客套', min: 0, max: 49 },
  { index: 6, name: '友善熟络', min: 50, max: 149 },
  { index: 7, name: '信赖好友', min: 150, max: 299 },
  { index: 8, name: '深厚挚友', min: 300, max: 499 },
  { index: 9, name: '特等贵客', min: 500, max: HIGH },
];

/** 老大的档位：同样在 9 级，但名字要标出至高主权 */
const MASTER_LEVEL: FavorLevel = { index: 9, name: '至高主权', min: 500, max: HIGH };
const MASTER_SCORE = 999;

/** 给系统提示词用的口味说明，和 LEVELS 一一对应，措辞照老版十阶表 */
const HINTS = [
  '，彻底视为害虫，全天候冷酷审判、无情贬损，日常完全无视。',
  '，极度鄙夷，极大概率直接拒绝搭理，说话极具攻击性。',
  '，毒舌、阴阳怪气、直接反驳甚至言语警告。',
  '，回复极少（如“哦”“没空”），明显拉开距离，抗拒互动。',
  '，态度收敛，语言精简严肃，去掉可爱语气词，公事公办。',
  '，标准礼貌，保持安全距离，客气周到但不主动开私密玩笑。',
  '，语气温和可爱，带点轻松口语，不抗拒闲聊。',
  '，完全放下防备，言谈坦诚自然，会主动接梗、吐槽、主动关照。',
  '，高度偏爱，互动极其随和亲昵，包容玩笑，愿意帮腔解围。',
  '，群友里的天花板待遇，除了老大之外最重视最信赖的人，极度温柔偏袒；但永远守住本分，老大的命令绝对优先。',
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
  /** 单次最多变动多少分（默认 5；老大亲自下令时放宽） */
  maxStep?: number;
  /** 不占每日额度（老大亲自下令时用：他加的分不该把对方今天的额度吃掉） */
  noQuota?: boolean;
  now?: number;
}): FavorChange | null {
  const id = normQq(qq);
  if (opts.isMaster || !id) return null;

  const step = Math.max(1, Math.floor(num(opts.maxStep) || 5));
  const d = clamp(Math.round(num(delta)), -step, step);
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
    if (opts.noQuota) {
      // 老大下令：直接加，不占额度、不封顶
      after = before + d;
    } else {
      const room = Math.max(0, cap - gainToday);
      const add = Math.min(d, room);
      after = before + add;
      gain = gainToday + add;
      capped = add < d;
    }
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
  // 写死的两个号永远在榜单顶部，配置删不掉
  for (const raw of [...MASTER_QQS, ...(masterIds ?? [])]) {
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
