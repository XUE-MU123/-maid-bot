import { describe, expect, it } from 'vitest';
import { createLogBuffer, filterLogRows, LOG_DISPLAY_LIMIT, LOG_LEVELS, LOG_MEMORY_LIMIT, parseLogLine, reconcileLogBatch } from '../src/lib/logs';
import type { LogBuffer } from '../src/lib/logs';
import type { LogsData } from '../src/lib/types';

// Synthetic data only: no live server, filesystem log content, or POST requests.
function batch(lines: string[], nextOffset = 100, fileSize = nextOffset, file: string | null = './logs/bot.log'): LogsData {
  return { lines, nextOffset, fileSize, file };
}
function append(previous: LogBuffer, lines: string[], offset: number) {
  return reconcileLogBatch(previous, batch(lines, offset)).buffer;
}

describe('log parsing and filtering', () => {
  it('parses timestamps, padded levels, module and multiline messages', () => {
    expect(parseLogLine('2026-11-03 18:00:01.123 [WARN   ] [pipeline] first\nsecond', 'row-1')).toEqual({
      id: 'row-1', time: '18:00:01', level: 'WARN', module: 'pipeline', message: 'first\nsecond',
      raw: '2026-11-03 18:00:01.123 [WARN   ] [pipeline] first\nsecond',
    });
  });
  it('handles fallback levels, unknown levels, replies and literal HTML safely', () => {
    expect(parseLogLine('[error] failed', '1').level).toBe('ERROR');
    expect(parseLogLine('[DEBUG] debug', '2').level).toBe('DEBUG');
    expect(parseLogLine('2026-11-03 18:00:01 [CUSTOM] [bot] hello', '3').level).toBe('INFO');
    expect(parseLogLine('2026-11-03 18:00:01 [INFO] [bot] 机器人回复：你好', '4').level).toBe('SUCCESS');
    expect(parseLogLine('机器人回复 hello', '5').level).toBe('SUCCESS');
    expect(parseLogLine('<script>not executable</script>', '6').message).toBe('<script>not executable</script>');
    expect(parseLogLine('[WARN] 机器人回复', '7').level).toBe('WARN');
  });
  it('combines case-insensitive raw search with effective-level filtering', () => {
    const rows = ['2026-11-03 18:00:01 [INFO] [PIPELINE] 机器人回复 hello', '[ERROR] hello', '[DEBUG] hello'].map((line, i) => parseLogLine(line, String(i)));
    expect(filterLogRows(rows, new Set(['SUCCESS']), ' pipeline ')).toEqual([rows[0]]);
    expect(filterLogRows(rows, new Set(['ERROR']), 'HELLO')).toEqual([rows[1]]);
    expect(filterLogRows(rows, new Set(), '')).toEqual([]);
    expect(filterLogRows(rows, new Set(LOG_LEVELS), 'absent')).toEqual([]);
  });
  it('filters before applying the 800-row visible cap', () => {
    const rows = Array.from({ length: LOG_MEMORY_LIMIT }, (_, i) => parseLogLine(`${i < 900 ? 'needle' : 'other'}-${i}`, String(i)));
    const visible = filterLogRows(rows, new Set(['INFO']), 'needle');
    expect(visible).toHaveLength(LOG_DISPLAY_LIMIT);
    expect(visible[0].raw).toBe('needle-100');
    expect(visible.at(-1)?.raw).toBe('needle-899');
  });
});

