import { useEffect, useRef, useState } from 'react';
import '../styles/sessions.css';
import { Avatar, Badge, BaseButton, Card, EmptyState, ErrorNotice, Field, Icon, Input, Modal, Select, Table, Textarea, Toggle } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { api, errorMessage } from '../lib/api';
import type { Notify, PanelSession, SessionsData, StoredMessage } from '../lib/types';

type SessionPatch = Pick<PanelSession, 'name' | 'enabled' | 'prompt' | 'memoryShared' | 'atProb' | 'keywordProb' | 'keywords' | 'randomProb' | 'proactiveEnabled' | 'proactiveMinMinutes' | 'proactiveMaxMinutes' | 'proactiveMaxRounds'>;
type NumericField = 'atProb' | 'keywordProb' | 'randomProb' | 'proactiveMinMinutes' | 'proactiveMaxMinutes' | 'proactiveMaxRounds';
type Draft = Omit<SessionPatch, NumericField> & Record<NumericField, string>;
type Confirmation = { action: 'clear' | 'delete'; session: PanelSession };
const titleOf = (session: PanelSession) => (session.type === 'private' ? session.nickname || session.name : session.name) || '未命名';
const percent = (value: number) => `${Number((value * 100).toFixed(4))}%`;
const sessionPath = (key: string) => `/api/sessions/${encodeURIComponent(key)}`;
const draftOf = (session: PanelSession): Draft => ({
  name: session.name, enabled: session.enabled, prompt: session.prompt, memoryShared: session.memoryShared,
  atProb: String(Number((session.atProb * 100).toFixed(8))), keywordProb: String(Number((session.keywordProb * 100).toFixed(8))), randomProb: String(Number((session.randomProb * 100).toFixed(8))),
  keywords: session.keywords || '', proactiveEnabled: session.proactiveEnabled,
  proactiveMinMinutes: String(session.proactiveMinMinutes), proactiveMaxMinutes: String(session.proactiveMaxMinutes), proactiveMaxRounds: String(session.proactiveMaxRounds),
});

