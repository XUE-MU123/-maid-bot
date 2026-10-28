// 会话仓库：群/私聊的开关、专属提示词、触发概率都存这儿。
import type { DB } from '../core/db.ts';
import type { Config, Session } from '../core/types.ts';

type Row = Record<string, unknown>;

function str(v: unknown, d = ''): string { return v === null || v === undefined ? d : String(v); }
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }
function bool(v: unknown, d = false): boolean {
  if (v === null || v === undefined) return d;
  return Number(v) !== 0;
}

export function rowToSession(r: Row): Session {
  return {
    key: str(r.key),
    type: str(r.type) === 'group' ? 'group' : 'private',
    targetId: str(r.target_id),
    name: str(r.name),
    enabled: bool(r.enabled, true),
    prompt: str(r.prompt),
    memoryShared: bool(r.memory_shared, false),
    atProb: num(r.at_prob, 1),
    keywordProb: num(r.keyword_prob, 1),
    keywords: str(r.keywords),
    randomProb: num(r.random_prob, 0),
    proactiveEnabled: bool(r.proactive_enabled, false),
    proactiveMinMinutes: num(r.proactive_min_min, 30),
    proactiveMaxMinutes: num(r.proactive_max_min, 90),
    proactiveMaxRounds: num(r.proactive_max_rounds, 2),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

export function getSession(db: DB, key: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as Row | undefined;
  return row ? rowToSession(row) : null;
}

/** 第一次见到这个群/好友时按默认值建档 */
export function ensureSession(
  db: DB,
  key: string,
  type: 'group' | 'private',
  targetId: string,
  name: string,
  defaults: Config['defaults'],
): Session {
  const exist = getSession(db, key);
  if (exist) {
    if (name && exist.name !== name) {
      db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE key = ?').run(name, Date.now(), key);
      return { ...exist, name };
    }
    return exist;
  }
  const t = Date.now();
  db.prepare(`
    INSERT INTO sessions (key, type, target_id, name, enabled, prompt, memory_shared,
      at_prob, keyword_prob, keywords, random_prob, proactive_enabled, proactive_min_min, proactive_max_min,
      proactive_max_rounds, created_at, updated_at)
    VALUES (?,?,?,?,1,'',0,?,?,'',?,0,30,90,2,?,?)
  `).run(key, type, targetId, name, defaults.atProb, defaults.keywordProb, defaults.randomProb, t, t);
  return getSession(db, key) as Session;
}

export function listSessions(db: DB): Session[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Row[];
  return rows.map(rowToSession);
}

const PATCHABLE: Array<[string, string]> = [
  ['name', 'name'],
  ['enabled', 'enabled'],
  ['prompt', 'prompt'],
  ['memoryShared', 'memory_shared'],
  ['atProb', 'at_prob'],
  ['keywordProb', 'keyword_prob'],
  ['keywords', 'keywords'],
  ['randomProb', 'random_prob'],
  ['proactiveEnabled', 'proactive_enabled'],
  ['proactiveMinMinutes', 'proactive_min_min'],
  ['proactiveMaxMinutes', 'proactive_max_min'],
  ['proactiveMaxRounds', 'proactive_max_rounds'],
];

export function updateSession(db: DB, key: string, patch: Partial<Session>): Session | null {
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  for (const [field, col] of PATCHABLE) {
    if (!(field in patch)) continue;
    const v = (patch as unknown as Record<string, unknown>)[field];
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? v : String(v));
  }
  if (sets.length === 0) return getSession(db, key);
  sets.push('updated_at = ?');
  vals.push(Date.now());
  vals.push(key);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE key = ?`).run(...vals);
  return getSession(db, key);
}

export function deleteSession(db: DB, key: string): void {
  db.prepare('DELETE FROM sessions WHERE key = ?').run(key);
}
