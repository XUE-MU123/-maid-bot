// 女仆大总管控制面板前端：纯原生 JS，无框架无构建，每 3 秒轮询一次。
// 老大只要会点鼠标就能用：所有失败都会弹红色提示，成功弹绿色提示。

'use strict';

// ---------- 小工具 ----------

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtNum(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? v.toLocaleString('zh-CN') : '0';
}

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';
  return s + ' 秒';
}

function fmtTime(ms) {
  const n = Number(ms) || 0;
  if (!n) return '-';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0%';
  return (Math.round(n * 1000) / 10).toString().replace(/\.0$/, '') + '%';
}

function numVal(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const raw = String(el.value === null || el.value === undefined ? '' : el.value).trim();
  if (raw === '') return fallback; // 空着就按默认值，别当成 0
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- Toast ----------

function toast(message, type) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'bad' ? 'bad' : 'ok');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------- 弹窗 ----------

const state = {
  tab: 'overview',
  overview: null,
  config: null,
  sessions: [],
  counts: {},
  favors: [],
  ignores: [],
  settingsDirty: false,
  modalOpen: false,
  tickBusy: false,
};

function showModal(inner) {
  state.modalOpen = true;
  const root = $('#modal-root');
  root.innerHTML = inner;
  root.classList.remove('hidden');
  // 点遮罩关掉（点到白框里面不算）
  root.onclick = (e) => { if (e.target === root) closeModal(); };
  return root;
}

function closeModal() {
  // 如果有正在等确认的弹窗，先把它当成「取消」，否则调用方会一直等下去
  const cancel = state.modalCancel;
  state.modalCancel = null;
  if (cancel) {
    try { cancel(); } catch (err) { /* 忽略 */ }
  }
  state.modalOpen = false;
  const root = $('#modal-root');
  if (!root) return;
  root.classList.add('hidden');
  root.innerHTML = '';
  root.onclick = null;
}

function askConfirm(title, text, okText) {
  return new Promise((resolve) => {
    const root = showModal(
      '<div class="modal">' +
        '<h3>' + esc(title) + '</h3>' +
        '<p>' + esc(text) + '</p>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="cancel">取消</button>' +
          '<button class="btn btn-danger" data-act="ok">' + esc(okText || '确定') + '</button>' +
        '</div>' +
      '</div>'
    );
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      state.modalCancel = null;
      closeModal();
      resolve(v);
    };
    $('[data-act="cancel"]', root).onclick = () => finish(false);
    $('[data-act="ok"]', root).onclick = () => finish(true);
    // 点遮罩 / 按 Esc 都当取消，promise 一定会结束
    state.modalCancel = () => finish(false);
  });
}

