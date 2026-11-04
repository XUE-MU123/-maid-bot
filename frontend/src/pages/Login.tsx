import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BaseButton, Icon, Input } from '../components/ui';
import { InteractiveBackground } from '../components/InteractiveBackground';
import '../styles/login.css';
import { useEffects } from '../hooks/useEffects';

export function Login({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { enabled: effects, toggle: toggleEffects } = useEffects();
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameId = useId(), passwordId = useId(), errorId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem('maid-theme', next); } catch { /* In-memory switching still works. */ }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The ref closes the same-tick gap before React applies the disabled state.
    if (inFlight.current) return;
    if (!username.trim() || !password) { setError('请输入账号和密码后再登录。'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try {
      // Authentication and dashboard mounting belong to the parent. No credentials are stored here.
      await onLogin(username.trim(), password);
      if (mounted.current) { setPassword(''); setRevealed(false); }
    } catch {
      if (mounted.current) {
        // Never render raw gateway errors: they may contain internal details or submitted values.
        setError('登录未成功，请检查账号和密码，或稍后重试。');
        setPassword(''); setRevealed(false);
        passwordRef.current?.focus();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <main className="login-page" aria-labelledby="login-title">
    <InteractiveBackground enabled={effects}/>
    <header className="login-toolbar">
      <div className="login-tools">
        <BaseButton className="login-tool" variant="secondary" onClick={toggleEffects} aria-pressed={effects} aria-label={effects ? '关闭背景动效' : '开启背景动效'} title={effects ? '关闭背景动效' : '开启背景动效'}><Icon name="sparkles" size={15}/><span>动效{effects ? '开' : '关'}</span></BaseButton>
        <BaseButton className="login-tool login-theme-tool" variant="secondary" onClick={toggleTheme} aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16}/></BaseButton>
      </div>
    </header>
    <div className="login-stage">
      <div className="login-wrap">
        <section className="login-card" data-background-exclude="">
          <div className="login-brand-mark" aria-hidden="true">助</div>
          <div className="login-eyebrow">MAID BOT CONSOLE</div>
          <h1 id="login-title">女仆大总管</h1>
          <p className="login-welcome">老大，欢迎回来。</p>
          <form className="login-form" onSubmit={submit} aria-busy={busy} aria-describedby={error ? errorId : undefined}>
            <div className="login-field">
              <label htmlFor={usernameId}>账号</label>
              <div className="login-input-shell"><Icon name="user" size={18}/><Input id={usernameId} name="username" type="text" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={128} required readOnly={busy} placeholder="请输入账号" aria-invalid={!!error}/></div>
            </div>
            <div className="login-field">
              <label htmlFor={passwordId}>密码</label>
              <div className="login-input-shell"><Icon name="lock" size={18}/><input ref={passwordRef} className="ui-input" id={passwordId} name="password" type={revealed ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" maxLength={256} required readOnly={busy} placeholder="请输入密码" aria-invalid={!!error}/><BaseButton className="login-reveal" variant="ghost" size="icon" onClick={() => setRevealed(value => !value)} aria-controls={passwordId} aria-label={revealed ? '隐藏密码' : '显示密码'} aria-pressed={revealed} title={revealed ? '隐藏密码' : '显示密码'}><Icon name={revealed ? 'eyeoff' : 'eye'} size={18}/></BaseButton></div>
            </div>
            {error && <p className="login-error" id={errorId} role="alert"><Icon name="help" size={16}/><span>{error}</span></p>}
            <BaseButton type="submit" className="login-submit" variant="primary" disabled={busy} busy={busy}>{busy ? '正在登录…' : '进入控制台'}{!busy && <Icon name="arrow" size={17}/>}</BaseButton>
          </form>
          <p className="login-security"><Icon name="lock" size={13}/><span>安全登录 · 登录有效期12小时</span></p>
        </section>
      </div>
    </div>
  </main>;
}
