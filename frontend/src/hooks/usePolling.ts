import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';

/** 一次请求完成后才安排下一次，避免慢接口堆积；卸载时中止请求。 */
export function usePolling<T>(path: string, interval = 3000, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const id = ++generation.current;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await api<T>(path, { signal: ctrl.signal });
        if (id === generation.current && !ctrl.signal.aborted) { setData(value); setError(''); }
      } catch (e) {
        if (!ctrl.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          if (interval > 0) timer = setTimeout(load, interval);
        }
      }
    }
    setLoading(true);
    void load();
    return () => { ctrl.abort(); clearTimeout(timer); };
  }, [path, interval, enabled, revision]);
  return { data, error, loading, refresh, setData };
}