/** 抽屉里用的「点两次才生效」按钮，避免误删 */
function armButton(btn, label, action) {
  let armed = false;
  let timer = 0;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.dataset.old = btn.textContent;
      btn.textContent = '再点一次确认' + label;
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = btn.dataset.old;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false;
    btn.disabled = true;
    try {
      await action();
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- 请求封装 ----------

async function api(path, opts) {
  const init = { method: (opts && opts.method) || 'GET' };
  if (opts && opts.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new Error('连不上面板服务，确认机器人还在运行');
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (err) { data = null; }
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('请求失败（HTTP ' + res.status + '）');
    throw new Error(msg);
  }
  if (data === null) throw new Error('面板返回了看不懂的内容');
  return data;
}

// ---------- 顶栏 / 总览 ----------

function applyReplyButton() {
  const btn = $('#toggle-reply');
  if (!btn) return;
  const on = !!(state.config && state.config.bot && state.config.bot.globalAutoReply);
  btn.textContent = '全局回复：' + (on ? '开' : '关');
  btn.classList.remove('btn-primary');
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
}

function applyOverview(d) {
  const st = d.status || {};
  const online = !!st.onebotConnected;

  const lamp = $('#lamp');
  lamp.className = 'lamp ' + (online ? 'online' : 'offline');
  $('#lamp-text').textContent = online ? 'OneBot 在线' : 'OneBot 离线';
  $('#self-id').textContent = st.selfId || '-';
  $('#uptime').textContent = fmtDur(d.uptimeSec);
  $('#version').textContent = d.version || '-';

  const conn = $('#ov-conn');
  conn.textContent = online ? '在线' : '离线';
  conn.className = 'stat-value ' + (online ? 'ok' : 'bad');
  $('#ov-conn-hint').textContent = online
    ? 'WebSocket 已连上 SnowLuma'
    : (st.lastError ? '上次错误：' + st.lastError : '还在等 SnowLuma 连上来…');

  $('#ov-messages').textContent = fmtNum(d.stats && d.stats.messages);
  $('#ov-sessions').textContent = fmtNum(d.stats && d.stats.sessions);
  $('#ov-favors').textContent = fmtNum(d.favorCount);
  $('#ov-reconnects').textContent = fmtNum(st.reconnects);

  const usage = d.usage || {};
  const total = Number(usage.totalPrompt || 0) + Number(usage.totalCompletion || 0);
  $('#ov-tokens').textContent = fmtNum(total);
  $('#ov-token-detail').textContent = '输入 ' + fmtNum(usage.totalPrompt) + ' / 输出 ' + fmtNum(usage.totalCompletion);

  $('#ov-last-error').textContent = st.lastError || '无';

  applyReplyButton();
}

async function refreshOverview() {
  try {
    const d = await api('/api/overview');
    state.overview = d;
    applyOverview(d);
    return true;
  } catch (err) {
    const lamp = $('#lamp');
    if (lamp) {
      lamp.className = 'lamp offline';
      $('#lamp-text').textContent = '面板未响应';
    }
    return false;
  }
}

let ovLogOffset = 0;

function colorize(line) {
  let cls = '';
  if (line.indexOf('柚子回复') >= 0) cls = 'lg-reply';
  else if (line.indexOf('判断为不插嘴') >= 0) cls = 'lg-skip';
  else if (line.indexOf('[ERROR') >= 0) cls = 'lg-error';
  else if (line.indexOf('[WARN') >= 0) cls = 'lg-warn';
  else if (line.indexOf('[DEBUG') >= 0) cls = 'lg-debug';
  return '<span class="' + cls + '">' + esc(line) + '</span>';
}

async function refreshOverviewLog() {
  const box = $('#ov-log');
  if (!box) return;
  try {
    const d = await api('/api/logs?limit=18');
    const lines = d.lines || [];
    if (!lines.length) {
      box.innerHTML = '<span class="muted">还没有日志，等它干点活吧。</span>';
      return;
    }
    box.innerHTML = lines.map(colorize).join('\n');
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    box.innerHTML = '<span class="muted">读取日志失败：' + esc(err.message) + '</span>';
  }
}

async function refreshExtras() {
  const groupsEl = $('#ov-groups');
  const friendsEl = $('#ov-friends');
  try {
    const [g, f] = await Promise.all([api('/api/groups'), api('/api/friends')]);
    const gs = g.groups || [];
    const fs = f.friends || [];
    groupsEl.textContent = g.note ? '未连接' : gs.length + ' 个';
    friendsEl.textContent = f.note ? '未连接' : fs.length + ' 个';
  } catch (err) {
    groupsEl.textContent = '取不到';
    friendsEl.textContent = '取不到';
  }
}

// ---------- 会话 ----------

// 头像：QQ 的公开 CDN 直接给浏览器加载，加载不出来就退回首字母底
function avatarHtml(url, name) {
  const initial = esc(String(name || '?').replace(/^\s+/, '').slice(0, 1) || '?');
  if (!url) return '<span class="avatar-wrap"><span class="avatar-fallback">' + initial + '</span></span>';
  return '<span class="avatar-wrap">' +
    '<span class="avatar-fallback">' + initial + '</span>' +
    '<img class="avatar" src="' + esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
    'onerror="this.remove()"></span>';
}

function renderSessions() {
  const tbody = $('#sessions-body');
  const empty = $('#sessions-empty');
  const table = $('#tbl-sessions');
  if (!tbody) return;

  if (!state.sessions.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');

  const rowOf = (s) => {
    const typeText = s.type === 'group' ? '群聊' : '私聊';
    const typeClass = s.type === 'group' ? 'group' : 'private';
    const title = s.type === 'group' ? (s.name || '（未命名）') : (s.nickname || s.name || '（未命名）');
    return '' +
      '<tr>' +
        '<td><div class="sess-cell">' + avatarHtml(s.avatar, title) +
          '<div><div class="sess-name">' + esc(title) + '</div>' +
          '<span class="sess-key">' + esc(s.targetId) + ' · ' + esc(s.key) + '</span></div></div></td>' +
        '<td><span class="tag ' + typeClass + '">' + typeText + '</span></td>' +
        '<td><label class="switch"><input type="checkbox" data-toggle="' + esc(s.key) + '"' +
          (s.enabled ? ' checked' : '') + '><span class="switch-track"></span></label></td>' +
        '<td class="small">被@ ' + pct(s.atProb) + '<br>关键词 ' + pct(s.keywordProb) +
          (s.keywords ? '<br><span class="kw-hint" title="' + esc(s.keywords) + '">词：' + esc(s.keywords.slice(0, 12)) + '</span>' : '') +
          '<br>随机 ' + pct(s.randomProb) + '</td>' +
        '<td>' + (s.memoryShared ? '<span class="tag">互通</span>' : '<span class="muted">独立</span>') + '</td>' +
        '<td class="num">' + fmtNum(state.counts[s.key] || 0) + '</td>' +
        '<td class="actions">' +
          '<button class="btn btn-sm" data-edit="' + esc(s.key) + '">编辑</button> ' +
          '<button class="btn btn-sm btn-danger" data-del="' + esc(s.key) + '">删除</button>' +
        '</td>' +
      '</tr>';
  };

  const groups = state.sessions.filter((s) => s.type === 'group');
  const privates = state.sessions.filter((s) => s.type !== 'group');
  const sep = (label, n) => '<tr class="sess-sep"><td colspan="7">' +
    esc(label) + ' <span class="muted">· ' + n + ' 个</span></td></tr>';
  const parts = [];
  parts.push(sep('群聊', groups.length));
  parts.push(groups.length ? groups.map(rowOf).join('') : '<tr><td colspan="7" class="muted pad">还没有群聊记录</td></tr>');
  parts.push(sep('私聊', privates.length));
  parts.push(privates.length ? privates.map(rowOf).join('') : '<tr><td colspan="7" class="muted pad">还没有私聊记录</td></tr>');
  tbody.innerHTML = parts.join('');
}

async function refreshSessions() {
  try {
    const d = await api('/api/sessions');
    state.sessions = d.sessions || [];
    state.counts = d.counts || {};
    renderSessions();
  } catch (err) {
    toast('读取会话失败：' + err.message, 'bad');
  }
}

async function toggleSession(key, enabled) {
  try {
    await api('/api/sessions/' + encodeURIComponent(key), { method: 'POST', body: { enabled: enabled } });
    toast('会话已' + (enabled ? '开启' : '关闭'));
    await refreshSessions();
  } catch (err) {
    toast('保存失败：' + err.message, 'bad');
    await refreshSessions();
  }
}

function fmtMessages(list) {
  if (!list || !list.length) return '这个会话还没有记忆。';
  return list.map((m) => {
    const who = m.role === 'user'
      ? (m.senderName || m.senderId || '某人')
      : (m.role === 'assistant' ? '女仆' : '系统');
    const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 220);
    return '[' + fmtTime(m.createdAt) + '] ' + who + '：' + text;
  }).join('\n');
}

function openSessionEditor(key) {
  const s = state.sessions.find((x) => x.key === key);
  if (!s) {
    toast('这个会话已经不在了，刷新一下', 'bad');
    return;
  }

  const root = showModal(
    '<div class="drawer">' +
      '<h3>编辑会话</h3>' +
      '<div class="sub">' + esc(s.name || '未命名') + ' · ' + esc(s.key) + '</div>' +

      '<div class="form-grid">' +
        '<label class="field"><span>备注名（只在面板显示）</span>' +
          '<input type="text" id="se-name" maxlength="60" value="' + esc(s.name) + '"></label>' +
        '<label class="field checkbox"><input type="checkbox" id="se-enabled"' + (s.enabled ? ' checked' : '') + '>' +
          '<span>允许机器人在这里说话</span></label>' +
        '<label class="field col-span"><span>专属提示词（留空表示跟随全局人格）</span>' +
          '<textarea id="se-prompt" rows="4" placeholder="例如：这是我们宿舍的摸鱼群，说话随意一点，别太正式">' + esc(s.prompt) + '</textarea></label>' +
        '<label class="field"><span>被 @ 时回复概率（%）</span>' +
          '<input type="number" id="se-at" min="0" max="100" step="any" value="' + Math.round(s.atProb * 100) + '"></label>' +
        '<label class="field"><span>命中关键词时回复概率（%）</span>' +
          '<input type="number" id="se-kw" min="0" max="100" step="any" value="' + Math.round(s.keywordProb * 100) + '"></label>' +
        '<label class="field col-span"><span>本会话触发关键词（逗号分隔，留空 = 用全局词表）</span>' +
          '<input type="text" id="se-keywords" maxlength="300" placeholder="例如：女仆, 管家, 柚子" value="' + esc(s.keywords || '') + '">' +
          '<span class="muted small">只在这个会话生效；填了就**不再**用全局词表</span></label>' +
        '<label class="field"><span>随机插话概率（%）</span>' +
          '<input type="number" id="se-rand" min="0" max="100" step="any" value="' + Math.round(s.randomProb * 100) + '"></label>' +
        '<label class="field checkbox col-span"><input type="checkbox" id="se-shared"' + (s.memoryShared ? ' checked' : '') + '>' +
          '<span>记忆互通（和其他会话共用同一份记忆）</span></label>' +
      '</div>' +

      '<div class="drawer-section">' +
        '<div class="card-head"><h2>主动搭话</h2>' +
          '<label class="field checkbox"><input type="checkbox" id="se-proactive"' + (s.proactiveEnabled ? ' checked' : '') + '>' +
          '<span>会自己找话说</span></label></div>' +
        '<div class="form-grid three">' +
          '<label class="field"><span>最短间隔（分钟）</span>' +
            '<input type="number" id="se-pmin" min="1" max="1440" value="' + s.proactiveMinMinutes + '"></label>' +
          '<label class="field"><span>最长间隔（分钟）</span>' +
            '<input type="number" id="se-pmax" min="1" max="1440" value="' + s.proactiveMaxMinutes + '"></label>' +
          '<label class="field"><span>最多连聊几轮</span>' +
            '<input type="number" id="se-prounds" min="1" max="10" value="' + s.proactiveMaxRounds + '"></label>' +
        '</div>' +
      '</div>' +

      '<div class="drawer-section">' +
        '<div class="card-head"><h2>记忆</h2>' +
          '<button class="btn btn-sm" id="se-load-msgs">读取最近消息</button></div>' +
        '<pre class="logbox small" id="se-msgs">点「读取最近消息」，看看机器人记得什么。</pre>' +
      '</div>' +

      '<div class="danger-zone">' +
        '<div class="row-gap">' +
          '<button class="btn btn-sm" id="se-clear-mem">清空这个会话的记忆</button> ' +
          '<button class="btn btn-sm btn-danger" id="se-del">删除这个会话</button>' +
        '</div>' +
        '<button class="btn btn-primary" id="se-save">保存</button>' +
      '</div>' +
    '</div>'
  );

  $('#se-load-msgs', root).onclick = async () => {
    const box = $('#se-msgs', root);
    box.textContent = '读取中…';
    try {
      const d = await api('/api/messages?key=' + encodeURIComponent(s.key) + '&limit=30');
      box.textContent = fmtMessages(d.messages);
    } catch (err) {
      box.textContent = '读取失败：' + err.message;
    }
  };

  armButton($('#se-clear-mem', root), '清空记忆', async () => {
    try {
      await api('/api/memory/clear', { method: 'POST', body: { key: s.key } });
      toast(s.memoryShared ? '记忆已清空（互通记忆会一起清掉）' : '这个会话的记忆已清空');
      $('#se-msgs', root).textContent = '这个会话还没有记忆。';
      await refreshSessions();
    } catch (err) {
      toast('清空失败：' + err.message, 'bad');
    }
  });

  armButton($('#se-del', root), '删除会话', async () => {
    try {
      await api('/api/sessions/' + encodeURIComponent(s.key), { method: 'DELETE' });
      toast('会话已删除');
      closeModal();
      await refreshSessions();
    } catch (err) {
      toast('删除失败：' + err.message, 'bad');
    }
  });

  $('#se-save', root).onclick = async () => {
    const body = {
      name: $('#se-name', root).value.trim(),
      enabled: $('#se-enabled', root).checked,
      prompt: $('#se-prompt', root).value,
      memoryShared: $('#se-shared', root).checked,
      atProb: numVal('se-at', 100) / 100,
      keywordProb: numVal('se-kw', 100) / 100,
      keywords: ($('#se-keywords', root) && $('#se-keywords', root).value.trim()) || '',
      randomProb: numVal('se-rand', 0) / 100,
      proactiveEnabled: $('#se-proactive', root).checked,
      proactiveMinMinutes: numVal('se-pmin', 30),
      proactiveMaxMinutes: numVal('se-pmax', 90),
      proactiveMaxRounds: numVal('se-prounds', 2),
    };
    const btn = $('#se-save', root);
    btn.disabled = true;
    try {
      await api('/api/sessions/' + encodeURIComponent(s.key), { method: 'POST', body: body });
      toast('会话设置已保存');
      closeModal();
      await refreshSessions();
    } catch (err) {
      toast('保存失败：' + err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  };
}

// ---------- 好感度 ----------

function renderFavors() {
  const tbody = $('#favors-body');
  const empty = $('#favors-empty');
  const table = $('#tbl-favors');
  if (!tbody) return;

  const kw = ($('#favor-search').value || '').trim().toLowerCase();
  const list = kw
    ? state.favors.filter((f) => String(f.qq).includes(kw) || String(f.nickname || '').toLowerCase().includes(kw) || String(f.levelName || '').toLowerCase().includes(kw))
    : state.favors;

  if (!list.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    empty.innerHTML = kw
      ? '没有匹配「' + esc(kw) + '」的记录。'
      : '还没有好感度记录。<br><span class="muted">等机器人和人聊过天，这里就会自动出现。</span>';
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');

  tbody.innerHTML = list.map((f) => {
    const qq = String(f.qq);
    const nick = f.nickname || '';
    const title = nick || ('QQ ' + qq);
    const scoreText = f.isMaster ? '999（锁定）' : fmtNum(f.score);
    const editor = f.isMaster
      ? '<span class="muted small">老大锁定，改不了</span>'
      : '<div class="fav-edit">' +
          '<input class="fav-input" type="number" step="1" inputmode="numeric" placeholder="分数" ' +
            'value="' + Number(f.score) + '" data-score-input="' + esc(qq) + '">' +
          '<button class="btn btn-sm btn-primary" data-save="' + esc(qq) + '">保存</button>' +
        '</div>';
    return '' +
      '<tr>' +
        '<td><div class="sess-cell">' + avatarHtml(f.avatar, title) +
          '<div><div class="sess-name">' + esc(title) + '</div>' +
          '<span class="sess-key">' + esc(qq) + '</span></div></div></td>' +
        '<td class="num ' + (f.isMaster ? 'fav-score-master' : '') + '">' + scoreText + '</td>' +
        '<td class="fav-level">' + esc(f.levelName || '-') + '</td>' +
        '<td>' + (f.isMaster ? '<span class="tag lock">老大</span>' : '<span class="muted">成员</span>') + '</td>' +
        '<td class="num">' + (Number(f.dailyGain) ? '+' + fmtNum(f.dailyGain) : '0') + '</td>' +
        '<td class="muted small">' + fmtTime(f.updatedAt) + '</td>' +
        '<td class="actions">' + editor + '</td>' +
      '</tr>';
  }).join('');
}

async function refreshFavors() {
  try {
    const d = await api('/api/favors');
    state.favors = d.favors || [];
    renderFavors();
  } catch (err) {
    toast('读取好感度失败：' + err.message, 'bad');
  }
}

async function saveFavorQuick(qq, btn) {
  const input = document.querySelector('[data-score-input="' + qq + '"]');
  if (!input) return;
  const score = Math.round(Number(input.value));
  if (!Number.isFinite(score)) { toast('分数要填数字', 'bad'); return; }
  if (btn) btn.disabled = true;
  try {
    await api('/api/favors', { method: 'POST', body: { qq: qq, score: score } });
    toast('好感度已改为 ' + score + ' 分');
    await refreshFavors();
  } catch (err) {
    toast('改分失败：' + err.message, 'bad');
    if (btn) btn.disabled = false;
  }
}

function openFavorEditor(qq) {
  const f = state.favors.find((x) => String(x.qq) === String(qq));
  if (!f) return;
  const root = showModal(
    '<div class="modal">' +
      '<h3>改好感度</h3>' +
      '<p>QQ ' + esc(f.qq) + ' · 当前 ' + (f.isMaster ? '999（老大锁定）' : f.score) + ' 分 · ' + esc(f.levelName || '') + '</p>' +
      '<label class="field"><span>新的分数（0 最生疏，999 最亲）</span>' +
        '<input type="number" id="fv-score" min="0" max="999" step="1" value="' + (f.isMaster ? 999 : f.score) + '"></label>' +
      '<div class="modal-foot" style="margin-top:16px">' +
        '<button class="btn" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">保存</button>' +
      '</div>' +
    '</div>'
  );
  $('[data-act="cancel"]', root).onclick = closeModal;
  $('[data-act="ok"]', root).onclick = async () => {
    const score = numVal('fv-score', f.score);
    const btn = $('[data-act="ok"]', root);
    btn.disabled = true;
    try {
      await api('/api/favors', { method: 'POST', body: { qq: f.qq, score: score } });
      toast('好感度已改为 ' + score + ' 分');
      closeModal();
      await refreshFavors();
    } catch (err) {
      toast('改分失败：' + err.message, 'bad');
      btn.disabled = false;
    }
  };
}

// ---------- 不理名单 ----------

function renderIgnores() {
  const tbody = $('#ignores-body');
  const empty = $('#ignores-empty');
  const table = $('#tbl-ignores');
  if (!tbody) return;
  const list = state.ignores || [];
  if (!list.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');
  tbody.innerHTML = list.map((it) => {
    const nick = it.nickname || '';
    const title = nick || ('QQ ' + it.qq);
    return '' +
      '<tr>' +
        '<td><div class="sess-cell">' + avatarHtml(it.avatar || '', title) +
          '<div><div class="sess-name">' + esc(title) + '</div></div></div></td>' +
        '<td class="muted small">' + esc(String(it.qq)) + '</td>' +
        '<td class="num">第 ' + esc(String(it.times || 1)) + ' 次</td>' +
        '<td>' + esc(it.sessionName || it.sessionKey) + '</td>' +
        '<td class="num">' + esc(it.remainText || '') + '</td>' +
        '<td class="muted small">' + esc(it.untilText || '') + '</td>' +
        '<td class="actions"><button class="btn btn-sm" data-release="' + esc(it.sessionKey) + '|' + esc(it.qq) + '">解除</button></td>' +
      '</tr>';
  }).join('');
}

async function refreshIgnores() {
  try {
    const d = await api('/api/ignores');
    state.ignores = d.ignores || [];
    renderIgnores();
  } catch (err) {
    toast('读取不理名单失败：' + err.message, 'bad');
  }
}

async function releaseIgnore(key) {
  const [sessionKey, qq] = String(key).split('|');
  try {
    await api('/api/ignores', { method: 'POST', body: { sessionKey: sessionKey, qq: qq, action: 'release' } });
    toast('已解除，' + qq + ' 又可以找她说话了');
    await refreshIgnores();
  } catch (err) {
    toast('解除失败：' + err.message, 'bad');
  }
}

// ---------- 设置 ----------

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v === undefined || v === null ? '' : v;
}

function setChecked(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}

function fillSettings(cfg) {
  if (!cfg) return;
  const llm = cfg.llm || {};
  const fb = llm.fallback || {};
  const bot = cfg.bot || {};
  const persona = cfg.persona || {};
  const defaults = cfg.defaults || {};

  setVal('cfg-base-url', llm.baseUrl);
  setVal('cfg-model', llm.model);
  setVal('cfg-temperature', llm.temperature);
  setVal('cfg-max-tokens', llm.maxTokens);
  setVal('cfg-timeout', llm.timeoutMs);
  setChecked('cfg-mock', llm.mock);

  const apiKeyInput = $('#cfg-api-key');
  if (apiKeyInput) {
    apiKeyInput.value = '';
    apiKeyInput.placeholder = llm.apiKey
      ? '已保存：' + llm.apiKey + '（留空表示不改）'
      : '还没填。不填的话机器人只会用本地假回复';
  }

  setVal('cfg-fallback-base', fb.baseUrl);
  setVal('cfg-fallback-model', fb.model);
  const fbKeyInput = $('#cfg-fallback-key');
  if (fbKeyInput) {
    fbKeyInput.value = '';
    fbKeyInput.placeholder = fb.apiKey
      ? '已保存：' + fb.apiKey + '（留空表示不改）'
      : '没有备用接口就留空';
  }

  setVal('cfg-system-prompt', persona.systemPrompt);
  setVal('cfg-group-proactive', persona.groupProactive);
  setVal('cfg-private-proactive', persona.privateProactive);
  setChecked('cfg-favor-hint', persona.favorHint);

  setChecked('cfg-auto-reply', bot.globalAutoReply);
  setChecked('cfg-split-reply', bot.splitReply);
  const vision = cfg.vision || {};
  setChecked('cfg-vision-enabled', vision.enabled !== false);
  setVal('cfg-vision-model', vision.model || 'grok-4.6');
  setVal('cfg-vision-timeout', vision.timeoutMs || 90000);
  setVal('cfg-vision-base', vision.baseUrl || '');
  setVal('cfg-vision-chars', vision.maxChars || 240);
  setVal('cfg-vision-key', '');
  const render = cfg.render || {};
  setChecked('cfg-render-enabled', render.enabled !== false);
  setChecked('cfg-render-tables', render.tables !== false);
  setChecked('cfg-render-svg', render.svg !== false);
  setChecked('cfg-render-mermaid', !!render.mermaid);
  setVal('cfg-render-max', render.maxImages ?? 3);
  setVal('cfg-render-timeout', render.timeoutMs ?? 12000);
  setVal('cfg-render-table-preset', render.tablePreset || 'yuzu-deep');

  const logging = cfg.logging || {};
  setVal('cfg-log-level', logging.level || 'info');
  setVal('cfg-log-keep', logging.keepDays || 14);
  setVal('cfg-trigger-keywords', (bot.triggerKeywords || []).join(', '));
  setVal('cfg-history-limit', bot.historyLimit);
  setVal('cfg-max-context', bot.maxContextTokens);

  setVal('cfg-at-prob', Math.round(Number(defaults.atProb || 0) * 100));
  setVal('cfg-keyword-prob', Math.round(Number(defaults.keywordProb || 0) * 100));
  setVal('cfg-random-prob', Math.round(Number(defaults.randomProb || 0) * 100));

  setVal('cfg-panel-port', cfg.panel ? cfg.panel.port : '');

  state.config = cfg;
  applyReplyButton();
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    if (!state.settingsDirty) fillSettings(cfg);
  } catch (err) {
    /* 轮询里失败静默，手动刷新时会上报 */
  }
}

function collectSettings() {
  const body = {
    llm: {
      baseUrl: $('#cfg-base-url').value.trim(),
      model: $('#cfg-model').value.trim(),
      fallback: {
        baseUrl: $('#cfg-fallback-base').value.trim(),
        model: $('#cfg-fallback-model').value.trim(),
      },
      temperature: numVal('cfg-temperature', 0.8),
      maxTokens: numVal('cfg-max-tokens', 2000),
      timeoutMs: numVal('cfg-timeout', 120000),
      mock: $('#cfg-mock').checked,
    },
    persona: {
      systemPrompt: $('#cfg-system-prompt').value,
      groupProactive: $('#cfg-group-proactive').value,
      privateProactive: $('#cfg-private-proactive').value,
      favorHint: $('#cfg-favor-hint').checked,
    },
    vision: {
      enabled: $('#cfg-vision-enabled').checked,
      model: $('#cfg-vision-model').value.trim(),
      baseUrl: $('#cfg-vision-base').value.trim(),
      apiKey: $('#cfg-vision-key').value.trim(),
      timeoutMs: numVal('cfg-vision-timeout', 90000),
      maxChars: numVal('cfg-vision-chars', 240),
    },
    render: {
      enabled: $('#cfg-render-enabled').checked,
      tables: $('#cfg-render-tables').checked,
      svg: $('#cfg-render-svg').checked,
      mermaid: $('#cfg-render-mermaid').checked,
      maxImages: numVal('cfg-render-max', 3),
      timeoutMs: numVal('cfg-render-timeout', 12000),
      tablePreset: $('#cfg-render-table-preset').value,
    },
    logging: {
      level: $('#cfg-log-level').value,
      keepDays: numVal('cfg-log-keep', 14),
    },
    bot: {
      globalAutoReply: $('#cfg-auto-reply').checked,
      splitReply: $('#cfg-split-reply').checked,
      triggerKeywords: ($('#cfg-trigger-keywords') && $('#cfg-trigger-keywords').value.trim()) || '',
      historyLimit: numVal('cfg-history-limit', 24),
      maxContextTokens: numVal('cfg-max-context', 12000),
    },
    defaults: {
      atProb: numVal('cfg-at-prob', 100) / 100,
      keywordProb: numVal('cfg-keyword-prob', 60) / 100,
      randomProb: numVal('cfg-random-prob', 5) / 100,
    },
    panel: { port: numVal('cfg-panel-port', 3212) },
  };
  const key = $('#cfg-api-key').value.trim();
  if (key) body.llm.apiKey = key;
  const fbKey = $('#cfg-fallback-key').value.trim();
  if (fbKey) body.llm.fallback.apiKey = fbKey;
  return body;
}

async function saveSettings() {
  const btn = $('#btn-save-config');
  btn.disabled = true;
  try {
    const res = await api('/api/config', { method: 'POST', body: collectSettings() });
    const changed = res.changed || [];
    toast(changed.length ? '设置已保存（改了 ' + changed.length + ' 项）' : '设置已保存（没有变化）');
    (res.notes || []).forEach((n) => toast(n));
    state.settingsDirty = false;
    if (res.config) fillSettings(res.config);
  } catch (err) {
    toast('保存失败：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
}

async function runLlmTest(targetSel) {
  const box = $(targetSel);
  if (box) {
    box.className = 'hint-box';
    box.textContent = '正在测试，最长等两分钟…';
  }
  try {
    const r = await api('/api/llm/test', { method: 'POST' });
    if (r.ok) {
      const text = '通了！模型 ' + (r.model || '-') + '，耗时 ' + r.ms + 'ms' + (r.reply ? '，回答：' + r.reply : '');
      if (box) { box.className = 'hint-box ok'; box.textContent = text; }
      toast('模型连通正常');
    } else {
      const text = '不通：' + (r.error || '未知原因');
      if (box) { box.className = 'hint-box bad'; box.textContent = text; }
      toast('模型连接失败', 'bad');
    }
  } catch (err) {
    if (box) { box.className = 'hint-box bad'; box.textContent = '测试失败：' + err.message; }
    toast('测试失败：' + err.message, 'bad');
  }
}

// ---------- 日志（结构化：时间 / 级别 / 模块 / 消息）----------

let logTailOffset = 0;
let logRows = [];                    // 已解析的日志行
const logLevels = new Set(['INFO', 'SUCCESS', 'WARN', 'ERROR']);

const LEVEL_META = {
  TRACE: { cls: 'lv-trace', label: 'TRACE' },
  DEBUG: { cls: 'lv-debug', label: 'DEBUG' },
  INFO: { cls: 'lv-info', label: 'INFO' },
  SUCCESS: { cls: 'lv-success', label: 'SUCCESS' },
  WARN: { cls: 'lv-warn', label: 'WARN' },
  ERROR: { cls: 'lv-error', label: 'ERROR' },
};

/** 把一行日志拆成 {time, level, module, msg}，拆不开就整行当消息 */
function parseLogLine(line) {
  const m = String(line).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?) \[(\w+)\s*\] \[([^\]]+)\] ([\s\S]*)$/);
  if (!m) return { time: '', level: 'INFO', module: '', msg: String(line), raw: line };
  return { time: m[2].slice(0, 8), level: m[3].toUpperCase(), module: m[4], msg: m[5], raw: line };
}

function logLevelOf(row) {
  if (row.level === 'INFO' && /^柚子回复/.test(row.msg)) return 'SUCCESS';
  if (row.level === 'INFO' && /^🤖|^机器人回复/.test(row.msg)) return 'SUCCESS';
  return LEVEL_META[row.level] ? row.level : 'INFO';
}

function renderLogTable() {
  const tbody = $('#log-tbody');
  const empty = $('#log-empty');
  if (!tbody) return;
  const kw = ($('#log-search')?.value || '').trim().toLowerCase();
  const rows = logRows.filter((r) => {
    const lv = logLevelOf(r);
    if (!logLevels.has(lv)) return false;
    if (!kw) return true;
    return r.raw.toLowerCase().includes(kw);
  });
  const recent = rows.slice(-800);
  if (!recent.length) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  const follow = $('#log-follow')?.checked !== false;
  const wrap = tbody.closest('.log-table-wrap');
  const atBottom = wrap ? wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 60 : true;

  tbody.innerHTML = recent.map((r) => {
    const lv = logLevelOf(r);
    const meta = LEVEL_META[lv] || LEVEL_META.INFO;
    const msg = String(r.msg || '');
    const cls = /柚子回复|判断为不插嘴/.test(msg) ? 'msg-reply' : (/出图|识图/.test(msg) ? 'msg-render' : '');
    return '<tr>' +
      '<td class="c-time">' + esc(r.time || '—') + '</td>' +
      '<td class="c-level"><span class="lv ' + meta.cls + '"><i class="dot"></i>' + meta.label + '</span></td>' +
      '<td class="c-mod">' + esc(r.module ? '[' + r.module + ']' : '') + '</td>' +
      '<td class="c-msg ' + cls + '">' + esc(msg) + '</td>' +
      '</tr>';
  }).join('');

  if (follow || atBottom) {
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }
}

async function refreshLogs(reset) {
  const limit = Number($('#log-limit')?.value) || 200;
  if (reset) { logTailOffset = 0; logRows = []; }
  try {
    const d = await api('/api/logs?limit=' + limit + '&tailOff=' + logTailOffset);
    const size = Number(d.fileSize) || 0;
    if (size < logTailOffset) { logTailOffset = 0; logRows = []; }
    const fresh = d.lines || [];
    if (typeof d.nextOffset === 'number') logTailOffset = d.nextOffset;
    else if (fresh.length) logTailOffset = size;
    if (fresh.length) {
      logRows = logRows.concat(fresh.map(parseLogLine)).slice(-1200);
      renderLogTable();
    } else if (!logRows.length) {
      renderLogTable();
    }
    const hint = $('#log-file-hint');
    if (hint) {
      hint.textContent = (d.file ? '实时事件流 · ' + d.file : '还没有日志文件') +
        ' · ' + fmtNum(logRows.length) + ' 条 · 服务端 ' + 'INFO';
    }
  } catch (err) {
    toast('读取日志失败：' + err.message, 'bad');
  }
}

// ---------- 标签页切换 ----------

function settingsFocused() {
  const form = $('#settings-form');
  const el = document.activeElement;
  if (!form || !el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
  return typeof form.contains === 'function' ? form.contains(el) : false;
}

const TAB_LOADERS = {
  overview: () => { void refreshOverview(); void refreshExtras(); void refreshOverviewLog(); },
  sessions: () => { void refreshSessions(); },
  favors: () => { void refreshFavors(); },
  ignores: () => { void refreshIgnores(); },
  settings: () => { void loadConfig(); },
  logs: () => { void refreshLogs(true); },
};

const TAB_TITLES = { overview: '总览', sessions: '会话', favors: '好感度', ignores: '不理名单', settings: '设置', logs: '日志' };

function switchTab(name) {
  if (!TAB_LOADERS[name]) return;
  const crumb = $('#crumb-title');
  if (crumb) crumb.textContent = TAB_TITLES[name] || name;
  state.tab = name;
  $$('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === 'view-' + name));
  closeModal();
  TAB_LOADERS[name]();
}

// ---------- 轮询 ----------

async function tick() {
  if (state.tickBusy || document.hidden) return;
  state.tickBusy = true;
  try {
    await refreshOverview();
    if (state.tab === 'overview') void refreshOverviewLog();
    if (state.modalOpen) return;
    if (state.tab === 'sessions') {
      const d = await api('/api/sessions');
      state.sessions = d.sessions || [];
      state.counts = d.counts || {};
      renderSessions();
    } else if (state.tab === 'favors') {
      const d = await api('/api/favors');
      state.favors = d.favors || [];
      renderFavors();
    } else if (state.tab === 'ignores') {
      const d = await api('/api/ignores');
      state.ignores = d.ignores || [];
      renderIgnores();
    } else if (state.tab === 'logs') {
      await refreshLogs(false);
    } else if (state.tab === 'settings' && !state.settingsDirty && !settingsFocused()) {
      await loadConfig();
    }
  } catch (err) {
    /* 轮询失败不弹窗打扰老大，顶栏的灯会变红 */
  } finally {
    state.tickBusy = false;
  }
}

// ---------- 事件绑定 ----------

// ---------- 主题切换（默认浅色，跟 SnowLuma 一致）----------
function applyTheme(name) {
  const theme = name === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('maid-theme', theme); } catch { /* 隐私模式忽略 */ }
  const btn = $('#btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function bindEvents() {
  const themeBtn = $('#btn-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
  // 标签页
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  // 全局回复开关
  $('#toggle-reply').addEventListener('click', async () => {
    const btn = $('#toggle-reply');
    btn.disabled = true;
    try {
      const r = await api('/api/reply/toggle', { method: 'POST' });
      if (state.config && state.config.bot) state.config.bot.globalAutoReply = r.globalAutoReply;
      applyReplyButton();
      toast('全局回复已' + (r.globalAutoReply ? '开启' : '关闭'));
    } catch (err) {
      toast('切换失败：' + err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  // 总览
  $('#btn-ping-llm').addEventListener('click', () => runLlmTest('#llm-test-result'));
  $('#btn-refresh-overview').addEventListener('click', () => { void refreshOverview(); void refreshExtras(); });
  $('#btn-refresh-extras').addEventListener('click', () => { void refreshExtras(); });
  const ovLogBtn = $('#btn-ov-log-refresh');
  if (ovLogBtn) ovLogBtn.addEventListener('click', () => { void refreshOverviewLog(); });
  const ovLogFull = $('#btn-ov-log-full');
  if (ovLogFull) ovLogFull.addEventListener('click', () => switchTab('logs'));

  // 设置：拉取模型列表
  const btnModels = $('#btn-fetch-models');
  if (btnModels) {
    btnModels.addEventListener('click', async () => {
      const base = ($('#cfg-base-url') && $('#cfg-base-url').value.trim()) || '';
      const key = ($('#cfg-api-key') && $('#cfg-api-key').value.trim()) || '';
      btnModels.disabled = true;
      const old = btnModels.textContent;
      btnModels.textContent = '拉取中…';
      try {
        const qs = [];
        if (base) qs.push('baseUrl=' + encodeURIComponent(base));
        if (key && key.indexOf('****') < 0) qs.push('apiKey=' + encodeURIComponent(key));
        const d = await api('/api/llm/models' + (qs.length ? '?' + qs.join('&') : ''));
        const sel = $('#cfg-model-list');
        const models = d.models || [];
        sel.innerHTML = '';
        if (!models.length) {
          sel.innerHTML = '<option value="">接口没返回模型</option>';
        } else {
          sel.innerHTML = '<option value="">选一个（共 ' + models.length + ' 个）</option>' +
            models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
        }
        toast('拉到 ' + models.length + ' 个模型，点下拉选一个');
      } catch (err) {
        toast('拉取失败：' + err.message, 'bad');
      } finally {
        btnModels.disabled = false;
        btnModels.textContent = old;
      }
    });
  }
  const modelSel = $('#cfg-model-list');
  if (modelSel) {
    modelSel.addEventListener('change', () => {
      if (!modelSel.value) return;
      const input = $('#cfg-model');
      if (input) input.value = modelSel.value;
      toast('已选模型：' + modelSel.value);
    });
  }

  $('#btn-clear-all').addEventListener('click', async () => {
    const ok = await askConfirm('清空全部记忆', '确定要清空机器人记住的所有对话吗？这个操作不能撤销，好感度不受影响。', '清空');
    if (!ok) return;
    try {
      await api('/api/memory/clear', { method: 'POST', body: {} });
      toast('全部记忆已清空');
      await refreshOverview();
      if (state.tab === 'sessions') await refreshSessions();
    } catch (err) {
      toast('清空失败：' + err.message, 'bad');
    }
  });

  // 会话
  $('#btn-sessions-refresh').addEventListener('click', () => { void refreshSessions(); });

  const tbody = $('#sessions-body');
  tbody.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) { openSessionEditor(editBtn.dataset.edit); return; }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      const key = delBtn.dataset.del;
      const s = state.sessions.find((x) => x.key === key);
      askConfirm('删除会话', '确定删除「' + (s && s.name ? s.name : key) + '」吗？聊天记忆不会删掉，只是从列表里移除。', '删除').then(async (ok) => {
        if (!ok) return;
        try {
          await api('/api/sessions/' + encodeURIComponent(key), { method: 'DELETE' });
          toast('会话已删除');
          await refreshSessions();
        } catch (err) {
          toast('删除失败：' + err.message, 'bad');
        }
      });
    }
  });
  tbody.addEventListener('change', (e) => {
    const box = e.target.closest('[data-toggle]');
    if (box) void toggleSession(box.dataset.toggle, box.checked);
  });

  // 好感度
  $('#btn-favors-refresh').addEventListener('click', () => { void refreshFavors(); });
  $('#btn-ignores-refresh').addEventListener('click', () => { void refreshIgnores(); });
  $('#ignores-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-release]');
    if (btn) void releaseIgnore(btn.dataset.release);
  });
  $('#favor-search').addEventListener('input', renderFavors);
  $('#favors-body').addEventListener('click', (e) => {
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const qq = quick.dataset.quick;
      const step = Number(quick.dataset.step) || 0;
      const input = document.querySelector('[data-score-input="' + qq + '"]');
      if (input) input.value = (Number(input.value) || 0) + step;
      return;
    }
    const save = e.target.closest('[data-save]');
    if (save) {
      void saveFavorQuick(save.dataset.save, save);
      return;
    }
    const btn = e.target.closest('[data-favor]');
    if (btn) openFavorEditor(btn.dataset.favor);
  });

  // 好感度输入框里按回车 = 点保存
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.scoreInput) return;
    e.preventDefault();
    void saveFavorQuick(el.dataset.scoreInput, null);
  });

  // 设置
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveSettings();
  });
  $('#settings-form').addEventListener('input', () => { state.settingsDirty = true; });
  $('#settings-form').addEventListener('change', () => { state.settingsDirty = true; });
  $('#btn-test-llm').addEventListener('click', () => runLlmTest('#settings-test-result'));

  // 日志
  $('#btn-logs-refresh').addEventListener('click', () => { void refreshLogs(true); });
  const logSearch = $('#log-search');
  if (logSearch) logSearch.addEventListener('input', () => renderLogTable());
  const filters = $('#log-filters');
  if (filters) {
    filters.addEventListener('click', (e) => {
      const chip = e.target.closest('.lvl-chip');
      if (!chip) return;
      const lv = chip.dataset.level;
      if (logLevels.has(lv)) logLevels.delete(lv); else logLevels.add(lv);
      chip.classList.toggle('active', logLevels.has(lv));
      renderLogTable();
    });
  }
  $('#log-limit').addEventListener('change', () => { void refreshLogs(true); });
  $('#log-follow').addEventListener('change', () => {
    if (!$('#log-follow').checked) return;
    const wrap = document.querySelector('.log-table-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
    renderLogTable();
  });

  // Esc 关弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalOpen) closeModal();
  });

  // 页脚时钟
  const clock = () => {
    const el = $('#foot-clock');
    if (!el) return;
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    el.textContent = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };
  clock();
  setInterval(clock, 1000);
}

// ---------- 启动 ----------

function init() {
  bindEvents();
  void loadConfig();
  void refreshOverview();
  void refreshExtras();
  try {
    applyTheme(localStorage.getItem('maid-theme') || 'light');
  } catch {
    applyTheme('light');
  }
  setInterval(tick, 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
