import { useEffect, useId, useState } from 'react';
import { Avatar, Badge, BaseButton, Card, EmptyState, ErrorNotice, Icon, Input, Modal } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { api, errorMessage } from '../lib/api';
import type { IgnoreItem, Notify } from '../lib/types';

type IgnoresData = { ignores: IgnoreItem[] };
const itemKey = (item: IgnoreItem) => JSON.stringify([item.sessionKey, item.qq]);
const PAGE_SIZE = 20;

export function Ignores({ notify }: { notify: Notify }) {
  const [selected, setSelected] = useState<IgnoreItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const detailId = useId();
  const { data, error, loading, refresh, setData } = usePolling<IgnoresData>('/api/ignores', 5000, !busy);
  const query = search.trim().toLowerCase();
  const ignores = (data?.ignores || []).filter(item => !query || [item.qq, item.nickname, item.sessionName, item.sessionKey].some(value => value?.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(ignores.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = ignores.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  useEffect(() => { setPage(previous => Math.min(previous, pages)); }, [pages]);

  async function release() {
    if (!selected || busy) return;
    setBusy(true); setActionError('');
    try {
      await api('/api/ignores', { method: 'POST', body: { sessionKey: selected.sessionKey, qq: selected.qq, action: 'release' } });
      setData(previous => previous && ({ ...previous, ignores: previous.ignores.filter(item => itemKey(item) !== itemKey(selected)) }));
      notify(`已解除，${selected.nickname || selected.qq} 又可以找她说话了`);
      setSelected(null); refresh();
    } catch (cause) {
      const message = `解除失败：${errorMessage(cause)}`;
      setActionError(message); notify(message, 'error');
    } finally { setBusy(false); }
  }

  return <div className="page-stack">
    <Card className="ignores-panel" title="不理名单" action={<BaseButton size="small" busy={loading} disabled={busy} onClick={refresh}><Icon name="refresh" size={15}/>刷新</BaseButton>}>
      <div className="directory-toolbar"><Input aria-label="搜索不理名单" placeholder="搜索成员、QQ 或群名" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/><span className="muted text-xs">共 {data?.ignores.length ?? 0} 条{query ? ` · 匹配 ${ignores.length} 条` : ''}</span></div>
      {error && <ErrorNotice message={`读取不理名单失败：${error}`} onRetry={refresh}/>}
      {!data && loading ? <EmptyState>正在读取不理名单…</EmptyState> : !ignores.length ? <EmptyState>{query ? `没有匹配「${search.trim()}」的记录。` : '不理名单是空的，所有成员都可以正常互动。'}</EmptyState> :
        <ul className="ignore-list" aria-label="不理成员列表">{visible.map((item, index) => {
          const key = itemKey(item), name = item.nickname || `QQ ${item.qq}`, open = expanded === key;
          const id = `${detailId}-${index}`;
          return <li className="ignore-row" key={key}>
            <div className="ignore-summary"><button type="button" className="ignore-member" aria-label={`查看${name}的详情`} aria-expanded={open} aria-controls={id} onClick={() => setExpanded(open ? null : key)}><Avatar src={item.avatar} name={name}/><span className="ignore-member-copy"><span className="ignore-name" title={name}>{name}</span><span className="ignore-subline"><Badge tone={item.remainText === '永久' ? 'danger' : 'warning'}>{item.remainText || '—'}</Badge><span className="ignore-session" title={item.sessionName || item.sessionKey}>{item.sessionName || item.sessionKey}</span></span></span><Icon name={open ? 'down' : 'right'} size={14}/></button><BaseButton size="small" className="ignore-release" disabled={busy} aria-label={`解除${name}的不理`} onClick={() => { setActionError(''); setSelected(item); }}>解除</BaseButton></div>
            <div id={id} className="ignore-details" hidden={!open}><dl><div><dt>成员</dt><dd>{name}</dd></div><div><dt>QQ</dt><dd>{item.qq}</dd></div><div><dt>所在会话</dt><dd>{item.sessionName || item.sessionKey}{item.sessionName && item.sessionName !== item.sessionKey && <small>{item.sessionKey}</small>}</dd></div><div><dt>累计次数</dt><dd>第 {item.times || 1} 次</dd></div><div><dt>剩余时长</dt><dd>{item.remainText || '—'}</dd></div><div><dt>解除时间</dt><dd>{item.untilText || '—'}</dd></div></dl></div>
          </li>;
        })}</ul>}
      <nav className="directory-pagination" aria-label="不理名单分页"><span>共 {ignores.length} 条 · 第 {currentPage} / {pages} 页</span><div><BaseButton size="small" aria-label="不理名单上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><Icon name="left" size={14}/>上一页</BaseButton><BaseButton size="small" aria-label="不理名单下一页" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>下一页<Icon name="right" size={14}/></BaseButton></div></nav>
    </Card>
    <Modal open={selected !== null} onClose={() => { if (!busy) setSelected(null); }} title="解除不理" description={`确定解除「${selected?.nickname || selected?.qq || ''}」在「${selected?.sessionName || selected?.sessionKey || ''}」的不理状态吗？解除后机器人将恢复回应该成员。`}>
      {actionError && <ErrorNotice message={actionError}/>}
      <div className="modal-actions"><BaseButton disabled={busy} onClick={() => setSelected(null)}>取消</BaseButton><BaseButton variant="primary" busy={busy} onClick={() => { void release(); }}>确认解除</BaseButton></div>
    </Modal>
  </div>;
}
