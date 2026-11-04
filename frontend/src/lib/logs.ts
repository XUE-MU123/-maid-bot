import type { LogsData } from './types';

export const LOG_MEMORY_LIMIT = 1200;
export const LOG_DISPLAY_LIMIT = 800;
export const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'SUCCESS', 'WARN', 'ERROR'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export interface LogRow { id: string; time: string; level: LogLevel; module: string; message: string; raw: string }
export interface LogBuffer {
  rows: LogRow[];
  offset: number;
  fileSize: number;
  file: string | null;
  initialized: boolean;
  nextId: number;
}

export function createLogBuffer(nextId = 0): LogBuffer {
  return { rows: [], offset: 0, fileSize: 0, file: null, initialized: false, nextId };
}

/** Parsing is independent of React and never interprets messages as HTML. */
export function parseLogLine(raw: string, id: string): LogRow {
  const match = raw.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) \[(\w+)\s*\] \[([^\]]+)\] ?([\s\S]*)$/);
  const fallbackLevel = raw.match(/^\[(TRACE|DEBUG|INFO|SUCCESS|WARN|ERROR)\b/i)?.[1];
  const reported = (match?.[2] ?? fallbackLevel ?? 'INFO').toUpperCase();
  let level: LogLevel = LOG_LEVELS.includes(reported as LogLevel) ? reported as LogLevel : 'INFO';
  const message = match?.[4] ?? raw;
  if (level === 'INFO' && /^机器人回复/.test(message)) level = 'SUCCESS';
  return { id, time: match?.[1].slice(0, 8) ?? '', level, module: match?.[3] ?? '', message, raw };
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** nextOffset is a byte cursor at a complete newline, NOT fileSize or a JS string length. */
export function reconcileLogBatch(previous: LogBuffer, batch: LogsData): { buffer: LogBuffer; reread: boolean } {
  if (!Array.isArray(batch.lines) || batch.lines.some(line => typeof line !== 'string') ||
      !isOffset(batch.fileSize) || (batch.file !== null && typeof batch.file !== 'string')) {
    throw new Error('日志响应格式异常');
  }
  // The server omits nextOffset only when there is no log file.
  const offset = batch.file === null ? 0 : batch.nextOffset;
  if (!isOffset(offset) || offset > batch.fileSize) throw new Error('日志游标无效');
  const rotated = previous.initialized && (batch.file !== previous.file ||
    batch.fileSize < previous.fileSize || offset < previous.offset);
  if (rotated) {
    // The response may have read from an old byte cursor in a replacement file.
    // Discard it and explicitly request tailOff=0, instead of appending mixed files.
    return { buffer: createLogBuffer(previous.nextId), reread: true };
  }
  const incoming = batch.lines.slice(-LOG_MEMORY_LIMIT);
  const nextId = previous.nextId + incoming.length;
  // Equal cursors are allowed for an empty/partial file; repeated batches must not duplicate rows.
  const append = !previous.initialized || offset > previous.offset;
  const rows = append && incoming.length
    ? [...previous.rows, ...incoming.map((line, index) => parseLogLine(line, String(previous.nextId + index)))].slice(-LOG_MEMORY_LIMIT)
    : previous.rows;
  return {
    buffer: { rows, offset, fileSize: batch.fileSize, file: batch.file, initialized: true, nextId: append ? nextId : previous.nextId },
    reread: false,
  };
}

/** Filter before taking the visible tail, so older matches remain searchable in the bounded buffer. */
export function filterLogRows(rows: readonly LogRow[], selected: ReadonlySet<string>, search: string): LogRow[] {
  const query = search.trim().toLowerCase();
  return rows.filter(row => selected.has(row.level) && (!query || row.raw.toLowerCase().includes(query))).slice(-LOG_DISPLAY_LIMIT);
}