describe('incremental byte offsets and bounded buffers', () => {
  it('starts at zero and accumulates batches without replacing earlier lines', () => {
    const initial = createLogBuffer();
    expect(initial.offset).toBe(0);
    const first = append(initial, ['first'], 10);
    const second = append(first, ['second'], 20);
    expect(second.rows.map(row => row.raw)).toEqual(['first', 'second']);
    expect(second.offset).toBe(20);
    expect(second.rows[0].id).toBe(first.rows[0].id);
    expect(initial.rows).toEqual([]);
  });
  it('advances only to the complete-line cursor, never to fileSize or UTF-16 length', () => {
    const first = reconcileLogBatch(createLogBuffer(), batch(['你好🙂'], 11, 19)).buffer;
    expect(first.offset).toBe(11);
    const partial = reconcileLogBatch(first, batch([], 11, 25)).buffer;
    expect(partial.offset).toBe(11);
    expect(partial.fileSize).toBe(25);
    expect(partial.rows).toBe(first.rows);
    const completed = reconcileLogBatch(partial, batch(['完整行'], 25, 25)).buffer;
    expect(completed.offset).toBe(25);
    expect(completed.rows.map(row => row.raw)).toEqual(['你好🙂', '完整行']);
  });
  it('does not duplicate equal-cursor responses but preserves identical distinct log entries', () => {
    const first = append(createLogBuffer(), ['same', 'same'], 10);
    const replay = append(first, ['same', 'same'], 10);
    expect(replay.rows).toBe(first.rows);
    const next = append(replay, ['same'], 20);
    expect(next.rows).toHaveLength(3);
    expect(new Set(next.rows.map(row => row.id)).size).toBe(3);
  });
  it('handles an entirely partial initial file and an empty/missing file', () => {
    const partial = reconcileLogBatch(createLogBuffer(), batch([], 0, 8)).buffer;
    expect(partial.offset).toBe(0);
    expect(reconcileLogBatch(partial, batch(['now complete'], 9)).buffer.rows).toHaveLength(1);
    const missing = reconcileLogBatch(createLogBuffer(), { lines: [], file: null, fileSize: 0 });
    expect(missing.reread).toBe(false);
    expect(missing.buffer.offset).toBe(0);
  });
  it('caps memory to 1200, including oversized batches, and keeps unique stable IDs', () => {
    const first = append(createLogBuffer(), Array.from({ length: 1000 }, (_, i) => `first-${i}`), 1000);
    const next = append(first, Array.from({ length: 1000 }, (_, i) => `next-${i}`), 2000);
    expect(next.rows).toHaveLength(LOG_MEMORY_LIMIT);
    expect(next.rows[0].raw).toBe('first-800');
    expect(next.rows.at(-1)?.raw).toBe('next-999');
    expect(next.rows[0].id).toBe(first.rows[800].id);
    expect(new Set(next.rows.map(row => row.id)).size).toBe(LOG_MEMORY_LIMIT);
    const oversized = append(next, Array.from({ length: 2000 }, (_, i) => `huge-${i}`), 4000);
    expect(oversized.rows).toHaveLength(LOG_MEMORY_LIMIT);
    expect(oversized.rows[0].raw).toBe('huge-800');
  });
  it.each([
    ['file size shrinks even above previous cursor', batch(['ambiguous'], 105, 110)],
    ['cursor moves backwards', batch(['ambiguous'], 90, 150)],
    ['file path changes', batch(['ambiguous'], 120, 150, './logs/replacement.log')],
    ['file disappears', { lines: [], fileSize: 0, file: null }],
  ] satisfies [string, LogsData][])('clears and requests tailOff=0 when %s', (_, response) => {
    const previous = reconcileLogBatch(createLogBuffer(), batch(['old'], 100, 120)).buffer;
    const rotation = reconcileLogBatch(previous, response);
    expect(rotation.reread).toBe(true);
    expect(rotation.buffer.offset).toBe(0);
    expect(rotation.buffer.rows).toEqual([]);
    expect(rotation.buffer.initialized).toBe(false);
    const fresh = reconcileLogBatch(rotation.buffer, batch(['new'], 10));
    expect(fresh.reread).toBe(false);
    expect(fresh.buffer.rows.map(row => row.raw)).toEqual(['new']);
    expect(fresh.buffer.rows[0].id).not.toBe(previous.rows[0].id);
  });
  it.each([
    { lines: [], fileSize: 10, file: './logs/bot.log' },
    batch([], 11, 10), batch([], -1, 10), batch([], 1.5, 10), batch([], Number.NaN, 10),
    batch([], 10, Number.POSITIVE_INFINITY),
    { ...batch([]), lines: ['valid', null] },
  ])('rejects invalid payload/cursors without mutating the last good state', invalid => {
    const previous = append(createLogBuffer(), ['keep'], 5);
    expect(() => reconcileLogBatch(previous, invalid as LogsData)).toThrow();
    expect(previous.offset).toBe(5);
    expect(previous.rows[0].raw).toBe('keep');
  });
});
