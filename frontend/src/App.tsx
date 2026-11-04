import { useEffect, useRef, useState } from 'react';
import { InteractiveBackground } from './components/InteractiveBackground';
import { useEffects } from './hooks/useEffects';
import { Dashboard } from './pages/Dashboard';
import { Sessions } from './pages/Sessions';
import { Favors } from './pages/Favors';
import { Ignores } from './pages/Ignores';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { usePolling } from './hooks/usePolling';
import { Badge, BaseButton, ErrorNotice, Icon, Toast } from './components/ui';
import type { Config, Notify, Overview, Tab } from './lib/types';

const nav: Array<{ id: Tab; label: string; detail: string; icon: 'dashboard' | 'message' | 'heart' | 'shield' | 'settings' | 'terminal' }> = [
  { id: 'overview', label: '总览', detail: '运行概况', icon: 'dashboard' },
  { id: 'sessions', label: '会话', detail: '群聊与私聊', icon: 'message' },
  { id: 'favors', label: '好感度', detail: '关系记录', icon: 'heart' },
  { id: 'ignores', label: '不理名单', detail: '临时屏蔽', icon: 'shield' },
  { id: 'settings', label: '设置', detail: '模型与行为', icon: 'settings' },
  { id: 'logs', label: '日志', detail: '实时事件流', icon: 'terminal' },
];
const titles: Record<Tab, [string, string]> = {
  overview: ['总览', '机器人运行概况'], sessions: ['会话', '管理群聊、私聊和记忆'], favors: ['好感度', '查看关系等级与手动调整'], ignores: ['不理名单', '查看与解除暂时屏蔽'], settings: ['设置', '模型、人格与运行参数'], logs: ['日志', '实时事件流与排错'],
};