export function Sessions({ notify }: { notify: Notify }) {
  const [filter, setFilter] = useState<'all' | 'group' | 'private'>('all');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<PanelSession | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [confirmationError, setConfirmationError] = useState('');
  const [memoryRevision, setMemoryRevision] = useState(0);
  // 暂停写操作期间的轮询，避免迟到的 GET 覆盖操作结果；编辑草稿由独立组件保管。
  const { data, error, loading, refresh, setData } = usePolling<SessionsData>('/api/sessions', 5000, busyKey === null);
  const query = search.trim().toLowerCase();
  const sessions = (data?.sessions || []).filter(session =>
    (filter === 'all' || session.type === filter) &&
    (status === 'all' || session.enabled === (status === 'enabled')) &&
    (!query || [session.name, session.nickname, session.targetId, session.key].some(value => value?.toLowerCase().includes(query))),
  ).sort((a, b) => Number(a.type === 'private') - Number(b.type === 'private'));
  const pageCount = Math.max(1, Math.ceil(sessions.length / 20));
  const currentPage = Math.min(page, pageCount);
  const visibleSessions = sessions.slice((currentPage - 1) * 20, currentPage * 20);
  useEffect(() => { setPage(previous => Math.min(previous, pageCount)); }, [pageCount]);

  async function toggleSession(session: PanelSession, enabled: boolean) {
    if (busyKey !== null) return;
    setBusyKey(session.key); setActionError('');
    try {
      await api(sessionPath(session.key), { method: 'POST', body: { enabled } });
      setData(previous => previous && ({ ...previous, sessions: previous.sessions.map(item => item.key === session.key ? { ...item, enabled } : item) }));
      notify(`会话已${enabled ? '开启' : '关闭'}`); refresh();
    } catch (cause) { const message = `保存失败：${errorMessage(cause)}`; setActionError(message); notify(message, 'error'); }
    finally { setBusyKey(null); }
  }

  async function confirmAction() {
    if (!confirmation || busyKey !== null) return;
    const { session, action } = confirmation;
    setBusyKey(session.key); setConfirmationError(''); setActionError('');
    try {
      if (action === 'clear') {
        await api('/api/memory/clear', { method: 'POST', body: { key: session.key } });
        notify(session.memoryShared ? '互通记忆已清空，所有使用互通记忆的会话都会受影响' : '这个会话的记忆已清空');
        setMemoryRevision(previous => previous + 1);
      } else {
        await api(sessionPath(session.key), { method: 'DELETE' });
        setData(previous => previous && ({ ...previous, sessions: previous.sessions.filter(item => item.key !== session.key) }));
        notify('会话已删除'); setEditing(null);
      }
      setConfirmation(null); refresh();
    } catch (cause) { const message = `${action === 'clear' ? '清空' : '删除'}失败：${errorMessage(cause)}`; setConfirmationError(message); notify(message, 'error'); }
    finally { setBusyKey(null); }
  }

  function ask(action: Confirmation['action'], session: PanelSession) {
    setConfirmationError(''); setConfirmation({ action, session });
  }

  return <div className="page-stack sessions-page">
    <Card title="会话管理" description="按群聊与私聊管理回复规则、独立人格和记忆。" action={<BaseButton size="small" busy={loading} disabled={busyKey !== null} onClick={refresh}><Icon name="refresh" size={15}/>刷新</BaseButton>}>
      <div className="sessions-filters">
        <Input type="search" aria-label="搜索会话" placeholder="搜索名称、QQ / 群号或会话编号" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/>
        <Select aria-label="会话类型" value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setPage(1); }}><option value="all">全部类型</option><option value="group">群聊</option><option value="private">私聊</option></Select>
        <Select aria-label="启用状态" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></Select>
      </div>
      {error && <ErrorNotice message={`读取会话失败：${error}`} onRetry={refresh}/>}
      {actionError && <ErrorNotice message={actionError}/>}
      {!data && loading ? <EmptyState>正在读取会话…</EmptyState> : !sessions.length ? <EmptyState>{search || filter !== 'all' || status !== 'all' ? '没有匹配的会话。' : '还没有会话记录，机器人收到消息后会自动创建。'}</EmptyState> :
        <div className="sessions-list"><Table headers={['会话', '类型', '回复概率', '记忆 / 消息', '状态', '操作']}>
          {visibleSessions.map(session => <tr className="session-row" data-session-key={session.key} data-key={session.key} key={session.key}>
            <td className="session-identity"><div className="identity"><Avatar src={session.avatar} name={titleOf(session)}/><div className="session-identity-copy"><div className="identity-name session-name" title={titleOf(session)}>{titleOf(session)}</div><div className="identity-sub">{session.targetId}</div></div></div></td>
            <td className="session-type"><Badge tone={session.type === 'group' ? 'primary' : 'neutral'}>{session.type === 'group' ? '群聊' : '私聊'}</Badge></td>
            <td className="session-probabilities"><span>@ {percent(session.atProb)}</span><span>关键词 {percent(session.keywordProb)}</span><span>随机 {percent(session.randomProb)}</span></td>
            <td className="session-counts"><span>{session.memoryShared ? '互通记忆' : '独立记忆'}</span><span className="muted">{(data?.counts[session.key] || 0).toLocaleString()} 条消息</span></td>
            <td className="session-status"><span className="session-status-text">{session.enabled ? '已启用' : '已停用'}</span><Toggle label={`${titleOf(session)}：${session.enabled ? '已启用' : '已停用'}`} checked={session.enabled} disabled={busyKey !== null} onChange={enabled => { void toggleSession(session, enabled); }}/></td>
            <td className="session-actions"><BaseButton size="small" disabled={busyKey !== null} onClick={() => setEditing(session)}><Icon name="edit" size={14}/>编辑</BaseButton></td>
          </tr>)}
        </Table></div>}
      {sessions.length > 0 && <nav className="sessions-pagination" aria-label="会话分页">
        <span className="muted">共 {sessions.length} 个 · 每页 20 个</span>
        {pageCount > 1 && <div><BaseButton size="small" aria-label="上一页会话" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><Icon name="left" size={14}/>上一页</BaseButton><span aria-live="polite">{currentPage} / {pageCount}</span><BaseButton size="small" aria-label="下一页会话" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>下一页<Icon name="right" size={14}/></BaseButton></div>}
      </nav>}
    </Card>
    {editing && <SessionEditor key={editing.key} session={editing} messageCount={data?.counts[editing.key] || 0} memoryRevision={memoryRevision} notify={notify} blocked={busyKey !== null} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} onClear={() => ask('clear', data?.sessions.find(session => session.key === editing.key) || editing)} onDelete={() => ask('delete', editing)}/>}
    <Modal open={confirmation !== null} onClose={() => { if (busyKey === null) setConfirmation(null); }} title={confirmation?.action === 'clear' ? '清空会话记忆' : '删除会话'} description={confirmation?.action === 'clear'
      ? `确定清空「${confirmation.session.name || confirmation.session.key}」的记忆吗？此操作不可撤销，好感度不受影响。${confirmation.session.memoryShared ? '警告：该会话已启用记忆互通，所有使用互通记忆的会话会一起失去共享记忆！' : '只会清空这个会话的独立记忆。'}`
      : `确定删除「${confirmation?.session.name || confirmation?.session.key || ''}」吗？聊天记忆不会删除，只从会话列表移除；再次收到消息时可能重新创建。`}>
      {confirmationError && <ErrorNotice message={confirmationError}/>}
      <div className="modal-actions"><BaseButton disabled={busyKey !== null} onClick={() => setConfirmation(null)}>取消</BaseButton><BaseButton variant="danger" busy={busyKey !== null} onClick={() => { void confirmAction(); }}>确认{confirmation?.action === 'clear' ? '清空记忆' : '删除会话'}</BaseButton></div>
    </Modal>
  </div>;
}

