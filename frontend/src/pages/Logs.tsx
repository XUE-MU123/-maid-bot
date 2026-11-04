import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BaseButton, Card, EmptyState, ErrorNotice, Icon, Input, Select } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { createLogBuffer, filterLogRows, LOG_LEVELS, reconcileLogBatch } from '../lib/logs';
import type { LogsData } from '../lib/types';

export function Logs() {
  const [limit, setLimit] = useState('200');
  const [search, setSearch] = useState('');
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState(() => new Set<string>(['INFO', 'SUCCESS', 'WARN', 'ERROR']));
  const [buffer, setBuffer] = useState(createLogBuffer);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  // The cursor lives in a ref: advancing it must not restart the polling effect.
  const bufferRef = useRef(buffer);
  const generationRef = useRef(0);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const refresh = () => setRevision(current => current + 1);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => generationRef.current === generation && !controller.signal.aborted;
    const publish = (next: typeof buffer) => { bufferRef.current = next; setBuffer(next); };
    // Limit changes and manual refresh are explicit reset-and-reread operations.
    publish(createLogBuffer(bufferRef.current.nextId));
    setError('');
    setLoading(true);

    async function load() {
      // Even a reset waits for the aborted fetch to settle before starting another.
      // This also makes StrictMode's setup/cleanup/setup safe against overlapping requests.
      const previous = inFlightRef.current;
      let release!: () => void;
      inFlightRef.current = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        if (!current()) return;
        setLoading(true);
        let reread: boolean;
        do {
          const offset = bufferRef.current.offset;
          const batch = await api<LogsData>(`/api/logs?limit=${limit}&tailOff=${offset}`, { signal: controller.signal });
          if (!current()) return;
          const result = reconcileLogBatch(bufferRef.current, batch);
          publish(result.buffer);
          reread = result.reread;
          // Rotation discards the ambiguous response and rereads with tailOff=0.
        } while (reread && current());
        setError('');
      } catch (cause) {
        // Keep the last good cursor and rows on failures; retry from that cursor.
        if (current()) setError(errorMessage(cause));
      } finally {
        release();
        if (current()) {
          setLoading(false);
          // Schedule only after completion: slow servers never accumulate polling requests.
          timer = setTimeout(() => { void load(); }, 3000);
        }
      }
    }

    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [limit, revision]);

  const rows = useMemo(() => filterLogRows(buffer.rows, selected, search), [buffer.rows, selected, search]);
  const toggle = (level: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(level)) next.delete(level); else next.add(level);
    return next;
  });
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    // Only this scroll container moves; scrollIntoView would also move the outer page.
    container.scrollTop = follow ? container.scrollHeight : scrollTopRef.current;
    scrollTopRef.current = container.scrollTop;
  }, [rows, follow, wrap]);
  const jumpEnd = () => {
    const container = scrollRef.current;
    if (container) { container.scrollTop = container.scrollHeight; scrollTopRef.current = container.scrollTop; }
  };

  return <div className="page-stack">
    <div className="page-heading"><div><h1>运行日志</h1><p>按级别筛选、搜索并跟随服务端实时日志。</p></div><div className="toolbar"><BaseButton size="small" onClick={refresh} busy={loading}><Icon name="refresh" size={15}/>刷新</BaseButton></div></div>
    <Card className="log-panel"><div className="log-header"><div className="card-header"><div><h2><span className="live-dot"/> 日志流</h2><p className="muted text-xs mt-1">{buffer.file ? `${buffer.file} · ${rows.length} 条` : '读取 logs/bot.log'}</p></div><div className="toolbar"><Input aria-label="搜索日志" type="search" placeholder="搜索消息 / 模块 / 级别" value={search} onChange={event => setSearch(event.target.value)}/><Select aria-label="日志数量" value={limit} onChange={event => setLimit(event.target.value)}><option value="100">100 行</option><option value="200">200 行</option><option value="500">500 行</option><option value="1000">1000 行</option></Select></div></div><div className="log-filters">{LOG_LEVELS.map(level => <button key={level} type="button" className={`log-filter ${selected.has(level) ? 'selected' : ''}`} aria-pressed={selected.has(level)} onClick={() => toggle(level)}><span className={`log-level level-${level}`}>{level}</span></button>)}<label className="log-filter selected"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)}/>跟随最新</label><label className="log-filter selected"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)}/>自动换行</label></div></div>
      {error && <ErrorNotice message={`读取日志失败：${error}`} onRetry={refresh}/>}<div ref={scrollRef} className={`log-scroll ${wrap ? '' : 'log-nowrap'}`} style={{ overflowAnchor: 'none' }} onScroll={event => { scrollTopRef.current = event.currentTarget.scrollTop; }}><div className="log-columns"><span>时间</span><span>级别</span><span>模块</span><span>消息</span></div>{rows.length ? rows.map(row => <div className={`log-row ${/机器人回复|判断为不插嘴/.test(row.message) ? 'log-reply' : ''}`} key={row.id}><span className="log-time">{row.time || '—'}</span><span className={`log-level level-${row.level}`}>{row.level}</span><span className="log-module">{row.module ? `[${row.module}]` : ''}</span><span className="log-message">{row.message}</span></div>) : <EmptyState>{loading ? '正在读取日志…' : '没有匹配的日志。'}</EmptyState>}</div><div className="log-status"><span>服务端增量轮询 · {rows.length} 条可见日志 · 缓存 {buffer.rows.length}/1200</span><BaseButton size="small" variant="ghost" onClick={jumpEnd}><Icon name="arrow" size={14}/>跳到最新</BaseButton></div></Card>
  </div>;
}