export function App({ username, onLogout }: { username?: string; onLogout?: () => Promise<void> }) {
  const { enabled: effects, toggle: toggleEffects } = useEffects();
  const [loggingOut, setLoggingOut] = useState(false);
  async function logout() {
    if (loggingOut || !onLogout) return;
    setLoggingOut(true);
    try { await onLogout(); } catch { notify('退出未完成，请重试。', 'error'); }
    finally { setLoggingOut(false); }
  }
  const [tab, setTab] = useState<Tab>('overview');
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Same breakpoint as CSS: desktop toggles a rail, narrow screens toggle an overlay drawer.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const change = () => { setNarrow(media.matches); setMobileOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarToggleRef = useRef<HTMLDivElement>(null);
  function closeMobileSidebar() {
    setMobileOpen(false);
    // Navigation labels disappear in the rail; leave keyboard focus on its persistent toggle.
    sidebarToggleRef.current?.querySelector<HTMLButtonElement>('.brand-menu')?.focus();
  }
  function toggleSidebar() {
    if (narrow) { if (mobileOpen) closeMobileSidebar(); else setMobileOpen(true); }
    else setCollapsed(value => !value);
  }
  useEffect(() => {
    if (!narrow || !mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMobileSidebar(); }
      if (event.key !== 'Tab') return;
      const buttons = sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    sidebarToggleRef.current?.querySelector<HTMLButtonElement>('.brand-menu')?.focus();
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [narrow, mobileOpen]);
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return localStorage.getItem('maid-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  const [toast, setToast] = useState<{ message: string; kind: 'success' | 'error' }>();
  const notify: Notify = (message, kind = 'success') => setToast({ message, kind });
  // Initial settings read only. Successful writes publish their own response via onConfig;
  // background GETs must not overwrite a just-saved configuration.
  const configPolling = usePolling<Config>('/api/config', 0, settingsVisited);
  const overview = usePolling<Overview>('/api/overview', 5000, true);
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('maid-theme', theme); } catch { /* 隐私模式忽略 */ } }, [theme]);
  function navigate(next: Tab) { if (next === 'settings') setSettingsVisited(true); setTab(next); if (narrow) closeMobileSidebar(); }
  function content() {
    if (tab === 'overview') return <Dashboard notify={notify} onTab={navigate}/>;
    if (tab === 'sessions') return <Sessions notify={notify}/>;
    if (tab === 'favors') return <Favors notify={notify}/>;
    if (tab === 'ignores') return <Ignores notify={notify}/>;
    if (tab === 'logs') return <Logs/>;
    return null; // Settings has a stable sibling below; navigating must not unmount its draft.
  }
  const [title, subtitle] = titles[tab];
  const connectionKnown = !!overview.data && !overview.error;
  const online = connectionKnown && overview.data?.status.onebotConnected;
  const connectionText = !connectionKnown ? overview.error ? '连接状态未知' : '读取连接状态…' : online ? 'OneBot 在线' : 'OneBot 离线';
  const connectionTone = !connectionKnown ? 'warning' : online ? 'success' : 'danger';
  const railCollapsed = narrow ? !mobileOpen : collapsed;
  return <div className={`app-shell ${railCollapsed ? 'is-collapsed' : ''}`}>
    <InteractiveBackground enabled={effects} fixedViewport className="panel-starfield"/>
    <div className={`mobile-backdrop ${mobileOpen ? 'visible' : ''}`} onClick={closeMobileSidebar}/>
    <aside ref={sidebarRef} id="main-sidebar" className={`sidebar ${railCollapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      <div className="brand" ref={sidebarToggleRef}><div className="brand-mark">助</div><div className="brand-copy"><div className="brand-title">女仆大总管</div><div className="brand-subtitle">MAID BOT CONSOLE</div></div><BaseButton className="brand-menu" size="icon" variant="ghost" aria-label={railCollapsed ? '展开侧栏' : '收起侧栏'} title={railCollapsed ? '展开侧栏' : '收起侧栏'} aria-controls="main-sidebar" aria-expanded={!railCollapsed} onClick={toggleSidebar}><span className="rail-brand-mark" aria-hidden="true">助</span><Icon name="panel" size={19}/></BaseButton></div>
      <div className="nav-label">WORKSPACE</div><nav className="nav-items" aria-label="主导航">{nav.map(item => <button key={item.id} type="button" className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} title={railCollapsed ? item.label : undefined} aria-label={railCollapsed ? item.label : undefined}><Icon name={item.icon} size={17}/><span className="nav-text"><span>{item.label}</span><small>{item.detail}</small></span></button>)}</nav>
      <div className="nav-spacer"/><div className="sidebar-info"><Badge tone={connectionTone}><Icon name={online ? 'wifi' : 'power'} size={12}/>{connectionText}</Badge><div className="muted mt-1">账号 {overview.data?.status.selfId || '—'}</div></div>
      <div className="sidebar-footer"><span className="sidebar-version">v{overview.data?.version || '0.1.1'} · 控制台</span></div>
    </aside>
    <main className="main-canvas" inert={narrow && mobileOpen}><header className="topbar"><div className="flex items-center gap-3"><div><h1 className="topbar-title">{title}</h1><div className="topbar-subtitle">{subtitle}</div></div></div><div className="topbar-tools"><span className="topbar-online"><Badge tone={connectionTone}><Icon name={online ? 'wifi' : 'power'} size={12}/>{connectionText}</Badge></span><span className="topbar-separator"/><BaseButton variant="ghost" size="icon" aria-label={effects ? '关闭背景动效' : '开启背景动效'} aria-pressed={effects} title={effects ? '关闭背景动效' : '开启背景动效'} onClick={toggleEffects}><Icon name="sparkles" size={17}/></BaseButton><BaseButton variant="ghost" size="icon" aria-label="切换主题" title="切换浅色 / 深色" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17}/></BaseButton>{onLogout && <BaseButton variant="ghost" size="icon" busy={loggingOut} aria-label="退出登录" title={`退出登录${username ? `（${username}）` : ''}`} onClick={() => { void logout(); }}><Icon name="logout" size={17}/></BaseButton>}</div></header><section className="page-content">{content()}<div hidden={tab !== 'settings'}>{configPolling.error && <ErrorNotice message={`设置读取失败：${configPolling.error}`} onRetry={configPolling.refresh}/>} {!configPolling.data ? <div className="empty-state">正在读取设置…</div> : <Settings config={configPolling.data} onConfig={config => configPolling.setData(config)} notify={notify}/>}</div></section></main>
    {toast && <div className="toasts"><Toast message={toast.message} kind={toast.kind} onClose={() => setToast(undefined)}/></div>}
  </div>;
}
