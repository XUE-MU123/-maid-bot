import { Fragment, useEffect, useId, useState } from 'react';
import { Avatar, Badge, BaseButton, Card, EmptyState, ErrorNotice, Icon, Input, Modal, Select, Table } from '../components/ui';
import { usePolling } from '../hooks/usePolling';
import { api, errorMessage } from '../lib/api';
import type { Notify, PanelFavor } from '../lib/types';
import '../styles/favors.css';

type FavorsData = { favors: PanelFavor[] };
type SavedFavor = { qq: string; score: number; favor: Omit<PanelFavor, 'avatar' | 'nickname'> | null };
type FavorSort = 'default' | 'score-desc' | 'score-asc';
const PAGE_SIZE = 20;
const memberName = (favor: PanelFavor) => favor.nickname || `QQ ${favor.qq}`;
// Explicit API roles take precedence; isMaster remains a fallback for older responses.
const masterRole = (favor: Pick<PanelFavor, 'isMaster' | 'masterRole'>) => favor.masterRole ?? (favor.isMaster ? 'primary' : 'none');
const isMaster = (favor: Pick<PanelFavor, 'isMaster' | 'masterRole'>) => masterRole(favor) !== 'none';
const masterLabel = (favor: PanelFavor) => masterRole(favor) === 'secondary' ? '二老大' : '老大';
const memberLevel = (favor: PanelFavor) => isMaster(favor) ? masterRole(favor) === 'secondary' ? '次席主权' : '至高主权' : favor.levelName || '—';
const memberScore = (favor: PanelFavor) => isMaster(favor) ? 999 : favor.score;

