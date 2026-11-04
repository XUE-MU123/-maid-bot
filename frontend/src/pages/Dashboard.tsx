import { useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import { Avatar, Badge, BaseButton, Card, ErrorNotice, Icon, Modal, StatCard } from '../components/ui';
import type { Config, Notify, Overview } from '../lib/types';

interface ExtraList { groups?: unknown[]; friends?: unknown[]; note?: string }
interface LogsResponse { lines: string[] }
const fmtNum = (n: unknown) => Number(n || 0).toLocaleString('zh-CN');
function fmtDuration(sec: number) { const s = Math.max(0, Math.floor(sec || 0)); const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60); return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`; }
function level(line: string) { if (line.includes('[ERROR')) return 'ERROR'; if (line.includes('[WARN')) return 'WARN'; if (line.includes('机器人回复')) return 'SUCCESS'; if (line.includes('[DEBUG')) return 'DEBUG'; return 'INFO'; }
function logLine(line: string) { const m = line.match(/^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) \[(\w+)\s*\] \[([^\]]+)\] ([\s\S]*)$/); return m ? { time: m[1].slice(0, 8), level: m[2].toUpperCase(), module: m[3], message: m[4] } : { time: '', level: level(line), module: '', message: line }; }

export function Dashboard({ notify, onTab }: { notify: Notify; onTab: (tab: 'logs' | 'settings') => void }) {
  const [replyBusy, setReplyBusy] = useState(false);
  const replyActionLock = useRef(false);
  const overview = usePolling<Overview>('/api/overview', 3000);
  const config = usePolling<Config>('/api/config', 5000, !replyBusy);
  const extras = usePolling<ExtraList>('/api/groups', 10000);
  const friends = usePolling<ExtraList>('/api/friends', 10000);
  const logs = usePolling<LogsResponse>('/api/logs?limit=18', 3000);
  const [llmBusy, setLlmBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [llmResult, setLlmResult] = useState('点击测试模型连通性，确认当前已保存接口可用。');
  const currentAutoReply = config.data?.bot?.globalAutoReply ?? null;
  const d = overview.data;
  const masterStatus = overview.error ? undefined : d?.masterStatus;
  const masterModeText = masterStatus ? { none: '无老大', single: '单老大', dual: '双老大' }[masterStatus.mode] : overview.loading ? '读取中' : '未知';
  const connectionKnown = !!d && !overview.error;
  const online = connectionKnown && !!d?.status.onebotConnected;
  const connectionText = !connectionKnown ? overview.error ? '连接状态未知' : '读取连接状态…' : online ? 'OneBot 在线' : 'OneBot 离线';
  async function testLLM() { setLlmBusy(true); try { const result = await api<{ ok: boolean; model?: string; ms: number; reply?: string; error?: string }>('/api/llm/test', { method: 'POST' }); const text = result.ok ? `模型 ${result.model || '-'} 已连通 · ${result.ms} ms${result.reply ? ` · ${result.reply}` : ''}` : `连通失败：${result.error || '未知原因'}`; setLlmResult(text); notify(result.ok ? '模型连通正常' : text, result.ok ? 'success' : 'error'); } catch (e) { const text = errorMessage(e); setLlmResult(text); notify(text, 'error'); } finally { setLlmBusy(false); } }
  async function clearMemory() { setClearBusy(true); try { await api('/api/memory/clear', { method: 'POST', body: {} }); notify('全部记忆已清空'); setClearOpen(false); overview.refresh(); } catch (e) { notify(`清空失败：${errorMessage(e)}`, 'error'); } finally { setClearBusy(false); } }
  async function toggleReply() {
    if (replyActionLock.current || currentAutoReply === null) return;
    replyActionLock.current = true; setReplyBusy(true);
    try {
      const result = await api<{ globalAutoReply: boolean }>('/api/reply/toggle', { method: 'POST' });
      config.setData(previous => previous && ({ ...previous, bot: { ...previous.bot, globalAutoReply: result.globalAutoReply } }));
      notify(`全局回复已${result.globalAutoReply ? '开启' : '关闭'}`);
      config.refresh(); overview.refresh();
    } catch (cause) { notify(`切换失败：${errorMessage(cause)}`, 'error'); config.refresh(); }
    finally { replyActionLock.current = false; setReplyBusy(false); }
  }
  return <div className="page-stack">
    {overview.error && <ErrorNotice message={`总览读取失败：${overview.error}`} onRetry={overview.refresh}/>}
    {config.error && <ErrorNotice message={`回复配置读取失败：${config.error}`} onRetry={config.refresh}/>}
    {extras.error && <ErrorNotice message={`群列表读取失败：${extras.error}`} onRetry={extras.refresh}/>}
    {friends.error && <ErrorNotice message={`好友列表读取失败：${friends.error}`} onRetry={friends.refresh}/>}
    <div className="kpi-grid">
      <StatCard label="ONEBOT 连接" value={!connectionKnown ? '未知' : online ? '在线' : '离线'} hint={overview.error ? '状态读取失败，请重试' : online ? 'WebSocket 已连接 SnowLuma' : d?.status.lastError || '正在等待协议端'} icon="wifi" tone={online ? 'success' : 'warning'}/>
      <StatCard label="消息总数" value={d ? fmtNum(d.stats.messages) : '—'} hint="机器人记住的所有对话" icon="message" tone="blue"/>
      <StatCard label="会话数" value={d ? fmtNum(d.stats.sessions) : '—'} hint="见过的群和好友" icon="users"/>
      <StatCard label="好感人数" value={d ? fmtNum(d.favorCount) : '—'} hint="有记录的联系人" icon="heart" tone="success"/>
      <StatCard label="TOKEN 用量" value={d ? fmtNum(d.usage.totalPrompt + d.usage.totalCompletion) : '—'} hint={d ? `输入 ${fmtNum(d.usage.totalPrompt)} / 输出 ${fmtNum(d.usage.totalCompletion)}` : '输入 / 输出'} icon="zap" tone="warning"/>
      <StatCard label="已运行" value={d ? fmtDuration(d.uptimeSec) : '—'} hint={d ? `账号 ${d.status.selfId || '-'}` : '正在读取'} icon="clock" tone="primary"/>
    </div>
    <div className="dashboard-middle">
      <div className="dashboard-connection-stack">
      <Card className="connection-card" title="连接概况" action={<BaseButton size="small" onClick={() => { overview.refresh(); extras.refresh(); friends.refresh(); }} aria-label="刷新连接概况"><Icon name="refresh" size={14}/>刷新</BaseButton>}>
        <div className={`connection-status ${!connectionKnown ? 'is-unknown' : online ? 'is-online' : 'is-offline'}`}><span className="connection-status-dot"/><div><strong>{connectionText}</strong><p>{connectionKnown ? `登录账号 ${d?.status.selfId || '—'}` : '暂时无法确认协议端状态'}</p></div><Icon name={online ? 'wifi' : 'power'} size={24}/></div>
        <dl className="connection-metrics"><div><dt>已加入群</dt><dd>{extras.error || extras.data?.note ? '—' : extras.data?.groups?.length ?? '—'}</dd></div><div><dt>好友数</dt><dd>{friends.error || friends.data?.note ? '—' : friends.data?.friends?.length ?? '—'}</dd></div><div><dt>累计重连</dt><dd>{connectionKnown ? fmtNum(d?.status.reconnects) : '—'}</dd></div></dl>
        <div className={`connection-error ${d?.status.lastError ? 'has-error' : ''}`}><Icon name={d?.status.lastError ? 'help' : 'check'} size={14}/><span>{!connectionKnown ? '最近错误：状态未知' : d?.status.lastError ? `最近错误：${d.status.lastError}` : '最近错误：无'}</span></div>
      </Card>
      <Card className="master-status-card" title="老大身份" action={<Badge tone={masterStatus?.mode === 'none' || !masterStatus ? 'neutral' : 'primary'}>{masterModeText}</Badge>}>
        {!masterStatus ? <p className="master-status-empty">{overview.loading ? '正在读取老大身份…' : '老大身份未知，等待服务端提供状态。'}</p> : masterStatus.mode === 'none' ? <p className="master-status-empty">无老大、无主人</p> : <div className="master-status-list">
          {([{ role: 'primary', person: masterStatus.primary, label: masterStatus.mode === 'dual' ? '第一老大' : '老大' }, ...(masterStatus.mode === 'dual' ? [{ role: 'secondary', person: masterStatus.secondary, label: '二老大' }] : [])]).map(({ role, person, label }) => <div className={`master-status-member master-status-${role}`} key={role}>
            <Avatar src={person?.avatar ?? ''} name={person?.nickname || person?.qq || label}/>
            <div className="master-status-identity"><span className="master-status-label">{label}</span><strong title={person?.nickname || person?.qq || '身份读取中'}>{person?.nickname || (person ? `QQ ${person.qq}` : '身份读取中')}</strong><span className="master-status-qq">QQ {person?.qq || '—'}</span></div>
          </div>)}
        </div>}
      </Card>
      </div>
      <Card title="快捷操作" description="常用维护动作都保留在这里。"><div className="quick-grid"><div className="quick-action"><div className="flex items-center"><span className="quick-action-icon"><Icon name="wifi" size={17}/></span><div><b className="text-xs">模型连通性</b><div className="muted text-xs mt-1">测试已保存配置</div></div></div><BaseButton size="small" busy={llmBusy} onClick={() => void testLLM()}>测试</BaseButton></div><div className="hint-box">{llmResult}</div><div className="quick-action"><div className="flex items-center"><span className="quick-action-icon"><Icon name="settings" size={17}/></span><div><b className="text-xs">全局自动回复</b><div className="muted text-xs mt-1">当前：{currentAutoReply === null ? '请刷新读取' : currentAutoReply ? '开启' : '关闭'}</div></div></div><BaseButton size="small" variant={currentAutoReply ? 'primary' : 'secondary'} busy={replyBusy} disabled={currentAutoReply === null} onClick={() => void toggleReply()}>切换</BaseButton></div><div className="quick-action"><div className="flex items-center"><span className="quick-action-icon"><Icon name="database" size={17}/></span><div><b className="text-xs">清空全部记忆</b><div className="muted text-xs mt-1">好感度不会受到影响</div></div></div><BaseButton size="small" variant="danger" disabled={clearBusy} onClick={() => setClearOpen(true)}>清空</BaseButton></div></div></Card>
      <Modal open={clearOpen} onClose={() => { if (!clearBusy) setClearOpen(false); }} title="清空全部记忆" description="此操作不可撤销，好感度不会受到影响。确定要删除机器人记住的所有对话吗？"><div className="modal-actions"><BaseButton disabled={clearBusy} onClick={() => setClearOpen(false)}>取消</BaseButton><BaseButton variant="danger" busy={clearBusy} onClick={() => void clearMemory()}>确认清空</BaseButton></div></Modal>
    </div>
    <Card title="最近运行日志" description="实时查看机器人最近在处理什么。" action={<BaseButton size="small" onClick={() => onTab('logs')}>查看完整日志 <Icon name="arrow" size={14}/></BaseButton>}>
      {logs.error && <ErrorNotice message={`最近日志读取失败：${logs.error}`} onRetry={logs.refresh}/>}
      <div className="log-scroll compact">{logs.data?.lines.length ? logs.data.lines.map((line, i) => { const row = logLine(line); return <div className="log-row" key={`${i}-${line}`}><span className="log-time">{row.time || '—'}</span><span className={`log-level level-${row.level}`}>{row.level}</span><span className="log-module">{row.module ? `[${row.module}]` : ''}</span><span className="log-message">{row.message}</span></div>; }) : <div className="empty-state">{logs.loading ? '正在读取日志…' : '还没有日志。'}</div>}</div>
    </Card>
  </div>;
}
