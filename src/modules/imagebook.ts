// 图片仓库：收到图先登记（几乎零成本），真要看了才识别，识别结果缓存复用。
// 设计原则：登记不花钱，识别才花钱，同一张图只认一次。
import { createHash } from 'node:crypto';
import type { DB } from '../core/db.ts';
import { makeLogger } from '../core/logger.ts';

const log = makeLogger('imagebook');

export interface ImageRecord {
  fingerprint: string;
  url: string;
  fileName: string;
  msgId: string;
  sessionKey: string;
  senderId: string;
  desc: string;
  descAt: number;
  seenCount: number;
  firstSeen: number;
  lastSeen: number;
}

type Row = Record<string, unknown>;

function str(v: unknown, d = ''): string { return v === null || v === undefined ? d : String(v); }
function num(v: unknown, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

function rowToImage(r: Row): ImageRecord {
  return {
    fingerprint: str(r.fingerprint),
    url: str(r.url),
    fileName: str(r.file_name),
    msgId: str(r.msg_id),
    sessionKey: str(r.session_key),
    senderId: str(r.sender_id),
    desc: str(r.desc),
    descAt: num(r.desc_at),
    seenCount: num(r.seen_count, 1),
    firstSeen: num(r.first_seen),
    lastSeen: num(r.last_seen),
  };
}

/**
 * 图片指纹：QQ 转发同一张图时 URL 每次都会变（带 rkey/term 参数），
 * 但文件名一般会保留，所以优先用文件名，没有才退回 URL 路径。
 */
export function fingerprintOf(url: string, fileName = ''): string {
  const name = String(fileName || '').trim();
  let base = name;
  if (!base) {
    const noQuery = String(url || '').split('?')[0];
    base = noQuery.split('/').filter(Boolean).pop() || noQuery;
  }
  if (!base) return '';
  return createHash('sha1').update(base).digest('hex').slice(0, 24);
}

/** 登记一张图：已存在就只更新"最近一次出现"和次数，不碰描述 */
export function registerImage(db: DB, input: {
  url: string;
  fileName?: string;
  msgId: string;
  sessionKey: string;
  senderId: string;
}): ImageRecord | null {
  const fp = fingerprintOf(input.url, input.fileName);
  if (!fp) return null;
  const now = Date.now();
  const exist = db.prepare('SELECT * FROM images WHERE fingerprint = ?').get(fp) as Row | undefined;
  if (exist) {
    db.prepare(`
      UPDATE images SET url = ?, msg_id = ?, session_key = ?, sender_id = ?,
        seen_count = seen_count + 1, last_seen = ?
      WHERE fingerprint = ?
    `).run(input.url, input.msgId, input.sessionKey, input.senderId, now, fp);
  } else {
    db.prepare(`
      INSERT INTO images (fingerprint, url, file_name, msg_id, session_key, sender_id,
        desc, desc_at, seen_count, first_seen, last_seen)
      VALUES (?,?,?,?,?,?,'',0,1,?,?)
    `).run(fp, input.url, input.fileName ?? '', input.msgId, input.sessionKey, input.senderId, now, now);
  }
  return getImage(db, fp);
}

export function getImage(db: DB, fingerprint: string): ImageRecord | null {
  const row = db.prepare('SELECT * FROM images WHERE fingerprint = ?').get(fingerprint) as Row | undefined;
  return row ? rowToImage(row) : null;
}

/** 写回识别结果 */
export function saveDescription(db: DB, fingerprint: string, desc: string): void {
  db.prepare('UPDATE images SET desc = ?, desc_at = ? WHERE fingerprint = ?').run(desc, Date.now(), fingerprint);
  log.debug(`图片描述已缓存：${fingerprint.slice(0, 8)}（${desc.length} 字）`);
}

/** 这张图有没有可用的缓存描述 */
export function cachedDescription(db: DB, fingerprint: string): string {
  const row = db.prepare('SELECT desc FROM images WHERE fingerprint = ?').get(fingerprint) as Row | undefined;
  return row ? str(row.desc) : '';
}

/**
 * 找最近的一批图：优先同一个发送者（"我刚发的这张"），其次本会话所有人的。
 * 时间窗口默认 10 分钟，最多 4 张。
 */
export function recentImages(db: DB, opts: {
  sessionKey: string;
  senderId?: string;
  withinMs?: number;
  limit?: number;
}): ImageRecord[] {
  const within = Math.max(60_000, opts.withinMs ?? 10 * 60_000);
  const limit = Math.max(1, Math.min(4, opts.limit ?? 4));
  const since = Date.now() - within;

  if (opts.senderId) {
    const own = db.prepare(`
      SELECT * FROM images WHERE session_key = ? AND sender_id = ? AND last_seen >= ?
      ORDER BY last_seen DESC LIMIT ?
    `).all(opts.sessionKey, opts.senderId, since, limit) as Row[];
    if (own.length) return own.map(rowToImage);
  }
  const any = db.prepare(`
    SELECT * FROM images WHERE session_key = ? AND last_seen >= ?
    ORDER BY last_seen DESC LIMIT ?
  `).all(opts.sessionKey, since, limit) as Row[];
  return any.map(rowToImage);
}

/** 面板用：看看存了哪些图、哪些已经识过 */
export function listImages(db: DB, limit = 100): ImageRecord[] {
  const rows = db.prepare('SELECT * FROM images ORDER BY last_seen DESC LIMIT ?').all(limit) as Row[];
  return rows.map(rowToImage);
}
