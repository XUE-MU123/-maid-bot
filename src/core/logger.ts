// 统一日志：写控制台 + logs/bot.log，面板靠它展示运行状态。
import { appendFileSync, mkdirSync, existsSync, statfsSync, statSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: number = LEVELS.info;
let logFile: string | null = null;
let writeOk = true;
let logDir: string | null = null;
let keepDays = 14;
const MAX_LOG_BYTES = 20 * 1024 * 1024;

export function initLogger(dir: string, level: Level = 'info', keep = 14): void {
  logDir = dir;
  keepDays = keep > 0 ? keep : 14;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'bot.log');
    // 磁盘快满时降级为只打控制台，避免写满盘
    const st = statfsSync(dirname(logFile));
    const freeGb = (Number(st.bavail) * Number(st.bsize)) / 1024 ** 3;
    if (freeGb < 0.2) { logFile = null; }
  } catch { logFile = null; }
  minLevel = LEVELS[level] ?? LEVELS.info;
  startLogHousekeeping();
}

/** 定时收拾日志：超过 20MB 换新文件，超过保留天数的旧文件删掉 */
function startLogHousekeeping(): void {
  const tick = (): void => {
    try {
      if (!logFile || !logDir) return;
      if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
        renameSync(logFile, join(logDir, `bot-${Date.now()}.log`));
      }
      const cutoff = Date.now() - keepDays * 86400_000;
      for (const name of readdirSync(logDir)) {
        if (!name.startsWith('bot-') || !name.endsWith('.log')) continue;
        const full = join(logDir, name);
        try { if (statSync(full).mtimeMs < cutoff) unlinkSync(full); } catch { /* 忽略 */ }
      }
    } catch { /* 收拾失败不影响主流程 */ }
  };
  const timer = setInterval(tick, 3600_000);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
}

export function setLevel(level: Level): void { minLevel = LEVELS[level] ?? minLevel; }

const PAD = 5;
function fmt(ts: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${ts.getFullYear()}-${p(ts.getMonth() + 1)}-${p(ts.getDate())} ${p(ts.getHours())}:${p(ts.getMinutes())}:${p(ts.getSeconds())}.${p(ts.getMilliseconds(), 3)}`;
}

function emit(level: Level, scope: string, msg: string, style?: 'reply'): void {
  if (LEVELS[level] < minLevel) return;
  const line = `${fmt(new Date())} [${level.toUpperCase().padEnd(PAD)}] [${scope}] ${msg}`;
  const colored = style === 'reply' ? `\x1b[36m${line}\x1b[0m`
    : level === 'error' ? `\x1b[31m${line}\x1b[0m`
    : level === 'warn' ? `\x1b[33m${line}\x1b[0m`
    : level === 'debug' ? `\x1b[2m${line}\x1b[0m` : line;
  console.log(colored);
  if (logFile && writeOk) {
    try { appendFileSync(logFile, line + '\n'); } catch { writeOk = false; }
  }
}

export function makeLogger(scope: string) {
  return {
    debug: (m: string): void => emit('debug', scope, m),
    info: (m: string): void => emit('info', scope, m),
    warn: (m: string): void => emit('warn', scope, m),
    error: (m: string): void => emit('error', scope, m),
    /** 机器人说出去的话：单独一种颜色，日志里一眼能挑出来 */
    reply: (m: string): void => emit('info', scope, m, 'reply'),
  };
}
