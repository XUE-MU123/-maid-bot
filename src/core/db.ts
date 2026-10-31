// 数据库层：node:sqlite（Node 24 自带，零依赖），一张 db 文件搞定。
// 表结构是三个模块的共享契约，改动前先在群里喊一声。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export type DB = DatabaseSync;

export function openDb(dataDir: string): DB {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'maid.db');
  let db: DatabaseSync;
  try {
    db = openAndPrepare(dbPath);
  } catch {
    // 数据文件坏了（被截断、不是 sqlite、磁盘错误）：挪走留档，重建空库，绝不卡住启动
    const bad = dbPath + '.corrupt-' + Date.now();
    try { renameSync(dbPath, bad); } catch { /* 忽略 */ }
    for (const ext of ['-wal', '-shm']) {
      try { renameSync(dbPath + ext, bad + ext); } catch { /* 文件不存在就算了 */ }
    }
    db = openAndPrepare(dbPath);
  }
  migrate(db);
  return db;
}

function openAndPrepare(path: string): DatabaseSync {
  const d = new DatabaseSync(path);
  // sqlite 是懒打开的，坏文件要到第一次操作才报错，所以这里必须真的碰一下
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA synchronous = NORMAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  d.prepare('SELECT 1').get();
  return d;
}

/** 给老库补列：已经存在就跳过，不会报错 */
function addColumnIfMissing(db: DB, table: string, column: string, ddl: string): void {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (cols.some((c) => String(c.name) === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
  } catch {
    /* 加不上就算了，读取时走默认值 */
  }
}

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      key                 TEXT PRIMARY KEY,
      type                TEXT NOT NULL CHECK(type IN ('group','private')),
      target_id           TEXT NOT NULL,
      name                TEXT NOT NULL DEFAULT '',
      enabled             INTEGER NOT NULL DEFAULT 1,
      prompt              TEXT NOT NULL DEFAULT '',
      memory_shared       INTEGER NOT NULL DEFAULT 0,
      at_prob             REAL NOT NULL DEFAULT 1.0,
      keyword_prob        REAL NOT NULL DEFAULT 1.0,
      random_prob         REAL NOT NULL DEFAULT 0,
      proactive_enabled   INTEGER NOT NULL DEFAULT 0,
      proactive_min_min   INTEGER NOT NULL DEFAULT 30,
      proactive_max_min   INTEGER NOT NULL DEFAULT 90,
      proactive_max_rounds INTEGER NOT NULL DEFAULT 2,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content     TEXT NOT NULL,
      sender_id   TEXT,
      sender_name TEXT,
      msg_id      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_key, id);
    CREATE INDEX IF NOT EXISTS idx_msg_created ON messages(created_at);
    -- 不理名单：保留每一次记录，times 只增不减；until=0 表示当前没在生效
    CREATE TABLE IF NOT EXISTS ignore_state (
      session_key TEXT NOT NULL,
      qq          TEXT NOT NULL,
      times       INTEGER NOT NULL DEFAULT 0,
      until       INTEGER NOT NULL DEFAULT 0,
      last_at     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_key, qq)
    );
    CREATE TABLE IF NOT EXISTS favor (
      qq          TEXT PRIMARY KEY,
      score       INTEGER NOT NULL DEFAULT 0,
      daily_gain  INTEGER NOT NULL DEFAULT 0,
      day         TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favor_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      qq          TEXT NOT NULL,
      session_key TEXT NOT NULL,
      delta       INTEGER NOT NULL,
      before      INTEGER NOT NULL,
      after       INTEGER NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      fingerprint TEXT PRIMARY KEY,
      url         TEXT NOT NULL DEFAULT '',
      file_name   TEXT NOT NULL DEFAULT '',
      msg_id      TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL DEFAULT '',
      sender_id   TEXT NOT NULL DEFAULT '',
      desc        TEXT NOT NULL DEFAULT '',
      desc_at     INTEGER NOT NULL DEFAULT 0,
      seen_count  INTEGER NOT NULL DEFAULT 1,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_key, last_seen);

    CREATE TABLE IF NOT EXISTS token_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      model       TEXT NOT NULL,
      prompt_tok  INTEGER NOT NULL DEFAULT 0,
      complet_tok INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      level       TEXT NOT NULL DEFAULT 'info',
      scope       TEXT NOT NULL DEFAULT '',
      message     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(db, 'sessions', 'keywords', "keywords TEXT NOT NULL DEFAULT ''");
  // 身份三件套：群身份、群头衔、会话标记。老库补列，读取时空值当没有
  addColumnIfMissing(db, 'messages', 'sender_role', 'sender_role TEXT');
  addColumnIfMissing(db, 'messages', 'sender_title', 'sender_title TEXT');
  addColumnIfMissing(db, 'messages', 'dialog_tag', 'dialog_tag TEXT');
}

export function now(): number { return Date.now(); }

/** 读一条 key-value（meta 表），没有就返回 null */
export function getMeta(db: DB, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined;
    return row && row.value !== undefined ? String(row.value) : null;
  } catch {
    return null;
  }
}

/** 写一条 key-value，空值就当删除 */
export function setMeta(db: DB, key: string, value: string | null): void {
  try {
    if (value === null) {
      db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      return;
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  } catch {
    /* meta 只是辅助，写不进不影响主流程 */
  }
}
