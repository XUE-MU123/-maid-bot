import { lazy, Suspense, useEffect, useState } from 'react';
const App = lazy(() => import('./App').then(module => ({ default: module.App })));
import { Login } from './pages/Login';
import { api, clearAuthToken, setAuthToken } from './lib/api';
import { BaseButton, ErrorNotice } from './components/ui';

type AuthSession = { authenticated: boolean; username?: string; csrfToken?: string };
export function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    api<AuthSession>('/api/auth/session', { signal: ctrl.signal }).then(value => {
      if (ctrl.signal.aborted) return;
      if (value.authenticated && value.csrfToken) { setAuthToken(value.csrfToken); setSession(value); }
      else { clearAuthToken(); setSession({ authenticated: false }); }
      setError('');
    }).catch(() => { if (!ctrl.signal.aborted) setError('登录状态读取失败，请重试。'); });
    return () => ctrl.abort();
  }, [revision]);
  useEffect(() => {
    const expired = () => { clearAuthToken(); setSession({ authenticated: false }); setError(''); };
    window.addEventListener('maid-auth-expired', expired);
    return () => window.removeEventListener('maid-auth-expired', expired);
  }, []);
  async function login(username: string, password: string) {
    const value = await api<AuthSession>('/api/auth/login', { method: 'POST', body: { username, password } });
    if (!value.authenticated || !value.csrfToken) throw new Error('登录响应异常，请重试。');
    setAuthToken(value.csrfToken); setSession(value);
  }
  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    clearAuthToken(); setSession({ authenticated: false });
  }
  if (!session) return <main className="auth-loading" aria-live="polite"><div className="brand-mark">助</div>{error ? <ErrorNotice message={error} onRetry={() => { setError(''); setRevision(value => value + 1); }}/> : <p>正在确认登录状态…</p>}<noscript>请启用 JavaScript 后登录控制台。</noscript><BaseButton variant="ghost" onClick={() => setRevision(value => value + 1)}>重新检查</BaseButton></main>;
  return session.authenticated ? <Suspense fallback={<main className="auth-loading" aria-live="polite"><div className="brand-mark">助</div><p>正在打开控制台…</p></main>}><App username={session.username} onLogout={logout}/></Suspense> : <Login onLogin={login}/>;
}