const editorTabs = [{ id: 'basic', label: '基础设置' }, { id: 'replies', label: '回复规则' }, { id: 'proactive', label: '主动发言' }, { id: 'memory', label: '记忆管理' }] as const;
type EditorTab = typeof editorTabs[number]['id'];

function SessionEditor({ session, messageCount, memoryRevision, notify, blocked, onClose, onSaved, onClear, onDelete }: { session: PanelSession; messageCount: number; memoryRevision: number; notify: Notify; blocked: boolean; onClose: () => void; onSaved: () => void; onClear: () => void; onDelete: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(session));
  const [activeTab, setActiveTab] = useState<EditorTab>('basic');
  const [invalidField, setInvalidField] = useState<NumericField | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (invalidField) formRef.current?.querySelector<HTMLInputElement>(`[data-draft-field="${invalidField}"]`)?.focus();
  }, [validationAttempt, invalidField]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [messagesRequested, setMessagesRequested] = useState(false);
  const { data: messages, error: messagesError, loading: messagesLoading, refresh: refreshMessages } = usePolling<{ messages: StoredMessage[] }>(`/api/messages?key=${encodeURIComponent(session.key)}&limit=30&revision=${memoryRevision}`, 0, messagesRequested);
  const disabled = saving || blocked;
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(previous => ({ ...previous, [key]: value })); if (key === invalidField) setInvalidField(null); }
  function invalid(key: NumericField, message: string) {
    setActiveTab(key.startsWith('proactive') ? 'proactive' : 'replies');
    setInvalidField(key); setSaveError(message); setValidationAttempt(previous => previous + 1);
    // The next render reveals the correct panel before the effect focuses its field.
  }

  async function save() {
    if (disabled) return;
    setSaveError('');
    const numeric = {} as Record<NumericField, number>;
    const ranges: [NumericField, string, number, number, boolean][] = [
      ['atProb', '被 @ 回复概率', 0, 100, false], ['keywordProb', '关键词回复概率', 0, 100, false], ['randomProb', '随机插话概率', 0, 100, false],
      ['proactiveMinMinutes', '最短间隔', 1, 1440, true], ['proactiveMaxMinutes', '最长间隔', 1, 1440, true], ['proactiveMaxRounds', '最多连聊轮数', 1, 10, true],
    ];
    for (const [key, label, min, max, integer] of ranges) {
      const value = Number(draft[key]);
      if (!draft[key].trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        invalid(key, `${label}需填写 ${min}–${max} 之间的${integer ? '整数' : '数字'}`); return;
      }
      numeric[key] = value;
    }
    if (numeric.proactiveMinMinutes > numeric.proactiveMaxMinutes) { invalid('proactiveMaxMinutes', '最长间隔不能小于最短间隔'); return; }
    setInvalidField(null);
    const body: SessionPatch = { ...draft, ...numeric, name: draft.name.trim(), keywords: draft.keywords.trim(), atProb: numeric.atProb / 100, keywordProb: numeric.keywordProb / 100, randomProb: numeric.randomProb / 100 };
    setSaving(true);
    try { await api(sessionPath(session.key), { method: 'POST', body }); notify('会话设置已保存'); onSaved(); }
    catch (cause) { const message = `保存失败：${errorMessage(cause)}`; setSaveError(message); notify(message, 'error'); }
    finally { setSaving(false); }
  }

  return <Modal open className="session-editor-modal" onClose={() => { if (!disabled) onClose(); }} title="编辑会话" description={`${titleOf(session)} · ${session.key}`} wide>
    <form ref={formRef} className="session-editor-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="session-editor-tabs" role="tablist" aria-label="会话设置分类">
        {editorTabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`session-tab-${tab.id}`} aria-controls={`session-section-${tab.id}`} aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setActiveTab(tab.id)} onKeyDown={event => {
          let next = index;
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % editorTabs.length;
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + editorTabs.length - 1) % editorTabs.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = editorTabs.length - 1;
          else return;
          event.preventDefault(); setActiveTab(editorTabs[next].id);
          formRef.current?.querySelector<HTMLButtonElement>(`#session-tab-${editorTabs[next].id}`)?.focus();
        }}>{tab.label}</button>)}
      </div>
      <div className="session-editor-scroll">
        <section role="tabpanel" id="session-section-basic" aria-labelledby="session-tab-basic" hidden={activeTab !== 'basic'} className="session-editor-section">
          <div className="session-editor-summary"><Badge tone={session.type === 'group' ? 'primary' : 'neutral'}>{session.type === 'group' ? '群聊' : '私聊'}</Badge><span>{session.targetId}</span><span>{messageCount.toLocaleString()} 条消息</span></div>
          <fieldset disabled={disabled} className="session-fields">
            <Field label="备注名（只在面板显示）"><Input aria-label="备注名" maxLength={100} value={draft.name} onChange={event => update('name', event.target.value)}/></Field>
            <Field label="会话开关"><Toggle label="允许机器人在这里说话" checked={draft.enabled} onChange={value => update('enabled', value)}/></Field>
            <Field label="专属提示词" hint="留空表示跟随全局人格。" wide><Textarea aria-label="专属提示词" rows={3} maxLength={8000} value={draft.prompt} onChange={event => update('prompt', event.target.value)}/></Field>
          </fieldset>
        </section>
        <section role="tabpanel" id="session-section-replies" aria-labelledby="session-tab-replies" hidden={activeTab !== 'replies'} className="session-editor-section">
          <p className="session-section-hint">概率以百分比填写，0 表示不触发，100 表示总是回复。</p>
          <fieldset disabled={disabled} className="session-fields session-reply-fields">
            <Field label="被 @ 时回复概率（%）"><Input aria-label="被 @ 时回复概率" data-draft-field="atProb" aria-invalid={invalidField === 'atProb'} type="number" min={0} max={100} step="any" value={draft.atProb} onChange={event => update('atProb', event.target.value)}/></Field>
            <Field label="命中关键词回复概率（%）"><Input aria-label="命中关键词回复概率" data-draft-field="keywordProb" aria-invalid={invalidField === 'keywordProb'} type="number" min={0} max={100} step="any" value={draft.keywordProb} onChange={event => update('keywordProb', event.target.value)}/></Field>
            <Field label="随机插话概率（%）"><Input aria-label="随机插话概率" data-draft-field="randomProb" aria-invalid={invalidField === 'randomProb'} type="number" min={0} max={100} step="any" value={draft.randomProb} onChange={event => update('randomProb', event.target.value)}/></Field>
            <Field label="本会话触发关键词" hint="逗号分隔；留空使用全局词表，填写后仅使用本会话词表。" wide><Input aria-label="本会话触发关键词" maxLength={500} placeholder="助手, 管家" value={draft.keywords} onChange={event => update('keywords', event.target.value)}/></Field>
          </fieldset>
        </section>
        <section role="tabpanel" id="session-section-proactive" aria-labelledby="session-tab-proactive" hidden={activeTab !== 'proactive'} className="session-editor-section">
          <fieldset disabled={disabled} className="session-fields">
            <Field label="主动搭话" wide><Toggle label="会自己找话说" checked={draft.proactiveEnabled} onChange={value => update('proactiveEnabled', value)}/></Field>
            <Field label="最短间隔（分钟）"><Input aria-label="最短间隔" data-draft-field="proactiveMinMinutes" aria-invalid={invalidField === 'proactiveMinMinutes'} type="number" min={1} max={1440} step={1} value={draft.proactiveMinMinutes} onChange={event => update('proactiveMinMinutes', event.target.value)}/></Field>
            <Field label="最长间隔（分钟）"><Input aria-label="最长间隔" data-draft-field="proactiveMaxMinutes" aria-invalid={invalidField === 'proactiveMaxMinutes'} type="number" min={1} max={1440} step={1} value={draft.proactiveMaxMinutes} onChange={event => update('proactiveMaxMinutes', event.target.value)}/></Field>
            <Field label="最多连聊几轮"><Input aria-label="最多连聊几轮" data-draft-field="proactiveMaxRounds" aria-invalid={invalidField === 'proactiveMaxRounds'} type="number" min={1} max={10} step={1} value={draft.proactiveMaxRounds} onChange={event => update('proactiveMaxRounds', event.target.value)}/></Field>
          </fieldset>
        </section>
        <section role="tabpanel" id="session-section-memory" aria-labelledby="session-tab-memory" hidden={activeTab !== 'memory'} className="session-editor-section">
          <fieldset disabled={disabled} className="session-fields">
            <Field label="记忆模式" hint="启用后和其他互通会话共用记忆；更改需保存后才生效。" wide><Toggle label="记忆互通" checked={draft.memoryShared} onChange={value => update('memoryShared', value)}/></Field>
          </fieldset>
          <Card className="session-memory-card" title="最近记忆" description="读取已保存记忆模式下的最近 30 条消息。" action={<BaseButton size="small" busy={messagesRequested && messagesLoading} disabled={disabled} onClick={() => { if (messagesRequested) refreshMessages(); else setMessagesRequested(true); }}>读取最近消息</BaseButton>}>
            {messagesError && <ErrorNotice message={`读取消息失败：${messagesError}`} onRetry={refreshMessages}/>}
            {!messagesRequested ? <p className="muted text-xs">点击「读取最近消息」，查看机器人记得什么。</p> : messagesLoading ? <p className="muted text-xs">正在读取…</p> : !messages?.messages.length ? <EmptyState>这个会话还没有记忆。</EmptyState> : <div className="session-memory-messages" aria-live="polite">{messages.messages.map(message => <div key={message.id} className="text-xs"><div className="muted">{new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })} · {message.role === 'user' ? message.senderName || message.senderId || '某人' : message.role === 'assistant' ? '女仆' : '系统'}</div><p className="whitespace-pre-wrap break-words">{message.content}</p></div>)}</div>}
          </Card>
          <div className="session-danger-zone"><div><h3>危险操作</h3><p>按已保存的记忆模式清空；互通记忆会影响所有互通会话。删除仅移除会话配置。</p></div><div><BaseButton variant="danger" disabled={disabled} onClick={onClear}>清空会话记忆</BaseButton><BaseButton variant="danger" disabled={disabled} onClick={onDelete}>删除会话</BaseButton></div></div>
        </section>
      </div>
      <footer className="session-editor-footer">
        {saveError && <ErrorNotice message={saveError}/>}
        <div className="session-editor-actions"><BaseButton disabled={disabled} onClick={onClose}>取消</BaseButton><BaseButton type="submit" variant="primary" busy={saving} disabled={blocked}><Icon name="save" size={15}/>保存设置</BaseButton></div>
      </footer>
    </form>
  </Modal>;
}
