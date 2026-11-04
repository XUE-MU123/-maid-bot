import { useEffect, useRef, useState } from 'react';
import { Badge, BaseButton, Card, ConfirmButton, Field, Icon, Input, Select, Textarea, Toggle } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { Config, ConfigResult, ModelTest, Notify } from '../lib/types';
import { buildSettingsPatch, createSettingsDraft, editableKey, MasterRolesValidationError, mergeProfileDraft, mergeProfileSaved, settingsDirty, updateSettingsDraft, type SettingsPath } from '../lib/settings';

const sections = [{ id: 'model', label: '模型与接口', icon: 'bot' }, { id: 'media', label: '识图与出图', icon: 'sparkles' }, { id: 'persona', label: '人格与触发', icon: 'message' }, { id: 'owners', label: '老大身份', icon: 'users' }, { id: 'runtime', label: '运行与日志', icon: 'settings' }] as const;
type Section = typeof sections[number]['id'];

export function Settings({ config, onConfig, notify }: { config: Config; onConfig: (config: Config) => void; notify: Notify }) {
  const [saved, setSaved] = useState(config);
  const [draft, setDraft] = useState(() => createSettingsDraft(config));
  const [section, setSection] = useState<Section>('model');
  const [busy, setBusy] = useState('');
  const actionLock = useRef(false);
  const [models, setModels] = useState<string[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profileHint, setProfileHint] = useState('选择档案立即保存并生效；其余未保存的修改会保留。');
  const [testResult, setTestResult] = useState<ModelTest>();
  const [ownerError, setOwnerError] = useState('');
  const roles = draft.bot.masterRoles;
  const ownerMode = !roles.primaryId.trim() ? '无老大' : roles.dualEnabled && roles.secondaryId.trim() ? '双老大' : '单老大';
  const dirty = settingsDirty(saved, draft);
  // 地址/模型相同不代表密钥相同；只在唯一匹配时推断，显式选择后始终以 ID 为准。
  const [profileId, setProfileId] = useState(() => {
    const matches = config.llm.profiles.filter(p => p.baseUrl === config.llm.baseUrl && p.model === config.llm.model);
    return matches.length === 1 ? matches[0].id : '';
  });
  const selectedProfile = draft.llm.profiles.some(p => p.id === profileId) ? profileId : '';
  const selected = draft.llm.profiles.find(profile => profile.id === selectedProfile);

  // Parent may poll configuration. Never replace a locally edited or in-flight draft.
  useEffect(() => {
    if (dirty || busy) return;
    setSaved(config);
    setDraft(createSettingsDraft(config));
  }, [config, dirty, busy]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (path: SettingsPath, value: string | boolean) => {
    if (['llm.baseUrl', 'llm.model', 'llm.apiKey'].includes(path)) setProfileId('');
    if (path.startsWith('bot.masterRoles.')) setOwnerError('');
    setDraft(current => updateSettingsDraft(current, path, value));
  };
  // Do not let upstream error strings echo a freshly entered credential into the UI.
  const safeText = (text: string) => [draft.llm.apiKey, draft.llm.fallback.apiKey, draft.vision.apiKey].reduce((value, key) => key.trim() ? value.split(key.trim()).join('[已隐藏]') : value, text);
  async function run(name: string, task: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(name);
    try { await task(); } catch (error) { notify(safeText(errorMessage(error)), 'error'); }
    finally { actionLock.current = false; setBusy(''); }
  }
  async function save() {
    await run('save', async () => {
      let patch: ReturnType<typeof buildSettingsPatch>;
      try { patch = buildSettingsPatch(saved, draft); }
      catch (error) {
        if (error instanceof MasterRolesValidationError) { setSection('owners'); setOwnerError(error.message); }
        throw error;
      }
      setOwnerError('');
      if (!Object.keys(patch).length) { notify('没有可保存的变化；密钥留空或打码值不会提交'); return; }
      const result = await api<ConfigResult>('/api/config', { method: 'POST', body: patch });
      setSaved(result.config);
      setDraft(createSettingsDraft(result.config));
      setTestResult(undefined);
      setModels([]);
      onConfig(result.config);
      notify(`设置已保存${result.changed?.length ? `（${result.changed.length} 项）` : ''}${result.notes?.length ? `；${result.notes.join('；')}` : ''}`);
    });
  }
  async function profileAction(kind: 'apply' | 'save' | 'delete', id?: string) {
    await run(`profile-${kind}`, async () => {
      const apply = kind === 'apply';
      if (kind === 'save' && (!draft.llm.baseUrl.trim() || !draft.llm.model.trim())) throw new Error('请先填写主接口地址和模型名');
      if (kind === 'save' && !profileName.trim()) throw new Error('请为新档案填写名称');
      const key = editableKey(draft.llm.apiKey);
      const result = await api<ConfigResult>(kind === 'save' ? '/api/llm/profiles' : `/api/llm/profiles/${kind}`, {
        method: 'POST',
        body: kind === 'save' ? { name: profileName.trim(), baseUrl: draft.llm.baseUrl.trim(), model: draft.llm.model.trim(), ...(key ? { apiKey: key } : {}) } : { id },
      });
      // Applying changes only the three main connection values and profiles. Save/delete changes profiles only.
      setDraft(current => mergeProfileDraft(current, result.config, apply));
      setSaved(current => mergeProfileSaved(current, result.config, apply));
      onConfig(result.config);
      if (apply) { setProfileId(id ?? ''); setModels([]); setTestResult(undefined); }
      if (kind === 'delete') setProfileId('');
      if (kind === 'save') setProfileName('');
      setProfileHint(result.note ?? '档案已更新，其他未保存修改已保留。');
      notify(result.note ?? '档案已更新');
    });
  }
  const text = (label: string, path: SettingsPath, value: string, hint?: string, options: { secret?: boolean; wide?: boolean; multiline?: boolean; rows?: number } = {}) => (
    <Field key={path} label={label} hint={hint} wide={options.wide}>
      {options.multiline ? <Textarea aria-label={label} rows={options.rows ?? 4} value={value} onChange={event => update(path, event.target.value)}/> : <Input aria-label={label} type={options.secret ? 'password' : 'text'} autoComplete={options.secret ? 'new-password' : 'off'} spellCheck={false} value={value} onChange={event => update(path, event.target.value)} placeholder={options.secret ? '留空保留已保存密钥' : undefined}/>}
    </Field>
  );
  const number = (label: string, path: SettingsPath, value: string, min: number, max: number, step: number | 'any' = 1, hint?: string) => (
    <Field key={path} label={label} hint={hint}><Input aria-label={label} type="number" min={min} max={max} step={step} value={value} onChange={event => update(path, event.target.value)}/></Field>
  );
  const toggle = (label: string, path: SettingsPath, value: boolean) => <Toggle key={path} label={label} checked={value} onChange={checked => update(path, checked)}/>;

  return <div className="settings-stack">
    <div className="settings-actions flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Badge tone={dirty ? 'warning' : 'success'}>{dirty ? '有未保存修改' : '已与保存配置同步'}</Badge><span className="muted text-xs">档案操作立即生效，普通设置需保存。</span></div>
      <div className="flex gap-2">
        <ConfirmButton variant="secondary" disabled={!dirty || !!busy} title="放弃修改" message="将恢复最近从服务端收到的配置，未保存内容会丢失。" onConfirm={async () => { setSaved(config); setDraft(createSettingsDraft(config)); setOwnerError(''); }}>放弃修改</ConfirmButton>
        <BaseButton variant="primary" busy={busy === 'save'} disabled={!dirty || !!busy} onClick={() => void save()}><Icon name="save" size={16}/>保存设置</BaseButton>
      </div>
    </div>
    <nav className="section-tabs" aria-label="设置分类">{sections.map(item => <BaseButton key={item.id} variant={section === item.id ? 'primary' : 'ghost'} aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><Icon name={item.icon} size={16}/>{item.label}</BaseButton>)}</nav>
    {/* Semantic layout hooks: settings-stack (vertical sections), form-grid (responsive fields), section-tabs (category navigation). */}
    <fieldset disabled={!!busy} className="settings-stack border-0 p-0 m-0 min-w-0">
      {section === 'model' && <>
        <Card title="接口档案" description="选择立即应用；存档只保存地址、模型与密钥，不改变当前运行参数。">
          <div className="form-grid">
            <Field label="已保存档案" hint={profileHint} wide><Select aria-label="已保存档案（选择立即生效）" value={selectedProfile} onChange={event => { if (event.target.value) void profileAction('apply', event.target.value); }}><option value="">{draft.llm.profiles.length ? '手动配置 / 未匹配档案' : '尚无档案'}</option>{draft.llm.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</Select></Field>
            <Field label="新档案名称" hint="密钥留空沿用服务端当前主接口密钥；存档不会保存其他草稿设置。"><Input aria-label="新档案名称" value={profileName} onChange={event => setProfileName(event.target.value)} placeholder="例如：主站 / 备用站"/></Field>
            <div className="flex flex-wrap items-center gap-2"><BaseButton busy={busy === 'profile-save'} disabled={!!busy} onClick={() => void profileAction('save')}><Icon name="save" size={16}/>存为新档案</BaseButton><ConfirmButton disabled={!selected || !!busy} title="删除档案" message={`只删除「${selected?.name ?? ''}」存档，不影响正在使用的接口。`} onConfirm={() => profileAction('delete', selectedProfile)}><Icon name="trash" size={15}/>删除</ConfirmButton></div>
          </div>
        </Card>
        <Card title="主模型" description="OpenAI 兼容接口。密钥只接受新输入，不回显已保存密钥。">
          <div className="form-grid">
            {text('接口地址', 'llm.baseUrl', draft.llm.baseUrl, '填写完整 API 根地址，例如 https://example.com/v1')}
            {text('模型名称', 'llm.model', draft.llm.model)}
            {text('API Key', 'llm.apiKey', draft.llm.apiKey, saved.llm.apiKey ? '已保存密钥；留空表示保留，不显示或回传打码值。' : '尚未保存主接口密钥。', { secret: true })}
            <Field label="模型列表" hint="仅使用已保存的主接口地址和密钥，避免密钥进入 URL；修改接口后请先保存。"><div className="flex gap-2"><Select aria-label="从已保存接口模型列表选择" value={models.includes(draft.llm.model) ? draft.llm.model : ''} onChange={event => { if (event.target.value) update('llm.model', event.target.value); }}><option value="">{models.length ? '选择模型（仍需保存）' : '尚未拉取模型'}</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</Select><BaseButton busy={busy === 'models'} disabled={!!busy} onClick={() => void run('models', async () => { const result = await api<{ models: string[] }>('/api/llm/models'); setModels(result.models); notify(`已获取 ${result.models.length} 个模型（来自已保存接口）`); })}><Icon name="refresh" size={15}/>拉取</BaseButton></div></Field>
            {number('温度', 'llm.temperature', draft.llm.temperature, 0, 2, 0.1)}
            {number('最大输出 Tokens', 'llm.maxTokens', draft.llm.maxTokens, 1, 100000)}
            {number('请求超时（毫秒）', 'llm.timeoutMs', draft.llm.timeoutMs, 1000, 600000)}
            <Field label="本地测试模式">{toggle('启用 Mock 假回复', 'llm.mock', draft.llm.mock)}</Field>
          </div>
          <div className="settings-test-actions"><BaseButton busy={busy === 'test'} disabled={!!busy} onClick={() => void run('test', async () => { setTestResult(undefined); const result = await api<ModelTest>('/api/llm/test', { method: 'POST' }); setTestResult({ ...result, error: result.error ? safeText(result.error) : undefined, reply: result.reply ? safeText(result.reply) : undefined }); notify(result.ok ? '已保存配置连通正常' : `连通失败：${safeText(result.error ?? '未知原因')}`, result.ok ? 'success' : 'error'); })}><Icon name="wifi" size={16}/>测试已保存配置</BaseButton><span className="muted text-xs">测试不提交草稿，最长约两分钟；Mock 模式可能返回本地假回复。</span></div>
          {testResult && <div className="hint-box mt-3" role="status"><Badge tone={testResult.ok ? 'success' : 'danger'}>{testResult.ok ? '连通' : '失败'}</Badge> {testResult.model ?? saved.llm.model} · {testResult.ms} ms<p className="mt-2 whitespace-pre-wrap break-words">{testResult.ok ? testResult.reply : testResult.error}</p></div>}
        </Card>
        <Card title="Fallback 备用接口" description="主接口失败后使用。密钥留空保留现有值；不支持通过空输入清除密钥。"><div className="form-grid">{text('备用地址', 'llm.fallback.baseUrl', draft.llm.fallback.baseUrl)}{text('备用模型', 'llm.fallback.model', draft.llm.fallback.model)}{text('备用 API Key', 'llm.fallback.apiKey', draft.llm.fallback.apiKey, saved.llm.fallback.apiKey ? '已保存备用密钥，留空保留。' : '尚未保存备用密钥。', { secret: true })}</div></Card>
      </>}
      {section === 'media' && <>
        <Card title="识图" description="图片先交给视觉模型描述，再由主模型回复。"><div className="form-grid">
          <Field label="识图开关">{toggle('启用识图', 'vision.enabled', draft.vision.enabled)}</Field>
          {text('视觉模型', 'vision.model', draft.vision.model)}
          {text('识图接口地址', 'vision.baseUrl', draft.vision.baseUrl, '地址留空复用主接口。')}
          {text('识图 API Key', 'vision.apiKey', draft.vision.apiKey, saved.vision.apiKey ? '已有独立识图密钥，留空保留。' : '未设独立密钥时复用主接口密钥；留空不修改。', { secret: true })}
          {number('识图超时（毫秒）', 'vision.timeoutMs', draft.vision.timeoutMs, 5000, 300000)}
          {number('单图描述字数上限', 'vision.maxChars', draft.vision.maxChars, 40, 1000)}
        </div></Card>
        <Card title="回复出图" description="将回复中的表格或代码块渲染为图片，而非 AI 文生图。"><div className="form-grid">
          <Field label="渲染开关">{toggle('启用出图', 'render.enabled', draft.render.enabled)}</Field>
          <Field label="支持内容"><div className="settings-stack">{toggle('Markdown 表格', 'render.tables', draft.render.tables)}{toggle('SVG 代码块', 'render.svg', draft.render.svg)}{toggle('Mermaid 图表', 'render.mermaid', draft.render.mermaid)}</div></Field>
          <Field label="表格配色" hint="Mermaid 会将图表内容发送至第三方 mermaid.ink，请注意隐私。"><Select aria-label="表格配色" value={draft.render.tablePreset} onChange={event => update('render.tablePreset', event.target.value)}>{['yuzu-deep', 'yuzu-lace', 'yuzu-bubble', 'magazine', 'cyber', 'candy'].map(preset => <option key={preset} value={preset}>{preset}</option>)}</Select></Field>
          {number('单条消息最多图片数', 'render.maxImages', draft.render.maxImages, 0, 3)}
          {number('单张渲染超时（毫秒）', 'render.timeoutMs', draft.render.timeoutMs, 3000, 60000)}
        </div></Card>
      </>}
      {section === 'persona' && <>
        <Card title="人格提示词" description="保留原始换行与空白；可留空，不自动填入默认人格。"><div className="form-grid">
          {text('系统人格提示词', 'persona.systemPrompt', draft.persona.systemPrompt, undefined, { multiline: true, wide: true, rows: 8 })}
          {text('群聊主动发言提示词', 'persona.groupProactive', draft.persona.groupProactive, undefined, { multiline: true })}
          {text('私聊主动发言提示词', 'persona.privateProactive', draft.persona.privateProactive, undefined, { multiline: true })}
          <Field label="好感度上下文">{toggle('将好感度提示注入模型', 'persona.favorHint', draft.persona.favorHint)}</Field>
        </div></Card>
        <Card title="触发关键词与新会话概率" description="概率仅用于之后新建的会话，不覆盖已有会话的独立设置。"><div className="form-grid">
          {text('全局触发关键词', 'bot.triggerKeywords', draft.bot.triggerKeywords, '支持中英文逗号、空格或换行分隔，最多 50 个；空输入清空关键词。', { wide: true, multiline: true, rows: 2 })}
          {number('@ 触发概率（%）', 'defaults.atProb', draft.defaults.atProb, 0, 100, 'any')}
          {number('关键词触发概率（%）', 'defaults.keywordProb', draft.defaults.keywordProb, 0, 100, 'any')}
          {number('随机回复概率（%）', 'defaults.randomProb', draft.defaults.randomProb, 0, 100, 'any')}
        </div></Card>
      </>}
      {section === 'owners' && <Card className="master-settings-card" title="老大身份" description="第一老大的身份高于二老大；留空可设为无老大、无主人。修改后使用上方「保存设置」统一生效。">
        <div className="form-grid">
          {text('第一老大 QQ', 'bot.masterRoles.primaryId', roles.primaryId, '填写 5–15 位数字。要设为无老大，必须同时清空第一老大与二老大 QQ。')}
          <Field label="二老大开关" hint="默认关闭。关闭后可保留二老大账号，但该账号不再具有老大身份。">{toggle('启用二老大', 'bot.masterRoles.dualEnabled', roles.dualEnabled)}</Field>
          {roles.dualEnabled && text('二老大 QQ', 'bot.masterRoles.secondaryId', roles.secondaryId, '填写 5–15 位数字，不能与第一老大相同；需先填写第一老大 QQ。')}
          {!roles.dualEnabled && roles.secondaryId && <p className="hint-box field-wide">已保留二老大 QQ {roles.secondaryId}，当前不生效。若要设为无老大，请先开启「启用二老大」以清空此账号，再按需关闭。</p>}
          <div className="hint-box field-wide" role="status"><strong>保存后身份：{ownerMode}</strong><p>{ownerMode === '无老大' ? '无老大、无主人；不会从旧账号列表自动指定身份。' : ownerMode === '双老大' ? `第一老大 ${roles.primaryId.trim()} · 二老大 ${roles.secondaryId.trim()}` : `老大 ${roles.primaryId.trim()}`}</p><p>清空两个账号并保存会移除两人的老大身份，不会删除聊天记录或好感度数据。</p></div>
          {ownerError && <p className="text-danger field-wide" role="alert">{ownerError}</p>}
        </div>
      </Card>}
      {section === 'runtime' && <>
        <Card title="运行设置" description="面板端口修改需要重启机器人才能生效。"><div className="form-grid">
          <Field label="回复行为"><div className="settings-stack">{toggle('全局自动回复', 'bot.globalAutoReply', draft.bot.globalAutoReply)}{toggle('长回复自动分段', 'bot.splitReply', draft.bot.splitReply)}</div></Field>
          {number('历史消息条数', 'bot.historyLimit', draft.bot.historyLimit, 1, 200)}
          {number('上下文 Tokens 预算', 'bot.maxContextTokens', draft.bot.maxContextTokens, 500, 200000)}
          {number('面板端口', 'panel.port', draft.panel.port, 1, 65535, 1, '保存后不自动重启；请重启后用新端口访问。')}
        </div></Card>
        <Card title="日志" description="日志保留天数修改后需要重启；日志级别保存后生效。"><div className="form-grid">
          <Field label="日志级别"><Select aria-label="日志级别" value={draft.logging.level} onChange={event => update('logging.level', event.target.value)}>{['debug', 'info', 'warn', 'error'].map(level => <option key={level} value={level}>{level.toUpperCase()}</option>)}</Select></Field>
          {number('日志保留天数', 'logging.keepDays', draft.logging.keepDays, 1, 90)}
        </div></Card>
      </>}
    </fieldset>
    <p className="muted text-xs" role="status">{busy ? '正在处理，请稍候。' : dirty ? '有未保存的修改。刷新或离开页面前请先保存；切换档案只替换主接口三项。' : '设置来自面板真实 API，未读取本地配置文件。'}</p>
  </div>;
}