export function Favors({ notify }: { notify: Notify }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<FavorSort>('default');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  // 草稿独立于服务端数据和列表 DOM：轮询、翻页、关闭弹窗和调整窗口都不会丢失输入。
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<PanelFavor | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const editorId = useId();
  const detailsId = useId();
  const { data, error, loading, refresh, setData } = usePolling<FavorsData>('/api/favors', 5000, busy === null);
  const query = search.trim().toLowerCase();
  const favors = (data?.favors || []).filter(favor => !query || [String(favor.qq), favor.nickname, memberLevel(favor), isMaster(favor) ? masterLabel(favor) : '成员'].some(value => value?.toLowerCase().includes(query)));
  if (sort !== 'default') favors.sort((a, b) => sort === 'score-asc' ? memberScore(a) - memberScore(b) : memberScore(b) - memberScore(a));
  const pageCount = Math.max(1, Math.ceil(favors.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleFavors = favors.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // 同一次渲染即显示有效页；同步 state 避免数据随后增加时跳回旧页。
  useEffect(() => { setPage(previous => Math.min(previous, pageCount)); }, [pageCount]);
  const selected = editing ? data?.favors.find(favor => favor.qq === editing.qq) ?? editing : null;

  function openEditor(favor: PanelFavor) {
    if (isMaster(favor) || busy !== null) return;
    setDrafts(previous => previous[favor.qq] === undefined ? { ...previous, [favor.qq]: String(favor.score) } : previous);
    setEditing(favor);
  }

  async function save(favor: PanelFavor) {
    if (busy !== null || isMaster(favor)) return;
    const input = drafts[favor.qq] ?? String(favor.score);
    const score = Math.round(Number(input));
    if (!input.trim() || !Number.isFinite(score) || score < -9999 || score > 9999) {
      setErrors(previous => ({ ...previous, [favor.qq]: '请输入 -9999 到 9999 之间的有效分数' })); return;
    }
    setBusy(favor.qq); setErrors(previous => ({ ...previous, [favor.qq]: '' }));
    try {
      const result = await api<SavedFavor>('/api/favors', { method: 'POST', body: { qq: favor.qq, score } });
      // 仅显式保存才写入；响应同步到列表后清草稿，不会短暂跳回旧分数。
      setData(previous => previous && ({ ...previous, favors: previous.favors.map(item => item.qq === favor.qq ? { ...item, ...(result.favor || { score: result.score }) } : item) }));
      setDrafts(previous => { const next = { ...previous }; delete next[favor.qq]; return next; });
      setEditing(null);
      notify(`好感度已改为 ${result.favor && isMaster(result.favor) ? 999 : result.favor?.score ?? result.score} 分`); refresh();
    } catch (cause) {
      const message = `改分失败：${errorMessage(cause)}`;
      setErrors(previous => ({ ...previous, [favor.qq]: message })); notify(message, 'error');
    } finally { setBusy(null); }
  }

  const pagination = <nav className="favor-pagination" aria-label="好感度分页">
    <span className="favor-page-status" aria-live="polite">第 {currentPage} / {pageCount} 页 · {favors.length} 人 · 每页 {PAGE_SIZE} 人</span>
    <div className="favor-page-buttons">
      <BaseButton size="small" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><Icon name="left" size={14}/><span>上一页</span></BaseButton>
      <BaseButton size="small" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><span>下一页</span><Icon name="right" size={14}/></BaseButton>
    </div>
  </nav>;

  return <div className="page-stack">
    <Card className="favors-panel" title="好感度" description={data?.favors.some(isMaster) ? '点击成员查看详情 · 已生效的老大身份固定 999 分' : '点击成员查看详情 · 成员好感度可单独调整'} action={<BaseButton size="small" busy={loading} disabled={busy !== null} onClick={refresh}><Icon name="refresh" size={15}/>刷新</BaseButton>}>
      <div className="favor-toolbar">
        <Input type="search" aria-label="搜索好感度" placeholder="搜索 QQ、昵称或关系等级" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }}/>
        <Select aria-label="好感度排序" value={sort} onChange={event => { setSort(event.target.value as FavorSort); setPage(1); }}>
          <option value="default">默认排序</option><option value="score-desc">分数从高到低</option><option value="score-asc">分数从低到高</option>
        </Select>
      </div>
      {pagination}
      {error && <ErrorNotice message={`读取好感度失败：${error}`} onRetry={refresh}/>}
      {!data && loading ? <EmptyState>正在读取好感度…</EmptyState> : !favors.length ? <EmptyState>{query ? `没有匹配「${search.trim()}」的记录。` : '还没有好感度记录，机器人和成员聊天后会自动出现。'}</EmptyState> :
        <div className="favor-list"><Table headers={['成员', 'QQ / 关系等级', '当前分数', '操作']}>
          {visibleFavors.map(favor => {
            const name = memberName(favor);
            const isExpanded = expanded === favor.qq;
            const detailTarget = `${detailsId}-${favor.qq}`;
            return <Fragment key={favor.qq}>
              <tr className={`favor-row favor-summary${isExpanded ? ' is-expanded' : ''}`} data-qq={favor.qq} onClick={() => setExpanded(isExpanded ? null : favor.qq)}>
                <td className="favor-member"><BaseButton variant="ghost" className="favor-member-toggle" aria-label={`查看${name}的详情`} aria-expanded={isExpanded} aria-controls={detailTarget} onClick={event => { event.stopPropagation(); setExpanded(isExpanded ? null : favor.qq); }}>
                  <Avatar src={favor.avatar} name={name}/><span className="favor-name" title={name}>{name}</span><Icon name="down" size={13} className="favor-expand-icon"/>
                </BaseButton></td>
                <td className="favor-meta"><span className="favor-qq" title={`QQ ${favor.qq}`}>{favor.qq}</span><span className="favor-level" title={memberLevel(favor)}>{memberLevel(favor)}</span></td>
                <td className="favor-score">{isMaster(favor) ? <Badge tone="primary">999 <span>锁定</span></Badge> : <span>{favor.score.toLocaleString()}</span>}</td>
                <td className="favor-action">{isMaster(favor) ? <span className="favor-locked" title={`${masterLabel(favor)} · ${memberLevel(favor)} · 分数锁定，不可修改`}>不可修改</span> : <BaseButton size="small" className="favor-adjust" aria-label={`调整${name}的好感度`} disabled={busy !== null} onClick={event => { event.stopPropagation(); openEditor(favor); }}>调整</BaseButton>}</td>
              </tr>
              {isExpanded && <tr className="favor-details" id={detailTarget} data-qq={favor.qq}><td colSpan={4}>
                <dl className="favor-detail-grid">
                  <div className="favor-full-name"><dt>完整昵称</dt><dd>{name}</dd></div>
                  <div><dt>QQ</dt><dd>{favor.qq}</dd></div>
                  <div><dt>关系等级</dt><dd>{memberLevel(favor)}</dd></div>
                  <div><dt>今日增长</dt><dd>{favor.dailyGain > 0 ? '+' : ''}{favor.dailyGain.toLocaleString()}</dd></div>
                  <div><dt>身份</dt><dd>{isMaster(favor) ? `${masterLabel(favor)} · 999 分锁定，不可修改` : '成员'}</dd></div>
                  <div className="favor-updated"><dt>更新时间</dt><dd>{favor.updatedAt ? new Date(favor.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</dd></div>
                </dl>
              </td></tr>}
            </Fragment>;
          })}
        </Table></div>}
    </Card>
    <Modal open={selected !== null} onClose={() => { if (busy === null) setEditing(null); }} title="调整好感度" description="输入分数，按 Enter 或点击保存。关闭弹窗保留未保存草稿。">
      {selected && <form className="favor-editor" noValidate onSubmit={event => { event.preventDefault(); void save(selected); }}>
        <div className="favor-editor-member"><Avatar src={selected.avatar} name={memberName(selected)}/><div><strong>{memberName(selected)}</strong><span>QQ {selected.qq} · 当前 {memberScore(selected)} 分</span></div></div>
        {isMaster(selected) ? <p className="favor-editor-hint">{masterLabel(selected)} · {memberLevel(selected)} · 固定 999 分，不可修改</p> : <>
          <label htmlFor={editorId}>好感度分数</label>
          <Input autoFocus id={editorId} aria-label={`${memberName(selected)}的好感度分数`} aria-invalid={!!errors[selected.qq]} aria-describedby={`${editorId}-hint${errors[selected.qq] ? ` ${editorId}-error` : ''}`} type="number" min={-9999} max={9999} step={1} inputMode="numeric" value={drafts[selected.qq] ?? String(selected.score)} disabled={busy !== null}
            onChange={event => { const value = event.target.value; setDrafts(previous => ({ ...previous, [selected.qq]: value })); setErrors(previous => ({ ...previous, [selected.qq]: '' })); }}/>
          <p className="favor-editor-hint" id={`${editorId}-hint`}>范围 -9999 至 9999；仅保存后生效。</p>
          {errors[selected.qq] && <div id={`${editorId}-error`}><ErrorNotice message={errors[selected.qq]}/></div>}
        </>}
        <div className="modal-actions"><BaseButton disabled={busy !== null} onClick={() => setEditing(null)}>取消</BaseButton>{!isMaster(selected) && <BaseButton type="submit" variant="primary" busy={busy === selected.qq} disabled={busy !== null}>保存</BaseButton>}</div>
      </form>}
    </Modal>
  </div>;
}
