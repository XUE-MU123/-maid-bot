import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import type { Config, IgnoreItem, Overview, PanelFavor, PanelSession } from '../../src/lib/types';

type RecordedWrite = { path: string; method: string; body: Record<string, unknown> };
type MockPanel = {
  config: Config; favors: PanelFavor[]; ignores: IgnoreItem[]; sessions: PanelSession[];
  overview: Overview; overviewFailure: boolean; overviewGate?: Promise<void>; groups: { groups: unknown[]; note?: string }; friends: { friends: unknown[]; note?: string };
  writes: RecordedWrite[]; gets: Record<string, number>; unexpected: string[]; favorSaveFailures: number; configSaveFailures: number;
  sessionSaveFailures: number; sessionDeleteFailures: number; memoryReadFailures: number; memoryClearFailures: number; clearedMemoryKeys: string[];
};
const origin = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:3210').origin;
const now = Date.UTC(2026, 0, 1, 8);
const sharedKey = 'group:900001';
const logLines = [
  '2026-01-01 16:00:00 [INFO] [panel] MOCK 演示面板启动成功',
  '2026-01-01 16:00:01 [INFO] [bot] 机器人回复：这是一条虚构测试回复，不含真实聊天',
  '2026-01-01 16:00:02 [WARN] [llm] MOCK 演示备用接口已就绪',
];

async function fixture(): Promise<MockPanel> {
  // Example configuration only. Never read data/config.json or production state.
  const config = JSON.parse(await readFile(new URL('../../../config.example.json', import.meta.url), 'utf8')) as Config;
  expect(config.bot.masterRoles, 'Example configuration must not silently assign an owner').toEqual({ primaryId: '', secondaryId: '', dualEnabled: false });
  expect(config.bot.masterIds, 'Legacy IDs in the example must be empty too').toEqual([]);
  config.llm.baseUrl = 'https://mock-primary.invalid/v1';
  config.llm.model = 'mock-primary'; config.llm.apiKey = 'mo****ck';
  config.llm.fallback = { baseUrl: '', apiKey: '', model: '' };
  config.llm.profiles = [
    { id: 'mock-main', name: 'MOCK 主接口', baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey: 'mo****ck' },
    { id: 'mock-backup', name: 'MOCK 备用接口', baseUrl: 'https://mock-backup.invalid/v1', model: 'mock-backup-model', apiKey: 'ba****ck' },
  ];
  config.persona.systemPrompt = 'MOCK 初始人格：仅用于虚构测试。';
  config.persona.groupProactive = 'MOCK 群聊提示'; config.persona.privateProactive = 'MOCK 私聊提示';
  config.onebot.accessToken = ''; config.bot.triggerKeywords = ['测试女仆', 'MOCK'];
  config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: false };
  config.bot.masterIds = [];
  const session = (key: string, name: string, type: 'group' | 'private', memoryShared: boolean): PanelSession => ({
    key, name, type, targetId: type === 'group' ? '900001' : '900002', nickname: name, avatar: '', enabled: true, prompt: '', memoryShared,
    atProb: 1, keywordProb: 0.6, keywords: '', randomProb: 0.05, proactiveEnabled: false, proactiveMinMinutes: 30, proactiveMaxMinutes: 60, proactiveMaxRounds: 2, createdAt: now, updatedAt: now,
  });
  return {
    config, writes: [], gets: {}, unexpected: [], favorSaveFailures: 0, configSaveFailures: 0, overviewFailure: false,
    sessionSaveFailures: 0, sessionDeleteFailures: 0, memoryReadFailures: 0, memoryClearFailures: 0, clearedMemoryKeys: [],
    overview: { status: { onebotConnected: true, selfId: '900000', reconnects: 7, lastError: '' }, stats: { messages: 1284, sessions: 2 }, usage: { totalPrompt: 64000, totalCompletion: 16000 }, favorCount: 2, uptimeSec: 93784, version: '0.1.1-mock', masterStatus: { mode: 'none', primary: null, secondary: null } },
    groups: { groups: [{ group_id: 900001, group_name: 'MOCK 测试群' }] }, friends: { friends: [{ user_id: 900002, nickname: 'MOCK 测试好友' }] },
    ignores: [{ qq: '900005', nickname: 'MOCK 暂停成员', avatar: '', sessionKey: sharedKey, sessionName: 'MOCK 测试群', remainText: '10 分钟', untilText: '2026-01-01 16:10', times: 1 }],
    sessions: [session(sharedKey, 'MOCK 测试群', 'group', true), session('private:900002', 'MOCK 测试好友', 'private', false)],
    favors: [{ qq: '900003', nickname: 'MOCK 小星', avatar: '', score: 25, levelIndex: 1, levelName: '相识', isMaster: false, dailyGain: 2, updatedAt: now }, { qq: '900004', nickname: 'MOCK 小月', avatar: '', score: 32, levelIndex: 1, levelName: '相识', isMaster: false, dailyGain: 0, updatedAt: now }],
  };
}
function mockMaster(qq: string, role: 'primary' | 'secondary') {
  return { qq, nickname: role === 'primary' ? 'MOCK 第一老大' : 'MOCK 二老大', avatar: '' };
}
function merge(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = target[key];
      if (!current || typeof current !== 'object' || Array.isArray(current)) target[key] = {};
      merge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else target[key] = value;
  }
}

const test = base.extend<{ mock: MockPanel }>({
  mock: async ({ page }, use) => {
    const state = await fixture();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Catch ALL API methods before navigation. No API request can reach the deployed backend.
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      // Authentication bootstrap is a read, not a panel mutation. Keep every
      // panel test authenticated without ever contacting the real gateway.
      if (method === 'GET' && path === '/api/auth/session') {
        return respond({ authenticated: true, csrfToken: 'mock-csrf', username: 'mock' });
      }
      let body: Record<string, unknown> = {};
      if (!['GET', 'HEAD'].includes(method)) {
        expect(request.headers()['x-csrf-token'], `${method} ${path} requires the session CSRF token`).toBe('mock-csrf');
        body = request.postDataJSON() ?? {};
        state.writes.push({ path, method, body: structuredClone(body) });
      } else state.gets[path] = (state.gets[path] ?? 0) + 1;
      if (method === 'GET') {
        if (path === '/api/config') return respond(state.config);
        if (path === '/api/overview') { await state.overviewGate; return state.overviewFailure ? respond({ error: 'MOCK 总览暂时不可用' }, 503) : respond(state.overview); }
        if (path === '/api/groups') return respond(state.groups);
        if (path === '/api/friends') return respond(state.friends);
        if (path === '/api/sessions') return respond({ sessions: state.sessions, counts: { [sharedKey]: 12, 'private:900002': 4 } });
        if (path === '/api/favors') return respond({ favors: state.favors });
        if (path === '/api/ignores') return respond({ ignores: state.ignores });
        if (path === '/api/logs') return respond({ lines: logLines, fileSize: 300, nextOffset: 300, file: 'MOCK/logs/bot.log' });
        if (path === '/api/messages') {
          const key = url.searchParams.get('key');
          const session = state.sessions.find(item => item.key === key);
          if (!session) return respond({ error: 'MOCK 会话不存在' }, 404);
          if (state.memoryReadFailures > 0) { state.memoryReadFailures--; return respond({ error: 'MOCK 消息读取失败' }, 503); }
          const memoryKey = session.memoryShared ? 'shared' : session.key;
          return respond({ messages: state.clearedMemoryKeys.includes(memoryKey) ? [] : [{ id: 1, sessionKey: key, role: 'user', content: 'MOCK 虚构记忆，不含真实聊天', senderId: '900003', senderName: 'MOCK 小星', msgId: 'mock-1', createdAt: now, senderRole: null, senderTitle: null, dialogTag: null }] });
        }
        if (path === '/api/llm/models') return respond({ ok: true, models: ['mock-primary', 'mock-second', 'mock-vision'] });
      }
      if (['POST', 'DELETE'].includes(method) && path.startsWith('/api/sessions/')) {
        let key: string;
        try { key = decodeURIComponent(path.slice('/api/sessions/'.length)); }
        catch { return respond({ error: 'MOCK 无效会话编号' }, 400); }
        const index = state.sessions.findIndex(item => item.key === key);
        if (index < 0) return respond({ error: 'MOCK 会话不存在' }, 404);
        if (method === 'DELETE') {
          if (state.sessionDeleteFailures > 0) { state.sessionDeleteFailures--; return respond({ error: 'MOCK 删除会话失败' }, 503); }
          state.sessions.splice(index, 1);
          return respond({ ok: true, deleted: key });
        }
        const fields = ['name', 'enabled', 'prompt', 'memoryShared', 'atProb', 'keywordProb', 'keywords', 'randomProb', 'proactiveEnabled', 'proactiveMinMinutes', 'proactiveMaxMinutes', 'proactiveMaxRounds'];
        if (!Object.keys(body).length || Object.keys(body).some(field => !fields.includes(field))) return respond({ error: 'MOCK 无效会话修改字段' }, 400);
        if (state.sessionSaveFailures > 0) { state.sessionSaveFailures--; return respond({ error: 'MOCK 会话保存失败，请重试' }, 503); }
        Object.assign(state.sessions[index], body, { updatedAt: now + 1000 });
        return respond({ ok: true, session: state.sessions[index], changed: true });
      }
      if (method === 'POST') {
        if (path === '/api/config') {
          if (state.configSaveFailures > 0) { state.configSaveFailures--; return respond({ error: 'MOCK 老大身份保存被服务端拒绝，请重试' }, 400); }
          const roles = (body.bot as { masterRoles?: Config['bot']['masterRoles'] } | undefined)?.masterRoles;
          if (roles) {
            const { primaryId, secondaryId, dualEnabled } = roles;
            if (typeof primaryId !== 'string' || typeof secondaryId !== 'string' || typeof dualEnabled !== 'boolean'
              || (primaryId && !/^\d{5,15}$/.test(primaryId)) || (secondaryId && !/^\d{5,15}$/.test(secondaryId))
              || (secondaryId && (!primaryId || secondaryId === primaryId))) return respond({ error: 'MOCK 无效老大身份配置' }, 400);
          }
          merge(state.config as unknown as Record<string, unknown>, body);
          const keywords = body.bot as { triggerKeywords?: string } | undefined;
          if (typeof keywords?.triggerKeywords === 'string') state.config.bot.triggerKeywords = keywords.triggerKeywords.split(/[,，\s]+/).filter(Boolean);
          // Legacy IDs and readonly overview status are derived from effective roles, never independent form values.
          const effective = state.config.bot.masterRoles;
          const primary = effective.primaryId ? mockMaster(effective.primaryId, 'primary') : null;
          const secondary = primary && effective.dualEnabled && effective.secondaryId ? mockMaster(effective.secondaryId, 'secondary') : null;
          state.config.bot.masterIds = [primary?.qq, secondary?.qq].filter((qq): qq is string => !!qq);
          state.overview.masterStatus = { mode: secondary ? 'dual' : primary ? 'single' : 'none', primary, secondary };
          return respond({ ok: true, config: state.config, changed: Object.keys(body), notes: [] });
        }
        if (path === '/api/llm/profiles') {
          const profile = { id: `mock-profile-${state.config.llm.profiles.length}`, name: String(body.name), baseUrl: String(body.baseUrl), model: String(body.model), apiKey: 'ne****ck' };
          state.config.llm.profiles.push(profile);
          return respond({ ok: true, config: state.config, note: `已存为「${profile.name}」` });
        }
        if (path === '/api/llm/profiles/apply') {
          const profile = state.config.llm.profiles.find(item => item.id === body.id);
          if (!profile) return respond({ error: 'MOCK 档案不存在' }, 404);
          state.config.llm.baseUrl = profile.baseUrl; state.config.llm.model = profile.model; state.config.llm.apiKey = profile.apiKey;
          return respond({ ok: true, config: state.config, note: `已切换到「${profile.name}」` });
        }
        if (path === '/api/llm/profiles/delete') {
          state.config.llm.profiles = state.config.llm.profiles.filter(item => item.id !== body.id);
          return respond({ ok: true, config: state.config, note: 'MOCK 档案已删除' });
        }
        if (path === '/api/favors') {
          if (state.favorSaveFailures > 0) {
            state.favorSaveFailures--;
            return respond({ error: 'MOCK 保存失败，请重试。MockFailureWithoutSpaces'.repeat(4) }, 503);
          }
          const favor = state.favors.find(item => item.qq === body.qq);
          if (!favor) return respond({ error: 'MOCK 成员不存在' }, 404);
          if (favor.isMaster) return respond({ error: 'MOCK 老大分数锁定' }, 403);
          favor.score = Number(body.score); favor.updatedAt = now + 1000;
          return respond({ qq: favor.qq, score: favor.score, favor });
        }
        if (path === '/api/ignores') {
          // Only this explicit release contract can mutate the synthetic ignore fixture.
          if (body.action !== 'release' || typeof body.qq !== 'string' || typeof body.sessionKey !== 'string') return respond({ error: 'MOCK 无效解除请求' }, 400);
          const index = state.ignores.findIndex(item => item.qq === body.qq && item.sessionKey === body.sessionKey);
          if (index < 0) return respond({ error: 'MOCK 不理记录不存在' }, 404);
          state.ignores.splice(index, 1);
          return respond({ ok: true });
        }
        if (path === '/api/memory/clear') {
          const session = state.sessions.find(item => item.key === body.key);
          if (!session || Object.keys(body).length !== 1) return respond({ error: 'MOCK 必须指定存在的会话编号' }, 400);
          if (state.memoryClearFailures > 0) { state.memoryClearFailures--; return respond({ error: 'MOCK 记忆清空失败' }, 503); }
          state.clearedMemoryKeys.push(session.memoryShared ? 'shared' : session.key);
          return respond({ ok: true, key: session.key, removed: 1 });
        }
        if (path === '/api/llm/test') return respond({ ok: true, model: state.config.llm.model, ms: 12, reply: 'MOCK 模型测试成功' });
        if (path === '/api/reply/toggle') { state.config.bot.globalAutoReply = !state.config.bot.globalAutoReply; return respond({ globalAutoReply: state.config.bot.globalAutoReply }); }
      }
      state.unexpected.push(`${method} ${path}`);
      // Fail CLOSED: unknown routes get a synthetic error, NEVER route.continue().
      return respond({ error: `Unmocked API blocked: ${method} ${path}` }, 501);
    });
    // Only application HTML/static assets on the deployed origin may use the network.
    await page.route(url => url.origin !== origin && !url.pathname.startsWith('/api/'), route => route.abort('blockedbyclient'));
    await page.goto('/');
    await expect(page.locator('.topbar-title')).toHaveText('总览');
    await use(state);
    expect(state.unexpected, 'Every API request must have an explicit mock').toEqual([]);
    expect(pageErrors, 'No client-side exceptions').toEqual([]);
  },
});
async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(page.locator('.topbar-title')).toHaveText(name);
}

function sidebarMenu(page: Page) { return page.locator('.brand .brand-menu'); }

async function expectNoDocumentOverflow(page: Page, context: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `${context}: document should not overflow horizontally` }).toBe(true);
}

async function expectSidebarButton(page: Page, expanded: boolean) {
  const menu = sidebarMenu(page);
  const label = expanded ? '收起侧栏' : '展开侧栏';
  await expect(menu).toHaveCount(1);
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAccessibleName(label);
  await expect(menu).toHaveAttribute('aria-expanded', String(expanded));
  await expect(menu).toHaveAttribute('aria-controls', 'main-sidebar');
  await expect(menu.locator('svg.lucide-panel-left')).toHaveCount(1);
  await expect(menu.locator('.rail-brand-mark')).toHaveText('助');
  await expect(page.getByRole('button', { name: /^(收起侧栏|展开侧栏)$/, includeHidden: true })).toHaveCount(1);
  await expect(page.locator('.topbar button[aria-controls="main-sidebar"]')).toHaveCount(0);
  await expect(page.locator('.topbar button[aria-label*="菜单"], .topbar button[aria-label*="侧栏"]')).toHaveCount(0);
  await expect(page.locator('.sidebar-footer button')).toHaveCount(0);
  await expect(page.locator('.sidebar-footer')).toContainText('v0.1.1-mock');
  await expect.poll(() => menu.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const sidebar = element.closest('.sidebar')!.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width >= 40 && rect.height >= 40 && rect.left >= 0 && rect.top >= 0
      && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight
      && rect.left >= sidebar.left && rect.right <= sidebar.right + 1 && !!hit && element.contains(hit);
  }), { message: `${label}: sidebar button must be on-screen, unobstructed and at least 40px square` }).toBe(true);
}

async function expectMobileRail(page: Page) {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveClass(/collapsed/);
  await expect(sidebar).not.toHaveClass(/mobile-open/);
  expect(await sidebar.getAttribute('inert')).toBeNull();
  await expect(sidebar).toHaveJSProperty('inert', false);
  await expect.poll(() => sidebar.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.left) <= 1 && Math.abs(rect.width - 56) <= 1;
  })).toBe(true);
  await expect(page.locator('.brand-copy')).not.toBeVisible();
  await expect(page.locator('.brand-mark')).not.toBeVisible();
  await expect(page.locator('.nav-text').first()).not.toBeVisible();
  await expect(page.locator('.mobile-backdrop')).not.toBeVisible();
  await expectSidebarButton(page, false);
  await expectNoDocumentOverflow(page, 'mobile rail');
}

async function expectExpandedSidebar(page: Page, mobile: boolean) {
  const sidebar = page.locator('.sidebar');
  await expect(sidebar).not.toHaveClass(/collapsed/);
  if (mobile) {
    await expect(sidebar).toHaveClass(/mobile-open/);
    await expect(page.locator('.mobile-backdrop')).toBeVisible();
  }
  expect(await sidebar.getAttribute('inert')).toBeNull();
  await expect(sidebar).toHaveJSProperty('inert', false);
  await expect(page.locator('.brand-copy')).toBeVisible();
  await expect(page.locator('.brand-mark')).toBeVisible();
  await expect(page.locator('.nav-text').first()).toBeVisible();
  await expect.poll(() => page.locator('.nav-text').evaluateAll(elements => elements.length === 6 && elements.every(element => {
    const title = element.querySelector('span')!.getBoundingClientRect();
    const detail = element.querySelector('small')!.getBoundingClientRect();
    return title.height > 0 && detail.height > 0 && detail.top >= title.bottom - 1 && Math.abs(title.left - detail.left) < 1;
  })), { message: 'Expanded navigation descriptions must be below their titles' }).toBe(true);
  await expectSidebarButton(page, true);
  await expectNoDocumentOverflow(page, 'expanded sidebar');
}

async function expectContained(page: Page, selector: string) {
  await expectNoDocumentOverflow(page, selector);
  await expect.poll(() => page.locator(selector).evaluate(panel => [panel, ...panel.querySelectorAll<HTMLElement>('*')].filter(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const header = element.closest('thead');
    if (style.display === 'none' || !rect.width || !rect.height || style.clipPath !== 'none' || (header && getComputedStyle(header).clipPath !== 'none')) return false;
    // Clipped/ellipsized names intentionally have scrollWidth > clientWidth. Their bounds still must fit.
    const clipped = ['hidden', 'clip'].includes(style.overflowX);
    const contentOverflow = !clipped && !(element instanceof HTMLInputElement) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
    return contentOverflow || rect.left < -1 || rect.right > window.innerWidth + 1;
  }).map(element => `${element.tagName}.${element.className}`)), { message: `${selector}: no content may require horizontal scrolling` }).toEqual([]);
}

async function expectWrappedText(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    const lines = [...text.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    return new Set(lines.map(rect => Math.round(rect.top))).size;
  }), { message: 'Long text should wrap onto multiple lines rather than clip or scroll' }).toBeGreaterThan(1);
}

async function expectBlueCoralTheme(page: Page, dark: boolean) {
  const colors = dark ? ['rgb(116, 190, 255)', 'rgb(181, 229, 225)', 'rgb(255, 180, 160)'] : ['rgb(20, 123, 200)', 'rgb(183, 232, 232)', 'rgb(243, 150, 136)'];
  const primary = page.locator('.ui-button-primary').first();
  await expect(primary).toBeVisible();
  const theme = await primary.evaluate(element => ({
    gradient: getComputedStyle(element).backgroundImage,
    token: getComputedStyle(document.documentElement).getPropertyValue('--brand-gradient'),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary'),
  }));
  expect(theme.token).toContain('linear-gradient');
  expect(theme.gradient).toContain('linear-gradient');
  for (const color of colors) expect(theme.gradient).toContain(color);
  expect(theme.primary, 'Retired purple primary hue must not survive the theme migration').not.toMatch(/oklch\([^)]*\b300\b/i);
}

test('six-page navigation, light/dark theme and synthetic dashboard screenshot', async ({ page, mock }) => {
  await expect(page.getByText('1,284', { exact: true })).toBeVisible();
  await expect(page.getByText('MOCK 演示面板启动成功', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expectBlueCoralTheme(page, false);
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectBlueCoralTheme(page, true);
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  for (const name of ['会话', '好感度', '不理名单', '设置', '日志', '总览']) await navigate(page, name);
  await expect(page.getByText('MOCK 演示面板启动成功', { exact: true })).toBeVisible();
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/mock-dashboard.png', import.meta.url)), fullPage: true });
  expect(mock.writes).toEqual([]);
});

test('dashboard has one title and a flat connection summary with group, friend and reconnect metrics', async ({ page, mock }) => {
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1.topbar-title')).toHaveText('总览');
  await expect(page.locator('.page-footer')).toHaveCount(0);
  await expect(page.getByText('前端 React · SnowLuma 风格语义主题', { exact: true })).toHaveCount(0);
  await expect(page.locator('.connection-box')).toHaveCount(0);
  await expect(page.locator('.connection-status')).toContainText('OneBot 在线');
  const metrics = page.locator('.connection-metrics');
  await expect(metrics).toContainText('已加入群');
  await expect(metrics).toContainText('好友数');
  await expect(metrics).toContainText('累计重连');
  await expect(metrics.locator('dd')).toHaveText(['1', '1', '7']);
  await expect(page.locator('.connection-error')).toHaveText('最近错误：无');
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/compact-dashboard.png', import.meta.url)), fullPage: true });
  await page.locator('.connection-card').screenshot({ path: fileURLToPath(new URL('../../test-results/compact-connection.png', import.meta.url)) });
  expect(mock.writes).toEqual([]);
});

async function expectViewportStarfield(page: Page, minimumParticles: number) {
  const starfield = page.locator('canvas.panel-starfield');
  await expect(starfield).toHaveCount(1);
  await expect(starfield).toHaveClass(/login-starfield/);
  await expect(starfield).toHaveAttribute('data-motion', 'autonomous');
  await expect(starfield).toHaveCSS('position', 'fixed');
  await expect(starfield).toHaveCSS('pointer-events', 'none');
  await expect.poll(async () => Number(await starfield.getAttribute('data-particle-count'))).toBeGreaterThanOrEqual(minimumParticles);
  expect(Number(await starfield.getAttribute('data-particle-count'))).toBeLessThanOrEqual(190);
  await expect.poll(() => starfield.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.left) <= 1 && Math.abs(rect.top) <= 1
      && Math.abs(rect.width - window.innerWidth) <= 1 && Math.abs(rect.height - window.innerHeight) <= 1
      && !element.closest('.main-canvas');
  }), { message: 'Decorative canvas must cover only the fixed viewport, outside scrolling panel content' }).toBe(true);
  return starfield;
}

async function expectConnectionLayout(page: Page, stacked: boolean) {
  const stack = page.locator('.dashboard-middle > .dashboard-connection-stack');
  const connection = stack.locator(':scope > .connection-card');
  const masters = stack.locator(':scope > .master-status-card');
  const quick = page.locator('.dashboard-middle > .ui-card');
  await expect(stack).toHaveCount(1);
  await expect(masters).toBeVisible();
  await expect(quick).toHaveCount(1);
  await expect(connection.locator('.connection-metrics dd')).toHaveText(['1', '1', '7']);
  await expect(connection.locator('.connection-error')).toHaveText('最近错误：无');
  for (const selector of ['.connection-status', '.connection-metrics', '.connection-error']) {
    await expect(connection.locator(selector)).toBeVisible();
  }
  await expect.poll(() => connection.evaluate((element, mobile) => {
    const card = element.getBoundingClientRect();
    const stack = element.parentElement!.getBoundingClientRect();
    const masters = element.parentElement!.querySelector('.master-status-card')!.getBoundingClientRect();
    const quick = element.parentElement!.parentElement!.querySelector(':scope > .ui-card')!.getBoundingClientRect();
    const status = element.querySelector('.connection-status')!.getBoundingClientRect();
    const metrics = element.querySelector('.connection-metrics')!.getBoundingClientRect();
    const error = element.querySelector('.connection-error')!.getBoundingClientRect();
    const contained = [...element.querySelectorAll('.connection-status, .connection-metrics, .connection-metrics > div, .connection-error')].every(child => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && Number(style.opacity) > 0
        && rect.top >= card.top && rect.bottom <= card.bottom + 1 && rect.left >= card.left && rect.right <= card.right + 1;
    });
    const distributed = metrics.top >= status.bottom - 1 && error.top >= metrics.bottom - 1;
    const leftStack = masters.top >= card.bottom && Math.abs(masters.left - card.left) <= 1
      && Math.abs(masters.width - card.width) <= 1 && card.top >= stack.top - 1 && masters.bottom <= stack.bottom + 1;
    return contained && distributed && leftStack && (mobile
      ? quick.top >= stack.bottom && Math.abs(quick.left - stack.left) <= 1 && Math.abs(quick.width - stack.width) <= 1
      : Math.abs(quick.top - stack.top) <= 1 && Math.abs(quick.bottom - stack.bottom) <= 1
        && card.height < quick.height && Math.abs(quick.height - stack.height) <= 1);
  }, stacked), { message: stacked ? 'Phone connection and readonly identity stack should precede quick actions without hiding details' : 'Desktop combined connection/identity stack, not the compact connection card alone, must align with quick actions' }).toBe(true);
}

async function expectClickableControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await expect.poll(() => control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth + 1
      && rect.top >= 0 && rect.bottom <= window.innerHeight + 1 && !!hit && element.contains(hit);
  }), { message: 'Panel controls must remain on-screen and unobstructed by the decorative canvas' }).toBe(true);
}

async function expectTransparentReadableTopbar(page: Page, context: string) {
  const topbar = page.locator('.topbar');
  await expect(topbar).toHaveCount(1);
  await expect.poll(() => topbar.evaluate(element => {
    // Resolve CSS Color 4 tokens through the browser; do not hard-code theme RGB values.
    const bitmap = document.createElement('canvas'); bitmap.width = bitmap.height = 1;
    const ctx = bitmap.getContext('2d')!;
    const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const style = getComputedStyle(element);
    return { alpha: rgba(style.backgroundColor)[3], image: style.backgroundImage };
  }), { message: `${context}: the topbar must not restore an opaque/translucent fill or gradient` }).toEqual({ alpha: 0, image: 'none' });
  await expect.poll(() => topbar.evaluate(element => {
    const bitmap = document.createElement('canvas'); bitmap.width = bitmap.height = 1;
    const ctx = bitmap.getContext('2d')!;
    const resolve = document.createElement('span'); resolve.style.color = 'var(--background)'; element.append(resolve);
    const background = getComputedStyle(resolve).color; resolve.remove();
    const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const bg = rgba(background);
    const luminance = (channels: number[]) => channels.slice(0, 3).reduce((sum, value, index) => {
      const channel = value / 255;
      return sum + (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
    }, 0);
    const contrast = (node: Element) => {
      const fg = rgba(getComputedStyle(node).color), alpha = fg[3] / 255;
      const blended = fg.slice(0, 3).map((value, index) => value * alpha + bg[index] * (1 - alpha));
      const first = luminance(blended), second = luminance(bg);
      return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    };
    return [...element.querySelectorAll('.topbar-title, .topbar-subtitle, button svg')].filter(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    }).filter(node => contrast(node) < (node.matches('svg') ? 3 : 4.5)).map(node => node.classList.toString());
  }), { message: `${context}: visible topbar text/icons need readable theme contrast` }).toEqual([]);
  await expectContained(page, '.topbar');
}

async function expectTopbarControlGlow(page: Page, control: Locator, context: string) {
  await expectClickableControl(control);
  await expect(control).toHaveAccessibleName(/^(关闭背景动效|切换主题|退出登录)$/);
  await expect(control.locator('svg')).toBeVisible();
  const hasGlow = (focus: boolean) => control.evaluate((element, keyboardFocus) => {
    const styles = [element, ...element.querySelectorAll('svg')].map(node => getComputedStyle(node));
    return styles.some(style => style.boxShadow !== 'none' || style.textShadow !== 'none' || style.filter !== 'none'
      || (keyboardFocus && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0));
  }, focus);
  await control.hover();
  await expect.poll(() => hasGlow(false), { message: `${context}: pointer hover should highlight the control without an opaque topbar` }).toBe(true);
  await page.mouse.move(0, 0);
  // Establish keyboard modality before programmatic focus, so :focus-visible is exercised too.
  await control.evaluate(element => (element as HTMLElement).blur());
  await page.keyboard.press('Tab');
  await control.focus();
  await expect(control).toBeFocused();
  await expect.poll(() => hasGlow(true), { message: `${context}: keyboard focus must remain visible` }).toBe(true);
  await control.evaluate(element => (element as HTMLElement).blur());
}

test('all six pages keep transparent readable topbars with glowing controls in light/dark desktop and mobile without horizontal overflow', async ({ page, mock }) => {
  test.setTimeout(90_000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const name of ['总览', '会话', '好感度', '不理名单', '设置', '日志']) {
        await navigate(page, name);
        await page.evaluate(() => window.scrollTo(0, 0));
        const context = `${name}, ${theme}, ${width}px`;
        await expectTransparentReadableTopbar(page, context);
        const controls = page.locator('.topbar-tools button');
        await expect(controls).toHaveCount(3);
        for (let index = 0; index < 3; index++) await expectTopbarControlGlow(page, controls.nth(index), context);
        await expectNoDocumentOverflow(page, context);
      }
      if (width === 1440) {
        await navigate(page, '总览');
        await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/flow-panel-${theme}.png`, import.meta.url)), fullPage: true });
      }
    }
  }
  expect(mock.writes).toEqual([]);
});

test('six pages start flush with the viewport and reject top overscroll while retaining document scrolling', async ({ page, mock }) => {
  test.setTimeout(60_000);
  const expectFlushTop = async (context: string) => {
    await expect.poll(() => page.evaluate(() => ({
      scrollY: window.scrollY,
      boxes: ['.app-shell', '.main-canvas', '.topbar'].map(selector => {
        const element = document.querySelector(selector)!;
        return { selector, top: Math.round(element.getBoundingClientRect().top * 100) / 100, marginTop: getComputedStyle(element).marginTop };
      }),
    })), { message: `${context}: no 12px top margin, blank gap or negative overscroll` }).toEqual({
      scrollY: 0,
      boxes: ['.app-shell', '.main-canvas', '.topbar'].map(selector => ({ selector, top: 0, marginTop: '0px' })),
    });
  };
  for (const width of [1440, 390, 680]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['总览', '会话', '好感度', '不理名单', '设置', '日志']) {
      await navigate(page, name);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectFlushTop(`${name}, ${width}px`);
      for (const selector of ['html', 'body']) await expect(page.locator(selector)).toHaveCSS('overscroll-behavior-y', 'none');
      await page.mouse.move(width - 20, 100);
      await page.mouse.wheel(0, -700);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expectFlushTop(`${name}, ${width}px after wheel up at top`);
      await expectNoDocumentOverflow(page, `${name}, ${width}px flush top`);
      if (width === 1440 && name === '总览') await page.screenshot({ path: fileURLToPath(new URL('../../test-results/scroll-top-desktop.png', import.meta.url)) });
    }
    await navigate(page, '设置');
    await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight)).toBeGreaterThan(100);
    await page.mouse.move(width - 20, 350);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${width}px: long Settings content must still scroll the document` }).toBeGreaterThan(100);
    await expect.poll(() => page.locator('.app-shell, .main-canvas').evaluateAll(elements => elements.every(element =>
      element.scrollTop === 0 && !['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
    )), { message: 'Do not replace document scrolling with a nested app scroller' }).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expectFlushTop(`${width}px after returning from long content`);
  }
  expect(mock.writes).toEqual([]);
});

test('richer panel desktop light/dark keeps a viewport starfield, aligned cards and persistent effects controls without writes', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const starfield = await expectViewportStarfield(page, 160);
  await expect(starfield).toHaveAttribute('data-running', 'true');
  for (const theme of ['light', 'dark']) {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expectConnectionLayout(page, false);
    await expectNoDocumentOverflow(page, `richer ${theme} desktop`);
    await expect.poll(() => page.locator('.stat-card').evaluateAll(cards => cards.length === 6 && cards.every(card =>
      getComputedStyle(card, '::before').content === 'none' && getComputedStyle(card).backgroundImage.includes('gradient')
    )), { message: 'KPI cards should use an inner gradient, not the retired ::before gradient bars' }).toBe(true);
    await expectClickableControl(page.getByRole('button', { name: '关闭背景动效', exact: true }));
    await expectClickableControl(page.getByRole('button', { name: '切换主题', exact: true }));
    await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/richer-panel-${theme}.png`, import.meta.url)), fullPage: true });
    if (theme === 'light') await page.getByRole('button', { name: '切换主题', exact: true }).click();
  }
  await page.getByRole('button', { name: '关闭背景动效', exact: true }).click();
  await expect(starfield).toHaveAttribute('data-running', 'false');
  await expect(page.getByRole('button', { name: '开启背景动效', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('maid-effects'))).toBe('off');
  await page.reload();
  await expect(starfield).toHaveAttribute('data-running', 'false');
  await page.getByRole('button', { name: '开启背景动效', exact: true }).click();
  await expect(starfield).toHaveAttribute('data-running', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('maid-effects'))).toBe('on');
  await page.reload();
  await expect(starfield).toHaveAttribute('data-running', 'true');
  // The combined connection/identity stack aligns with quick actions at the actual 768px breakpoint.
  await page.setViewportSize({ width: 768, height: 1000 });
  await expectConnectionLayout(page, false);
  await expectNoDocumentOverflow(page, 'richer 768px desktop breakpoint');
  expect(mock.writes).toEqual([]);
});

test('richer panel mobile keeps natural cards, bounded scrolling canvas and clickable controls with reduced-motion freeze', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  const starfield = await expectViewportStarfield(page, 80);
  await expect(starfield).toHaveAttribute('data-running', 'true');
  const mobileCount = Number(await starfield.getAttribute('data-particle-count'));
  await expectMobileRail(page);
  await expectConnectionLayout(page, true);
  await expectNoDocumentOverflow(page, 'richer 390px mobile');
  await expectClickableControl(page.getByRole('button', { name: '关闭背景动效', exact: true }));
  await expectClickableControl(page.getByRole('button', { name: '切换主题', exact: true }));
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/richer-panel-mobile.png', import.meta.url)), fullPage: true });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expectViewportStarfield(page, 80);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // These real clicks also prove pointer-events:none leaves theme, effects and rail controls usable.
  await page.getByRole('button', { name: '关闭背景动效', exact: true }).click();
  await expect(starfield).toHaveAttribute('data-running', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('maid-effects'))).toBe('off');
  await page.getByRole('button', { name: '开启背景动效', exact: true }).click();
  await expect(starfield).toHaveAttribute('data-running', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('maid-effects'))).toBe('on');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await sidebarMenu(page).click();
  await expectExpandedSidebar(page, true);
  await sidebarMenu(page).click();
  await expectMobileRail(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(starfield).toHaveAttribute('data-running', 'false');
  await page.reload();
  await expect(starfield).toHaveAttribute('data-running', 'false');
  expect(await page.evaluate(() => localStorage.getItem('maid-effects'))).toBe('on');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(starfield).toHaveAttribute('data-running', 'true');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectViewportStarfield(page, 160);
  expect(Number(await starfield.getAttribute('data-particle-count')), 'Desktop should adapt to a richer particle density than phone').toBeGreaterThan(mobileCount);
  expect(mock.writes).toEqual([]);
});

test('dashboard preserves unknown, offline and error connection states without invented counts', async ({ page, mock }) => {
  mock.overview.status.onebotConnected = false;
  mock.overview.status.lastError = `MOCK 协议端断开：${'LongConnectionErrorWithoutSpaces'.repeat(12)}`;
  mock.groups = { groups: [], note: 'MOCK 未连接' };
  mock.friends = { friends: [], note: 'MOCK 未连接' };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator('.connection-status')).toContainText('OneBot 离线');
  await expect(page.locator('.connection-error')).toContainText(mock.overview.status.lastError);
  await expect(page.locator('.connection-metrics dd')).toHaveText(['—', '—', '7']);
  await expectNoDocumentOverflow(page, 'offline dashboard with long error');
  mock.overviewFailure = true;
  await page.reload();
  await expect(page.locator('.connection-status')).toContainText('连接状态未知');
  await expect(page.getByRole('alert').filter({ hasText: '总览读取失败' })).toBeVisible();
  await expect(page.locator('.connection-metrics dd')).toHaveText(['—', '—', '—']);
  await expectNoDocumentOverflow(page, 'unknown dashboard');
  expect(mock.writes).toEqual([]);
});

test('collapsed desktop brand rests on 助 and reveals the same toggle on hover or keyboard focus', async ({ page, mock }) => {
  await sidebarMenu(page).click();
  const menu = sidebarMenu(page);
  const mark = menu.locator('.rail-brand-mark');
  const icon = menu.locator('svg.lucide-panel-left');
  await page.mouse.move(500, 400);
  await menu.evaluate(element => (element as HTMLElement).blur());
  await expect(mark).toBeVisible();
  await expect(icon).toHaveCSS('opacity', '0');
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/compact-sidebar-rest.png', import.meta.url)) });
  await menu.hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await expect(mark).not.toBeVisible();
  await page.mouse.move(500, 400);
  await page.keyboard.press('Tab');
  await menu.focus();
  await expect(menu).toBeFocused();
  await expect(icon).toHaveCSS('opacity', '1');
  await menu.press('Enter');
  await expectExpandedSidebar(page, false);
  expect(mock.writes).toEqual([]);
});

test.describe('phone touch toggle', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('first tap on the resting 助 opens the drawer without a hover prerequisite', async ({ page, mock }) => {
    await expectMobileRail(page);
    await expect(sidebarMenu(page).locator('.rail-brand-mark')).toHaveCSS('opacity', '1');
    await expect(sidebarMenu(page).locator('svg.lucide-panel-left')).toHaveCSS('opacity', '0');
    await sidebarMenu(page).tap();
    await expectExpandedSidebar(page, true);
    await sidebarMenu(page).tap();
    await expectMobileRail(page);
    expect(mock.writes).toEqual([]);
  });
});

test('mobile brand menu navigates all pages and leaves a usable rail', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expectMobileRail(page);
  for (const name of ['会话', '好感度', '不理名单', '设置', '日志', '总览']) {
    await sidebarMenu(page).click();
    await expectExpandedSidebar(page, true);
    await navigate(page, name);
    await expectMobileRail(page);
    await expectNoDocumentOverflow(page, name);
  }
  // Icon-only navigation remains interactive even without opening the drawer.
  await navigate(page, '好感度');
  await expectMobileRail(page);
  expect(mock.writes).toEqual([]);
});

test('desktop brand menu collapses to a 56px rail and preserves the content offset', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sidebar = page.locator('.sidebar');
  const canvas = page.locator('.main-canvas');
  await expectExpandedSidebar(page, false);
  const expandedLeft = await canvas.evaluate(element => element.getBoundingClientRect().left);
  await sidebarMenu(page).click();
  await expect(sidebar).toHaveClass(/collapsed/);
  await expectSidebarButton(page, false);
  await expect(page.locator('.brand-copy')).not.toBeVisible();
  await expect(page.locator('.brand-mark')).not.toBeVisible();
  await expect(page.locator('.nav-text').first()).not.toBeVisible();
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(56, 0);
  await expect.poll(() => canvas.evaluate(element => element.getBoundingClientRect().left)).toBeCloseTo(56, 0);
  await expect.poll(() => canvas.evaluate(element => element.getBoundingClientRect().left)).toBeLessThan(expandedLeft - 50);
  await sidebarMenu(page).click();
  await expectExpandedSidebar(page, false);
  await expect.poll(() => canvas.evaluate(element => element.getBoundingClientRect().left)).toBeCloseTo(expandedLeft, 0);
  expect(mock.writes).toEqual([]);
});

for (const width of [280, 320, 390, 680]) {
  test(`initial ${width}px mobile load keeps the rail visible and all drawer dismissal paths usable`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 1000 });
    // Exercise matchMedia's initial state, not only a resize from the desktop fixture.
    await page.reload();
    await expect(page.locator('.topbar-title')).toHaveText('总览');
    await expectMobileRail(page);
    await sidebarMenu(page).click();
    await expectExpandedSidebar(page, true);
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('../../test-results/mock-mobile-sidebar.png', import.meta.url)) });
    await sidebarMenu(page).click();
    await expectMobileRail(page);
    await sidebarMenu(page).click();
    await expectExpandedSidebar(page, true);
    await page.keyboard.press('Escape');
    await expectMobileRail(page);
    await sidebarMenu(page).click();
    await expectExpandedSidebar(page, true);
    // Click the uncovered strip: the backdrop extends beneath the drawer.
    await page.locator('.mobile-backdrop').click({ position: { x: width - 2, y: 300 } });
    await expectMobileRail(page);
    await sidebarMenu(page).click();
    await navigate(page, '日志');
    await expectMobileRail(page);
    expect(mock.writes).toEqual([]);
  });
}

test('desktop expanded and collapsed preferences survive mobile, narrow-mobile and breakpoint resizes', async ({ page, mock }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const desktopCollapsed of [false, true]) {
    await expectExpandedSidebar(page, false);
    if (desktopCollapsed) await sidebarMenu(page).click();
    await expectSidebarButton(page, !desktopCollapsed);
    for (const width of [767, 280, 680, 320, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectMobileRail(page);
      await sidebarMenu(page).click();
      await expectExpandedSidebar(page, true);
      // Same-breakpoint resizes keep a drawer usable; crossing back to desktop closes it.
      await page.setViewportSize({ width: width === 680 ? 320 : 680, height: 1000 });
      await expectExpandedSidebar(page, true);
      await page.setViewportSize({ width: 768, height: 1000 });
      await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
      await expect(page.locator('.mobile-backdrop')).not.toBeVisible();
      await expectSidebarButton(page, !desktopCollapsed);
      if (desktopCollapsed) {
        await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);
        await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(56, 0);
      } else await expectExpandedSidebar(page, false);
      await expectNoDocumentOverflow(page, `desktop preference at ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (desktopCollapsed) await sidebarMenu(page).click();
  }
  expect(mock.writes).toEqual([]);
});

test('mobile drawer traps keyboard focus, inerts only the main content and returns focus to the rail toggle', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expectMobileRail(page);
  const menu = sidebarMenu(page);
  const sidebar = page.locator('.sidebar');
  const main = page.locator('.main-canvas');
  const lastNav = sidebar.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^日志/ });
  await menu.focus();
  await menu.press('Enter');
  await expectExpandedSidebar(page, true);
  await expect(main).toHaveJSProperty('inert', true);
  await expect(sidebar).toHaveJSProperty('inert', false);
  await expect(menu).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastNav).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeFocused();
  // Traverse more than a full cycle: no tab stop may escape into the obscured page.
  for (let index = 0; index < 15; index++) {
    await page.keyboard.press('Tab');
    expect(await sidebar.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expectMobileRail(page);
  await expect(main).toHaveJSProperty('inert', false);
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(lastNav).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.topbar-title')).toHaveText('日志');
  await expectMobileRail(page);
  await expect(main).toHaveJSProperty('inert', false);
  await expect(menu).toBeFocused();
  await menu.press('Enter');
  await expectExpandedSidebar(page, true);
  await page.locator('.mobile-backdrop').click({ position: { x: 388, y: 300 } });
  await expectMobileRail(page);
  await expect(menu).toBeFocused();
  expect(mock.writes).toEqual([]);
});

for (const width of [844, 680]) {
  test(`short ${width}x390 landscape sidebar scrolls lower navigation and keeps its toggle reachable`, async ({ page, mock }) => {
    await page.setViewportSize({ width, height: 390 });
    await page.reload();
    if (width <= 767) {
      await expectMobileRail(page);
      await sidebarMenu(page).click();
    }
    await expectExpandedSidebar(page, width <= 767);
    const sidebar = page.locator('.sidebar');
    const logs = sidebar.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^日志/ });
    await expect.poll(() => sidebar.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await logs.scrollIntoViewIfNeeded();
    await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await logs.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight + 1 && rect.height >= 40;
    })).toBe(true);
    await logs.click();
    await expect(page.locator('.topbar-title')).toHaveText('日志');
    await sidebar.evaluate(element => { element.scrollTop = 0; });
    if (width <= 767) await expectMobileRail(page);
    else await expectSidebarButton(page, true);
    // The brand control remains usable after visiting content below the fold.
    await sidebarMenu(page).click();
    if (width <= 767) {
      await expectExpandedSidebar(page, true);
      await page.keyboard.press('Escape');
      await expectMobileRail(page);
    } else {
      await expect(sidebar).toHaveClass(/collapsed/);
      await expectSidebarButton(page, false);
      await sidebarMenu(page).click();
      await expectExpandedSidebar(page, false);
    }
    await expectNoDocumentOverflow(page, `${width}x390 landscape`);
    expect(mock.writes).toEqual([]);
  });
}

const longFavorNickname = `MOCK超长昵称${'LongNicknameWithoutSpaces'.repeat(8)}结尾`;
const longFavorRelation = `MOCK超长关系${'LongRelationshipWithoutSpaces'.repeat(6)}结尾`;

function manyFavors(count = 235): PanelFavor[] {
  const names = ['小星', '秋月', '晚风', '春雨', '青柠', '橘子'];
  return Array.from({ length: count }, (_, index) => ({
    qq: String(910000000 + index), nickname: `MOCK ${names[index % names.length]} ${String(index + 1).padStart(3, '0')}`,
    avatar: '', score: index === 1 ? 999 : index - 100, levelIndex: index % 5, levelName: index < 100 ? '初识' : '相识',
    isMaster: index === 1, dailyGain: index % 7, updatedAt: now + index * 1000,
  }));
}
function favorRows(page: Page) { return page.locator('.favors-panel .favor-row'); }
function favorRow(page: Page, qq: string) { return page.locator(`.favor-row[data-qq="${qq}"]`); }
async function openFavorEditor(page: Page, favor: PanelFavor) {
  await favorRow(page, favor.qq).getByRole('button', { name: `调整${favor.nickname}的好感度`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '调整好感度', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const count of [235, 300]) {
  test(`compact favors paginate ${count} synthetic members, search resets pages, sort high/low and refresh clamps`, async ({ page, mock }) => {
    mock.favors = manyFavors(count);
    await page.setViewportSize({ width: 390, height: 844 });
    await navigate(page, '好感度');
    const rows = favorRows(page);
    const paging = page.getByRole('navigation', { name: '好感度分页', exact: true });
    const next = paging.getByRole('button', { name: '下一页', exact: true });
    const previous = paging.getByRole('button', { name: '上一页', exact: true });
    const search = page.getByRole('searchbox', { name: '搜索好感度', exact: true });
    const sort = page.getByRole('combobox', { name: '好感度排序', exact: true });
    await expect(rows).toHaveCount(20);
    await expect(previous).toBeDisabled();
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[0].qq);
    await expect.poll(() => rows.evaluateAll(elements => elements.filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }).length), { message: '390×844 must show at least six complete compact member summaries' }).toBeGreaterThanOrEqual(6);
    await expectContained(page, '.favors-panel');
    if (count === 235) await page.screenshot({ path: fileURLToPath(new URL('../../test-results/compact-mobile-favors.png', import.meta.url)) });
    await next.click();
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[20].qq);
    await previous.click();
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[0].qq);
    await next.click();
    await search.fill(mock.favors[204].qq);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[204].qq);
    await expect(paging).toContainText('第 1 / 1 页');
    await search.fill('MOCK 不存在的成员');
    await expect(rows).toHaveCount(0);
    await expect(page.getByText('没有匹配「MOCK 不存在的成员」的记录。', { exact: true })).toBeVisible();
    await search.fill('');
    await expect(rows).toHaveCount(20);
    await sort.selectOption('score-desc');
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[1].qq);
    await sort.selectOption('score-asc');
    await expect(rows.first()).toHaveAttribute('data-qq', mock.favors[0].qq);
    await expect(rows.nth(1)).toHaveAttribute('data-qq', mock.favors[2].qq);
    await sort.selectOption('default');
    await next.click();
    await next.click();
    await expect(paging).toContainText('第 3 /');
    mock.favors = mock.favors.slice(0, 21);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(paging).toContainText('第 2 / 2 页');
    await expect(rows).toHaveCount(1);
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(rows).toHaveCount(20);
    expect(mock.writes).toEqual([]);
  });
}

test('favor summaries ellipsize long names, disclose full details and switch to a desktop table without losing drafts', async ({ page, mock }) => {
  mock.favors = manyFavors();
  const member = mock.favors[0];
  member.nickname = longFavorNickname; member.levelName = longFavorRelation;
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '好感度');
  const row = favorRow(page, member.qq);
  await expect(row.locator('.favor-name')).toHaveCSS('text-overflow', 'ellipsis');
  await expect.poll(() => row.locator('.favor-name').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(page.locator('.favor-details')).toHaveCount(0);
  await row.getByRole('button', { name: `查看${member.nickname}的详情`, exact: true }).click();
  const details = page.locator(`.favor-details[data-qq="${member.qq}"]`);
  await expect(details).toContainText(longFavorNickname);
  await expect(details).toContainText(member.qq);
  await expect(details).toContainText(longFavorRelation);
  await expectWrappedText(details.locator('.favor-full-name dd'));
  for (const label of ['完整昵称', '今日增长', '身份', '更新时间']) await expect(details.getByText(label, { exact: true })).toBeVisible();
  await row.getByRole('button', { name: `查看${member.nickname}的详情`, exact: true }).click();
  // Adjust opens the editor directly; it must not also open the disclosure.
  let editor = await openFavorEditor(page, member);
  await expect(page.locator('.favor-details')).toHaveCount(0);
  const input = editor.getByRole('spinbutton', { name: `${member.nickname}的好感度分数`, exact: true });
  await input.fill('77');
  for (const width of [1001, 1000, 680, 280, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(input).toHaveValue('77');
    await expectContained(page, '[role="dialog"]');
  }
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('.favor-list thead')).toBeVisible();
  const paging = page.getByRole('navigation', { name: '好感度分页', exact: true });
  await paging.getByRole('button', { name: '下一页', exact: true }).click();
  await paging.getByRole('button', { name: '上一页', exact: true }).click();
  mock.favors[0].score = 31;
  const priorGets = mock.gets['/api/favors'];
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => mock.gets['/api/favors']).toBeGreaterThan(priorGets);
  editor = await openFavorEditor(page, member);
  await expect(editor.getByRole('spinbutton')).toHaveValue('77');
  // Also observe a scheduled GET, not only an explicit refresh.
  const pollGets = mock.gets['/api/favors'];
  await expect.poll(() => mock.gets['/api/favors'], { timeout: 10_000 }).toBeGreaterThan(pollGets);
  await expect(editor.getByRole('spinbutton')).toHaveValue('77');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  for (const width of [1000, 680, 390, 280]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(favorRows(page)).toHaveCount(20);
    await expectContained(page, '.favors-panel');
  }
  expect(mock.writes).toEqual([]);
});

test('favor modal saves by button and Enter, retains a failed draft for retry, and never edits the master', async ({ page, mock }) => {
  mock.favors = manyFavors();
  const member = mock.favors[0], master = mock.favors[1];
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '好感度');
  let editor = await openFavorEditor(page, member);
  await editor.getByRole('spinbutton').fill('88');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(favorRow(page, member.qq).locator('.favor-score')).toHaveText('88');
  editor = await openFavorEditor(page, member);
  await editor.getByRole('spinbutton').fill('89');
  await editor.getByRole('spinbutton').press('Enter');
  await expect(editor).not.toBeVisible();
  await expect(favorRow(page, member.qq).locator('.favor-score')).toHaveText('89');
  mock.favorSaveFailures = 1;
  editor = await openFavorEditor(page, member);
  await editor.getByRole('spinbutton').fill('91');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('改分失败：MOCK 保存失败');
  await expect(editor.getByRole('spinbutton')).toBeEnabled();
  await expect(editor.getByRole('spinbutton')).toHaveValue('91');
  expect(member.score).toBe(89);
  await expectContained(page, '[role="dialog"]');
  await editor.getByRole('button', { name: '保存', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(favorRow(page, member.qq).locator('.favor-score')).toHaveText('91');
  const masterRow = favorRow(page, master.qq);
  await expect(masterRow).toContainText('999');
  await expect(masterRow).toContainText('锁定');
  await expect(masterRow.locator('.favor-adjust')).toHaveCount(0);
  await masterRow.getByRole('button', { name: `查看${master.nickname}的详情`, exact: true }).click();
  await expect(page.locator(`.favor-details[data-qq="${master.qq}"]`)).toContainText('不可修改');
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  expect(master.score).toBe(999);
  expect(mock.writes).toEqual([88, 89, 91, 91].map(score => ({ path: '/api/favors', method: 'POST', body: { qq: member.qq, score } })));
});

for (const width of [280, 390, 680]) {
  test(`ignores at ${width}px keep long identities contained, show full details and require explicit release confirmation`, async ({ page, mock }) => {
    const template = mock.ignores[0];
    mock.ignores = Array.from({ length: 43 }, (_, index) => ({ ...template, qq: String(920000000 + index), nickname: `MOCK 暂停成员 ${index + 1}` }));
    const member = mock.ignores[0];
    member.nickname = `MOCK超长暂停昵称${'LongIgnoredNickname'.repeat(9)}`;
    member.qq = '1234567890123456789012345678901234567890';
    member.sessionName = `MOCK超长群名${'LongGroupWithoutSpaces'.repeat(9)}`;
    member.sessionKey = `group:${'9876543210'.repeat(6)}`;
    await page.setViewportSize({ width, height: 844 });
    await navigate(page, '不理名单');
    const rows = page.locator('.ignore-row');
    const row = rows.first();
    await expect(rows).toHaveCount(20);
    await expect(row.locator('.ignore-details')).not.toBeVisible();
    await expect(row.locator('.ignore-name')).toHaveCSS('text-overflow', 'ellipsis');
    await expect(row.locator('.ignore-session')).toHaveCSS('text-overflow', 'ellipsis');
    await expectContained(page, '.ignores-panel');
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('../../test-results/compact-mobile-ignores.png', import.meta.url)) });
    await row.getByRole('button', { name: `查看${member.nickname}的详情`, exact: true }).click();
    const details = row.locator('.ignore-details');
    await expect(details).toBeVisible();
    for (const value of [member.nickname, member.qq, member.sessionName, member.sessionKey, member.untilText]) await expect(details).toContainText(value);
    await expect(details.locator('dt')).toHaveText(['成员', 'QQ', '所在会话', '累计次数', '剩余时长', '解除时间']);
    await expectContained(page, '.ignores-panel');
    await row.getByRole('button', { name: `解除${member.nickname}的不理`, exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: '解除不理', exact: true });
    await expect(confirmation).toContainText(member.nickname);
    await expect(confirmation).toContainText(member.sessionName);
    await expectContained(page, '[role="dialog"]');
    expect(mock.writes).toEqual([]);
    await confirmation.getByRole('button', { name: '取消', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    expect(mock.writes).toEqual([]);
    await row.getByRole('button', { name: `解除${member.nickname}的不理`, exact: true }).click();
    await confirmation.getByRole('button', { name: '确认解除', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).not.toContainText(member.nickname);
    expect(mock.writes).toEqual([{ path: '/api/ignores', method: 'POST', body: { sessionKey: member.sessionKey, qq: member.qq, action: 'release' } }]);
    const paging = page.getByRole('navigation', { name: '不理名单分页', exact: true });
    await paging.getByRole('button', { name: '不理名单下一页', exact: true }).click();
    await expect(rows).toHaveCount(20);
    await paging.getByRole('button', { name: '不理名单下一页', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await expect(paging.getByRole('button', { name: '不理名单下一页', exact: true })).toBeDisabled();
    const search = page.getByRole('textbox', { name: '搜索不理名单', exact: true });
    await search.fill(mock.ignores[0].qq);
    await expect(rows).toHaveCount(1);
    await expect(paging).toContainText('第 1 / 1 页');
    await search.fill('');
    await expect(rows).toHaveCount(20);
    await expectContained(page, '.ignores-panel');
  });
}

test('Settings saved-config test row stays static inside the main-model card, wraps and never submits drafts', async ({ page, mock }) => {
  test.setTimeout(60_000);
  const savedConfig = structuredClone(mock.config);
  const draftKey = 'mock-unsaved-secret-never-submit';
  const draftPersona = 'MOCK 未保存人格：连通测试绝不能提交。';
  await navigate(page, '设置');
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill(draftPersona);
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await page.locator('input[aria-label="API Key"]').fill(draftKey);
  const row = page.locator('.settings-test-actions');
  const button = row.getByRole('button', { name: '测试已保存配置', exact: true });
  const card = page.locator('.ui-card').filter({ has: page.getByRole('heading', { name: '主模型', exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(card.locator('.settings-test-actions')).toHaveCount(1);
  await expect(row).not.toHaveClass(/\bsettings-actions\b/);
  await expect(page.locator('.settings-actions')).toHaveCount(1);
  await expect(page.locator('.settings-actions')).toHaveCSS('position', 'sticky');
  const geometry = () => row.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const card = element.closest('.ui-card')!.getBoundingClientRect();
    return { top: rect.top, docTop: rect.top + window.scrollY, scrollY: window.scrollY,
      contained: rect.top >= card.top && rect.bottom <= card.bottom + 1 && rect.left >= card.left && rect.right <= card.right + 1 };
  });
  for (const width of [280, 390, 680, 1440]) {
    // Short viewports leave enough real content below the row to cross its normal top position.
    await page.setViewportSize({ width, height: width === 1440 ? 240 : 390 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(row).toHaveCSS('position', 'static');
    await expect(row).toHaveCSS('flex-wrap', 'wrap');
    await expect.poll(() => row.evaluate(element => parseFloat(getComputedStyle(element).borderTopWidth))).toBeGreaterThan(0);
    await expect.poll(() => row.evaluate(element => parseFloat(getComputedStyle(element).paddingTop))).toBeGreaterThan(0);
    await expectContained(page, '.settings-test-actions');
    const before = await geometry();
    expect(before.contained, `${width}px: test row belongs inside 主模型, not an independent floating toolbar`).toBe(true);
    expect(before.docTop).toBeGreaterThan(100);
    await page.evaluate(top => window.scrollTo(0, top - 100), before.docTop);
    await expect.poll(async () => Math.abs((await geometry()).top - 100)).toBeLessThanOrEqual(1);
    const nearTop = await geometry();
    await page.evaluate(() => window.scrollBy(0, 160));
    await expect.poll(async () => (await geometry()).scrollY - nearTop.scrollY).toBeGreaterThan(100);
    const after = await geometry();
    expect(Math.abs(after.docTop - before.docTop), `${width}px: absolute document position must not change while scrolling`).toBeLessThanOrEqual(1);
    expect(Math.abs((after.top - nearTop.top) + (after.scrollY - nearTop.scrollY)), `${width}px: row must move by -scrollDelta, never stick`).toBeLessThanOrEqual(1);
    expect(after.top).toBeLessThan(0);
    expect(after.contained).toBe(true);
    if (width === 390) {
      // Show the test block with its surrounding model fields and fallback card, not an isolated crop.
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(top => window.scrollTo(0, top - 420), before.docTop);
      await expectClickableControl(button);
      await page.screenshot({ path: fileURLToPath(new URL('../../test-results/scroll-settings-mobile.png', import.meta.url)) });
      await button.click();
      await expect.poll(() => mock.writes).toHaveLength(1);
      await expect(card.getByRole('status')).toContainText('MOCK 模型测试成功');
      await expect(button).toBeEnabled();
      expect(mock.writes).toEqual([{ path: '/api/llm/test', method: 'POST', body: {} }]);
    }
  }
  await expect(page.locator('input[aria-label="API Key"]')).toHaveValue(draftKey);
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue(draftPersona);
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  expect(mock.config).toEqual(savedConfig);
  expect(mock.writes).toEqual([{ path: '/api/llm/test', method: 'POST', body: {} }]);
  expect(mock.writes.filter(write => write.path === '/api/config')).toEqual([]);
  expect(JSON.stringify(mock.writes)).not.toContain(draftKey);
  expect(JSON.stringify(mock.writes)).not.toContain(draftPersona);
});

test('profiles display/save/apply/delete while preserving unsaved persona; config patch is minimal', async ({ page, mock }) => {
  await navigate(page, '设置');
  const profile = page.getByRole('combobox', { name: '已保存档案（选择立即生效）', exact: true });
  await expect(profile).toHaveValue('mock-main');
  await expect(profile.locator('option')).toHaveCount(3);
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill('MOCK 未保存人格，档案操作后必须保留。');
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  // Settings is read once and kept mounted; profile responses must not replace its local draft.
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK 未保存人格，档案操作后必须保留。');
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await page.getByRole('textbox', { name: '新档案名称', exact: true }).fill('MOCK 新档案');
  await page.getByRole('button', { name: '存为新档案', exact: true }).click();
  await expect(profile.locator('option')).toHaveCount(4);
  expect(mock.writes.find(write => write.path === '/api/llm/profiles')?.body).toEqual({ name: 'MOCK 新档案', baseUrl: 'https://mock-primary.invalid/v1', model: 'mock-primary' });
  await profile.selectOption('mock-backup');
  await expect(page.getByRole('textbox', { name: '接口地址', exact: true })).toHaveValue('https://mock-backup.invalid/v1');
  await expect(page.getByRole('textbox', { name: '模型名称', exact: true })).toHaveValue('mock-backup-model');
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK 未保存人格，档案操作后必须保留。');
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除档案', exact: true });
  await expect(deletion).toContainText('不影响正在使用的接口');
  await deletion.getByRole('button', { name: '确认删除档案', exact: true }).click();
  await expect(profile.locator('option')).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: '模型名称', exact: true })).toHaveValue('mock-backup-model');
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK 未保存人格，档案操作后必须保留。');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => mock.writes.filter(write => write.path === '/api/config')).toHaveLength(1);
  expect(mock.writes.find(write => write.path === '/api/config')?.body).toEqual({ persona: { systemPrompt: 'MOCK 未保存人格，档案操作后必须保留。' } });
  await expect(page.getByText('已与保存配置同步', { exact: true })).toBeVisible();
});

const primaryMasterQQ = '940000001';
const secondaryMasterQQ = '940000002';
const configWrites = (mock: MockPanel) => mock.writes.filter(write => write.path === '/api/config');
async function openMasterSettings(page: Page) {
  await navigate(page, '设置');
  await page.getByRole('button', { name: '老大身份', exact: true }).click();
  return page.locator('.master-settings-card');
}
async function setDualMaster(page: Page, enabled: boolean) {
  const toggle = page.getByRole('switch', { name: '启用二老大', exact: true });
  if (await toggle.isChecked() !== enabled) { await toggle.focus(); await toggle.press('Space'); }
  await expect(toggle).toBeChecked({ checked: enabled });
}
async function saveMasterRoles(page: Page, mock: MockPanel, roles: Config['bot']['masterRoles']) {
  const count = configWrites(mock).length;
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect.poll(() => configWrites(mock).length).toBe(count + 1);
  await expect(page.getByText('已与保存配置同步', { exact: true })).toBeVisible();
  expect(configWrites(mock).at(-1)).toEqual({ path: '/api/config', method: 'POST', body: { bot: { masterRoles: roles } } });
}

test('master settings default empty, save none/single/dual transitions and derive effective legacy IDs without persona or secrets', async ({ page, mock }) => {
  // A stale legacy cache cannot populate authoritative empty slots or claim a default owner.
  mock.config.bot.masterIds = ['949999999'];
  await page.reload();
  const savedPersona = structuredClone(mock.config.persona);
  const card = await openMasterSettings(page);
  const primary = page.getByRole('textbox', { name: '第一老大 QQ', exact: true });
  const secondary = page.getByRole('textbox', { name: '二老大 QQ', exact: true });
  await expect(primary).toHaveValue('');
  await expect(card).not.toContainText('949999999');
  await expect(page.getByRole('switch', { name: '启用二老大', exact: true })).not.toBeChecked();
  await expect(secondary).toHaveCount(0);
  await expect(card.getByRole('status')).toContainText('无老大');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await expect(card.locator('input')).toHaveCount(2); // One QQ input and the switch, never a legacy ID list.
  await primary.fill(primaryMasterQQ);
  await saveMasterRoles(page, mock, { primaryId: primaryMasterQQ, secondaryId: '', dualEnabled: false });
  expect(mock.overview.masterStatus?.mode).toBe('single');
  expect(mock.config.bot.masterIds).toEqual([primaryMasterQQ]);
  await setDualMaster(page, true);
  await expect(secondary).toBeVisible();
  await secondary.fill(secondaryMasterQQ);
  await saveMasterRoles(page, mock, { primaryId: primaryMasterQQ, secondaryId: secondaryMasterQQ, dualEnabled: true });
  expect(mock.overview.masterStatus).toEqual({ mode: 'dual', primary: mockMaster(primaryMasterQQ, 'primary'), secondary: mockMaster(secondaryMasterQQ, 'secondary') });
  expect(mock.config.bot.masterIds).toEqual([primaryMasterQQ, secondaryMasterQQ]);
  await setDualMaster(page, false);
  await expect(secondary).toHaveCount(0);
  await saveMasterRoles(page, mock, { primaryId: primaryMasterQQ, secondaryId: secondaryMasterQQ, dualEnabled: false });
  expect(mock.overview.masterStatus?.mode).toBe('single');
  expect(mock.overview.masterStatus?.secondary).toBeNull();
  expect(mock.config.bot.masterIds).toEqual([primaryMasterQQ]);
  await setDualMaster(page, true);
  await expect(secondary).toHaveValue(secondaryMasterQQ);
  await secondary.fill(''); await primary.fill('');
  await setDualMaster(page, false);
  await saveMasterRoles(page, mock, { primaryId: '', secondaryId: '', dualEnabled: false });
  expect(mock.overview.masterStatus).toEqual({ mode: 'none', primary: null, secondary: null });
  expect(mock.config.bot.masterIds).toEqual([]);
  expect(mock.config.persona).toEqual(savedPersona);
  expect(mock.writes).toHaveLength(4);
  expect(JSON.stringify(mock.writes)).not.toMatch(/masterIds|persona|apiKey|accessToken/);
});

test('master settings reject invalid QQ, duplicate roles and secondary without primary before any POST and retain drafts', async ({ page, mock }) => {
  const card = await openMasterSettings(page);
  const primary = page.getByRole('textbox', { name: '第一老大 QQ', exact: true });
  const secondary = page.getByRole('textbox', { name: '二老大 QQ', exact: true });
  const save = page.getByRole('button', { name: '保存设置', exact: true });
  for (const invalid of ['abc123', '1234', '1234567890123456']) {
    await primary.fill(invalid); await save.click();
    await expect(card.getByRole('alert')).toContainText('第一老大 QQ');
    await expect(primary).toHaveValue(invalid);
    expect(mock.writes).toEqual([]);
  }
  await primary.fill(primaryMasterQQ); await setDualMaster(page, true);
  await secondary.fill('bad-secondary'); await save.click();
  await expect(card.getByRole('alert')).toContainText('二老大 QQ');
  expect(mock.writes).toEqual([]);
  await secondary.fill(primaryMasterQQ); await save.click();
  await expect(card.getByRole('alert')).toContainText('同一个 QQ');
  await expect(secondary).toHaveValue(primaryMasterQQ);
  expect(mock.writes).toEqual([]);
  await secondary.fill(secondaryMasterQQ); await primary.fill(''); await save.click();
  await expect(card.getByRole('alert')).toContainText('请先填写第一老大 QQ');
  await setDualMaster(page, false); await save.click();
  await expect(card.getByRole('alert')).toContainText('请先填写第一老大 QQ');
  expect(mock.writes).toEqual([]);
  // Validation from another category must bring the actual invalid owner draft back into view.
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await save.click();
  await expect(card).toBeVisible();
  await expect(primary).toHaveValue('');
  await setDualMaster(page, true);
  await expect(secondary).toHaveValue(secondaryMasterQQ);
  expect(mock.config.bot.masterRoles).toEqual({ primaryId: '', secondaryId: '', dualEnabled: false });
  expect(mock.writes).toEqual([]);
});

test('master settings keep a backend-rejected role draft and saved state unchanged until explicit retry', async ({ page, mock }) => {
  await openMasterSettings(page);
  const primary = page.getByRole('textbox', { name: '第一老大 QQ', exact: true });
  await primary.fill(primaryMasterQQ); await setDualMaster(page, true);
  await page.getByRole('textbox', { name: '二老大 QQ', exact: true }).fill(secondaryMasterQQ);
  mock.configSaveFailures = 1;
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'MOCK 老大身份保存被服务端拒绝' })).toBeVisible();
  expect(configWrites(mock)).toHaveLength(1);
  expect(mock.config.bot.masterRoles).toEqual({ primaryId: '', secondaryId: '', dualEnabled: false });
  expect(mock.overview.masterStatus?.mode).toBe('none');
  await navigate(page, '日志'); await openMasterSettings(page);
  await expect(primary).toHaveValue(primaryMasterQQ);
  await expect(page.getByRole('textbox', { name: '二老大 QQ', exact: true })).toHaveValue(secondaryMasterQQ);
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  await saveMasterRoles(page, mock, { primaryId: primaryMasterQQ, secondaryId: secondaryMasterQQ, dualEnabled: true });
  expect(configWrites(mock)[0].body).toEqual(configWrites(mock)[1].body);
  await navigate(page, '总览');
  await expect(page.locator('.master-status-card')).toContainText('MOCK 二老大');
});

test('profile save/apply/delete preserve unsaved master roles and persona without submitting either draft', async ({ page, mock }) => {
  await openMasterSettings(page);
  await page.getByRole('textbox', { name: '第一老大 QQ', exact: true }).fill(primaryMasterQQ);
  await setDualMaster(page, true);
  await page.getByRole('textbox', { name: '二老大 QQ', exact: true }).fill(secondaryMasterQQ);
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  const personaDraft = 'MOCK 人格草稿与身份草稿不能被接口档案覆盖';
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill(personaDraft);
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await page.getByRole('textbox', { name: '新档案名称', exact: true }).fill('MOCK 身份草稿档案');
  await page.getByRole('button', { name: '存为新档案', exact: true }).click();
  const profile = page.getByRole('combobox', { name: '已保存档案（选择立即生效）', exact: true });
  await expect(profile.locator('option')).toHaveCount(4);
  await profile.selectOption('mock-backup');
  await expect(page.getByRole('textbox', { name: '模型名称', exact: true })).toHaveValue('mock-backup-model');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除档案', exact: true }).getByRole('button', { name: '确认删除档案', exact: true }).click();
  await expect(profile.locator('option')).toHaveCount(3);
  await navigate(page, '总览');
  await expect(page.locator('.master-status-card')).toContainText('无老大、无主人');
  await openMasterSettings(page);
  await expect(page.getByRole('textbox', { name: '第一老大 QQ', exact: true })).toHaveValue(primaryMasterQQ);
  await expect(page.getByRole('textbox', { name: '二老大 QQ', exact: true })).toHaveValue(secondaryMasterQQ);
  await expect(page.getByRole('switch', { name: '启用二老大', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue(personaDraft);
  expect(configWrites(mock)).toEqual([]);
  expect(mock.writes.map(write => write.path)).toEqual(['/api/llm/profiles', '/api/llm/profiles/apply', '/api/llm/profiles/delete']);
  expect(JSON.stringify(mock.writes)).not.toMatch(/masterRoles|masterIds|persona|apiKey/);
});

test('readonly master overview renders none/single/dual and unknown states below connection in light/dark mobile without writes', async ({ page, mock }) => {
  test.setTimeout(90_000);
  const card = page.locator('.dashboard-middle > .dashboard-connection-stack > .master-status-card');
  await expect(card).toContainText('无老大、无主人');
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/masters-overview-none.png', import.meta.url)), fullPage: true });
  for (const mode of ['none', 'single', 'dual'] as const) {
    mock.overview.masterStatus = { mode, primary: mode === 'none' ? null : mockMaster(primaryMasterQQ, 'primary'), secondary: mode === 'dual' ? mockMaster(secondaryMasterQQ, 'secondary') : null };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.reload();
      for (const theme of ['light', 'dark']) {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
        await expect(card.getByRole('heading', { name: '老大身份', exact: true })).toBeVisible();
        await expect(card).toContainText({ none: '无老大', single: '单老大', dual: '双老大' }[mode]);
        await expect(card.locator('input, textarea, select, button, [role="switch"], [role="button"]')).toHaveCount(0);
        await expect(card.locator('.master-status-member')).toHaveCount(mode === 'none' ? 0 : mode === 'single' ? 1 : 2);
        if (mode !== 'none') {
          await expect(card.locator('.master-status-primary')).toContainText('MOCK 第一老大');
          await expect(card.locator('.master-status-primary')).toContainText(primaryMasterQQ);
        }
        if (mode === 'dual') {
          await expect(card.locator('.master-status-secondary')).toContainText('二老大');
          await expect(card.locator('.master-status-secondary')).toContainText('MOCK 二老大');
          await expect(card.locator('.master-status-secondary')).toContainText(secondaryMasterQQ);
        }
        await expectConnectionLayout(page, width < 768);
        await expectContained(page, '.master-status-card');
        if (theme === 'light' && width === 1440 && mode !== 'none') await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/masters-overview-${mode}.png`, import.meta.url)), fullPage: true });
      }
    }
  }
  delete mock.overview.masterStatus;
  let releaseOverview!: () => void;
  mock.overviewGate = new Promise<void>(resolve => { releaseOverview = resolve; });
  await page.reload();
  try {
    await expect(card).toContainText('正在读取老大身份');
    await expect(card).not.toContainText('无老大、无主人');
    await expect(card.locator('.master-status-member')).toHaveCount(0);
  } finally { mock.overviewGate = undefined; releaseOverview(); }
  await expect(card).toContainText('老大身份未知');
  await expect(card).not.toContainText('无老大、无主人');
  await expect(card.locator('.master-status-member')).toHaveCount(0);
  mock.overviewFailure = true; await page.reload();
  await expect(card).toContainText('老大身份未知');
  await expect(card.locator('input, button')).toHaveCount(0);
  expect(mock.writes).toEqual([]);
  mock.overviewFailure = false;
  await openMasterSettings(page);
  await page.getByRole('textbox', { name: '第一老大 QQ', exact: true }).fill(primaryMasterQQ);
  await setDualMaster(page, true);
  await page.getByRole('textbox', { name: '二老大 QQ', exact: true }).fill(secondaryMasterQQ);
  for (const width of [280, 390, 680]) {
    await page.setViewportSize({ width, height: 844 });
    await expectContained(page, '.master-settings-card');
    await expect(page.getByRole('textbox', { name: '第一老大 QQ', exact: true })).toHaveValue(primaryMasterQQ);
    await expect(page.getByRole('textbox', { name: '二老大 QQ', exact: true })).toHaveValue(secondaryMasterQQ);
    if (width === 390) await page.screenshot({ path: fileURLToPath(new URL('../../test-results/masters-settings-mobile.png', import.meta.url)), fullPage: true });
  }
  expect(mock.writes).toEqual([]);
});

test('favor secondary master uses its lower role and level rather than the primary supreme label', async ({ page, mock }) => {
  mock.favors = [
    { ...mock.favors[0], qq: primaryMasterQQ, nickname: 'MOCK 首席成员', score: 999, isMaster: true, masterRole: 'primary', levelName: '至高主权' },
    { ...mock.favors[1], qq: secondaryMasterQQ, nickname: 'MOCK 次席成员', score: 999, isMaster: true, masterRole: 'secondary', levelName: '次席' },
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '好感度');
  const secondary = favorRow(page, secondaryMasterQQ);
  await expect(secondary.locator('.favor-level')).toHaveText('次席主权');
  await expect(secondary).not.toContainText('至高主权');
  await expect(secondary.locator('.favor-adjust')).toHaveCount(0);
  await secondary.getByRole('button', { name: '查看MOCK 次席成员的详情', exact: true }).click();
  const details = page.locator(`.favor-details[data-qq="${secondaryMasterQQ}"]`);
  await expect(details).toContainText('二老大');
  await expect(details).toContainText('次席');
  await expect(details).not.toContainText('至高主权');
  await expect(details).not.toContainText('第一老大');
  await expectContained(page, '.favors-panel');
  await page.getByRole('searchbox', { name: '搜索好感度', exact: true }).fill('次席');
  await expect(favorRows(page)).toHaveCount(1);
  await expect(favorRows(page).first()).toHaveAttribute('data-qq', secondaryMasterQQ);
  expect(mock.writes).toEqual([]);
});

const sessionTabs = ['基础设置', '回复规则', '主动发言', '记忆管理'] as const;
const longSessionName = `MOCK超长会话名称${'LongSessionWithoutSpaces'.repeat(12)}结尾`;
function manySessions(template: PanelSession, count = 45): PanelSession[] {
  return Array.from({ length: count }, (_, index) => {
    const type = index % 2 ? 'private' : 'group';
    const targetId = String(930000000 + index);
    const name = `MOCK ${type === 'group' ? '测试群' : '测试好友'} ${String(index + 1).padStart(3, '0')}`;
    return { ...template, key: `${type}:${targetId}`, targetId, type, name, nickname: name, enabled: index % 3 !== 0, memoryShared: index % 4 === 0, updatedAt: now + index };
  });
}
function sessionRows(page: Page) { return page.locator('.sessions-list .session-row'); }
async function openSessionEditor(page: Page, index = 0) {
  await sessionRows(page).nth(index).getByRole('button', { name: /编辑/ }).click();
  const editor = page.getByRole('dialog', { name: '编辑会话', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}
async function setSessionSwitch(scope: Locator, name: string, checked: boolean) {
  const toggle = scope.getByRole('switch', { name, exact: true });
  if (await toggle.isChecked() !== checked) { await toggle.focus(); await toggle.press('Space'); }
  if (checked) await expect(toggle).toBeChecked(); else await expect(toggle).not.toBeChecked();
}
async function selectSessionTab(editor: Locator, name: typeof sessionTabs[number]) {
  const tab = editor.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
async function expectSessionEditorChrome(page: Page, editor: Locator) {
  const title = editor.getByRole('heading', { name: '编辑会话', exact: true });
  await expect(title).toBeVisible();
  await expect.poll(() => title.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    return rect.top >= 0 && rect.bottom <= window.innerHeight && [...range.getClientRects()].every(line => line.left >= rect.left - 1 && line.right <= rect.right + 1 && line.bottom <= rect.bottom + 1);
  }), { message: 'Editor title must be fully on-screen and not clipped' }).toBe(true);
  for (const label of ['取消', '保存设置']) {
    const button = editor.locator('.session-editor-footer').getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    await expect.poll(() => button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.top >= 0 && rect.bottom <= window.innerHeight + 1 && rect.left >= 0 && rect.right <= window.innerWidth + 1 && !!hit && element.contains(hit);
    }), { message: `${label} must remain visible and unobstructed outside the scrolling body` }).toBe(true);
  }
  await expectContained(page, '.session-editor-modal');
}

test('sessions paginate 45 MOCK records, filter by name/key/type/status, reset and clamp pages without writes', async ({ page, mock }) => {
  mock.sessions = manySessions(mock.sessions[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '会话');
  const rows = sessionRows(page);
  const paging = page.getByRole('navigation', { name: '会话分页', exact: true });
  const next = paging.getByRole('button', { name: /下一页/ });
  const previous = paging.getByRole('button', { name: /上一页/ });
  const search = page.getByRole('searchbox', { name: '搜索会话', exact: true });
  const type = page.getByRole('combobox', { name: '会话类型', exact: true });
  const status = page.getByRole('combobox', { name: '启用状态', exact: true });
  await expect(rows).toHaveCount(20);
  await expect(previous).toBeDisabled();
  await expect(paging).toContainText('1 / 3');
  await next.click(); await expect(rows).toHaveCount(20);
  await expect(paging).toContainText('2 / 3');
  await next.click(); await expect(rows).toHaveCount(5);
  await expect(next).toBeDisabled();
  await search.fill(mock.sessions[24].key);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(mock.sessions[24].name);
  await expect(paging).toContainText('共 1 个');
  await expect(next).toHaveCount(0);
  await search.fill(mock.sessions[25].name);
  await expect(rows).toHaveCount(1);
  await search.fill(mock.sessions[26].targetId);
  await expect(rows).toHaveCount(1);
  await search.fill('MOCK 没有这个会话');
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('没有匹配的会话。', { exact: true })).toBeVisible();
  await search.fill('');
  await type.selectOption('private');
  await expect(rows).toHaveCount(20);
  await expect(paging).toContainText('1 / 2');
  await status.selectOption('disabled');
  await expect(rows).toHaveCount(mock.sessions.filter(item => item.type === 'private' && !item.enabled).length);
  await type.selectOption('group');
  await status.selectOption('enabled');
  await expect(rows).toHaveCount(mock.sessions.filter(item => item.type === 'group' && item.enabled).length);
  await type.selectOption('all'); await status.selectOption('all');
  await next.click(); await next.click();
  mock.sessions = mock.sessions.slice(0, 21);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(paging).toContainText('2 / 2');
  await expect(rows).toHaveCount(1);
  await expect(next).toBeDisabled();
  await previous.click(); await expect(rows).toHaveCount(20);
  expect(mock.writes).toEqual([]);
});

test('sessions compact responsive rows ellipsize names, keep filters stacked correctly and toggle only with explicit action', async ({ page, mock }) => {
  mock.sessions = manySessions(mock.sessions[0]);
  const member = mock.sessions[0]; member.name = longSessionName; member.nickname = longSessionName;
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '会话');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  for (const width of [280, 390, 680, 1000, 1001, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(sessionRows(page)).toHaveCount(20);
    await expectContained(page, '.sessions-page');
    const head = page.locator('.sessions-list thead');
    if (width <= 1000) {
      await expect(head).not.toBeVisible();
      const boxes = await page.locator('.sessions-filters').evaluate(element => {
        const search = element.querySelector('input')!.getBoundingClientRect();
        const selects = [...element.querySelectorAll('select')].map(select => select.getBoundingClientRect());
        return { search: { left: search.left, right: search.right, bottom: search.bottom }, selects: selects.map(rect => ({ left: rect.left, right: rect.right, top: rect.top })) };
      });
      expect(boxes.selects[0].top).toBeGreaterThanOrEqual(boxes.search.bottom);
      expect(Math.abs(boxes.selects[0].top - boxes.selects[1].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes.search.left - boxes.selects[0].left)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes.search.right - boxes.selects[1].right)).toBeLessThanOrEqual(1);
      const name = sessionRows(page).first().locator('.session-name');
      await expect(name).toHaveCSS('text-overflow', 'ellipsis');
      await expect.poll(() => name.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      const toggle = sessionRows(page).first().getByRole('switch');
      await expect(toggle).toHaveAccessibleName(new RegExp('MOCK超长会话名称'));
      // The switch name stays accessible, but its lengthy label must not duplicate the summary visually.
      await expect.poll(() => sessionRows(page).first().locator('.toggle-label > span').last().evaluate(element => {
        const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
        return style.display === 'none' || style.visibility === 'hidden' || style.clipPath !== 'none' || (rect.width <= 1 && rect.height <= 1);
      }), { message: 'Long accessible toggle label must be visually hidden, not duplicated beside the name' }).toBe(true);
    } else await expect(head).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => sessionRows(page).evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= window.innerHeight;
  }).length), { message: 'Phone should show at least six complete compact session summaries' }).toBeGreaterThanOrEqual(6);
  let editor = await openSessionEditor(page);
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue(longSessionName);
  await expect(editor).toContainText(member.key);
  await expectWrappedText(editor.locator('.modal-header p'));
  await expectContained(page, '.session-editor-modal');
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  member.name = 'MOCK 春日测试群'; member.nickname = member.name;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(sessionRows(page).first()).toContainText(member.name);
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/sessions-mobile-dark.png', import.meta.url)) });
  expect(mock.writes).toEqual([]);
  const toggle = sessionRows(page).first().getByRole('switch');
  await expect(toggle).not.toBeChecked();
  await sessionRows(page).first().locator('.toggle-label').click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => mock.writes).toHaveLength(1);
  expect(mock.writes).toEqual([{ path: `/api/sessions/${encodeURIComponent(member.key)}`, method: 'POST', body: { enabled: true } }]);
  expect(member.enabled).toBe(true);
  // Opening and cancelling an editor cannot trigger another save/toggle request.
  editor = await openSessionEditor(page);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.writes).toHaveLength(1);
});

test('desktop session switches sit beside edit on the right while phone positions remain compact', async ({ page, mock }) => {
  await navigate(page, '会话');
  for (const width of [1001, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.sessions-list thead th')).toHaveText(['会话', '类型', '回复概率', '记忆 / 消息', '状态', '操作']);
    await expectContained(page, '.sessions-page');
    const layout = await sessionRows(page).first().evaluate(element => {
      const row = element.getBoundingClientRect();
      const status = element.querySelector('.session-status')!.getBoundingClientRect();
      const edit = element.querySelector('.session-actions button')!.getBoundingClientRect();
      const toggle = element.querySelector('.toggle-track')!.getBoundingClientRect();
      return { rightGap: row.right - edit.right, distance: edit.left - toggle.right, statusLeft: status.left, rowRight: row.right };
    });
    expect(layout.rightGap).toBeLessThan(40);
    expect(layout.distance).toBeGreaterThanOrEqual(0);
    expect(layout.distance).toBeLessThan(90);
    expect(layout.rowRight - layout.statusLeft).toBeLessThan(180);
  }
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/sessions-desktop-actions.png', import.meta.url)) });
  for (const width of [390, 680, 1000]) {
    await page.setViewportSize({ width, height: 844 });
    await expectContained(page, '.sessions-page');
    const row = sessionRows(page).first();
    await expect(row.locator('.session-status')).toHaveCSS('grid-column-start', '2');
    await expect(row.locator('.session-status')).toHaveCSS('grid-row-start', '2');
    await expect(row.locator('.session-actions')).toHaveCSS('grid-column-start', '3');
  }
  expect(mock.writes).toEqual([]);
});

test('session editor four tabs preserve one draft through polling and resize with fixed visible footer in keyboard-sized dark viewport', async ({ page, mock }) => {
  const member = mock.sessions[0];
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '会话');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const editor = await openSessionEditor(page);
  await expect(editor.getByRole('tablist').getByRole('tab')).toHaveText([...sessionTabs]);
  const basicTab = editor.getByRole('tab', { name: '基础设置', exact: true });
  await expect(basicTab).toHaveAttribute('aria-selected', 'true');
  await basicTab.focus(); await basicTab.press('ArrowRight');
  await expect(editor.getByRole('tab', { name: '回复规则', exact: true })).toBeFocused();
  await expect(editor.getByRole('tab', { name: '回复规则', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(editor.getByRole('tab', { name: '记忆管理', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(basicTab).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue(member.name);
  await expect(editor.getByRole('switch', { name: '允许机器人在这里说话', exact: true })).toBeChecked();
  await expect(editor.getByRole('textbox', { name: '专属提示词', exact: true })).toBeVisible();
  await expect(editor.getByRole('spinbutton')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '清空会话记忆', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '删除会话', exact: true })).toHaveCount(0);
  await editor.getByRole('textbox', { name: '备注名', exact: true }).fill('MOCK 跨标签未保存备注');
  await editor.getByRole('textbox', { name: '专属提示词', exact: true }).fill('MOCK 同一草稿，轮询和尺寸变化不覆盖。');
  await expectSessionEditorChrome(page, editor);
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/sessions-editor-mobile-dark.png', import.meta.url)) });
  await selectSessionTab(editor, '回复规则');
  await expect(editor.getByRole('spinbutton', { name: '被 @ 时回复概率', exact: true })).toHaveValue('100');
  await expect(editor.getByRole('spinbutton', { name: '命中关键词回复概率', exact: true })).toHaveValue('60');
  await expect(editor.getByRole('spinbutton', { name: '随机插话概率', exact: true })).toHaveValue('5');
  for (const label of ['被 @ 时回复概率', '命中关键词回复概率', '随机插话概率']) {
    const input = editor.getByRole('spinbutton', { name: label, exact: true });
    await expect(input).toHaveAttribute('min', '0'); await expect(input).toHaveAttribute('max', '100'); await expect(input).toHaveAttribute('step', 'any');
  }
  await editor.getByRole('spinbutton', { name: '命中关键词回复概率', exact: true }).fill('12.5');
  await editor.getByRole('textbox', { name: '本会话触发关键词', exact: true }).fill('MOCK,草稿');
  await expectSessionEditorChrome(page, editor);
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/sessions-editor-reply-dark.png', import.meta.url)) });
  await selectSessionTab(editor, '主动发言');
  await expect(editor.getByRole('spinbutton')).toHaveCount(3);
  for (const [label, max] of [['最短间隔', '1440'], ['最长间隔', '1440'], ['最多连聊几轮', '10']]) {
    const input = editor.getByRole('spinbutton', { name: label, exact: true });
    await expect(input).toHaveAttribute('min', '1'); await expect(input).toHaveAttribute('max', max); await expect(input).toHaveAttribute('step', '1');
  }
  await expect(editor.getByRole('switch', { name: '会自己找话说', exact: true })).not.toBeChecked();
  await setSessionSwitch(editor, '会自己找话说', true);
  await editor.getByRole('spinbutton', { name: '最短间隔', exact: true }).fill('45');
  await editor.getByRole('spinbutton', { name: '最长间隔', exact: true }).fill('90');
  await editor.getByRole('spinbutton', { name: '最多连聊几轮', exact: true }).fill('4');
  await selectSessionTab(editor, '记忆管理');
  await expect(editor.getByRole('switch', { name: '记忆互通', exact: true })).toBeChecked();
  await expect(editor.getByRole('button', { name: '清空会话记忆', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: '删除会话', exact: true })).toBeVisible();
  expect(mock.gets['/api/messages'] ?? 0).toBe(0);
  const polls = mock.gets['/api/sessions'];
  member.name = 'MOCK 服务端新备注'; member.keywordProb = 0.99;
  await expect.poll(() => mock.gets['/api/sessions'], { timeout: 10_000 }).toBeGreaterThan(polls);
  for (const width of [280, 680, 1000, 1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 390 : 844 });
    for (const tab of sessionTabs) {
      await selectSessionTab(editor, tab);
      await expectSessionEditorChrome(page, editor);
    }
  }
  const scroll = editor.locator('.session-editor-scroll');
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expectSessionEditorChrome(page, editor);
  await selectSessionTab(editor, '基础设置');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue('MOCK 跨标签未保存备注');
  await expect(editor.getByRole('textbox', { name: '专属提示词', exact: true })).toHaveValue('MOCK 同一草稿，轮询和尺寸变化不覆盖。');
  await selectSessionTab(editor, '回复规则');
  await expect(editor.getByRole('spinbutton', { name: '命中关键词回复概率', exact: true })).toHaveValue('12.5');
  await expect(editor.getByRole('textbox', { name: '本会话触发关键词', exact: true })).toHaveValue('MOCK,草稿');
  await selectSessionTab(editor, '主动发言');
  await expect(editor.getByRole('spinbutton', { name: '最短间隔', exact: true })).toHaveValue('45');
  await expect(editor.getByRole('spinbutton', { name: '最长间隔', exact: true })).toHaveValue('90');
  await expect(editor.getByRole('spinbutton', { name: '最多连聊几轮', exact: true })).toHaveValue('4');
  await expect(editor.getByRole('switch', { name: '会自己找话说', exact: true })).toBeChecked();
  expect(mock.writes).toEqual([]);
});

test('session long CJK identity and save error keep title and footer usable in extremely short phone viewports', async ({ page, mock }) => {
  mock.sessions[0].name = `MOCK${'超长中文会话备注'.repeat(12)}`;
  await page.setViewportSize({ width: 390, height: 300 });
  await navigate(page, '会话');
  const editor = await openSessionEditor(page);
  for (const viewport of [{ width: 390, height: 300 }, { width: 320, height: 350 }, { width: 280, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expectSessionEditorChrome(page, editor);
    await selectSessionTab(editor, '回复规则');
    await expectSessionEditorChrome(page, editor);
    await selectSessionTab(editor, '基础设置');
  }
  mock.sessionSaveFailures = 1;
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('保存失败：MOCK 会话保存失败');
  for (const viewport of [{ width: 390, height: 300 }, { width: 320, height: 350 }]) {
    await page.setViewportSize(viewport);
    await expectSessionEditorChrome(page, editor);
  }
  expect(mock.writes).toHaveLength(1);
});

test('session save targets encoded key with all unchanged contract fields, converts percentages and preserves errors for retry', async ({ page, mock }) => {
  const member = mock.sessions[0];
  member.key = 'group:MOCK /中文%?#';
  await navigate(page, '会话');
  const editor = await openSessionEditor(page);
  await editor.getByRole('textbox', { name: '备注名', exact: true }).fill('  MOCK 保存目标  ');
  await editor.getByRole('textbox', { name: '专属提示词', exact: true }).fill('MOCK 保存专属提示词');
  await setSessionSwitch(editor, '允许机器人在这里说话', false);
  await selectSessionTab(editor, '回复规则');
  await editor.getByRole('spinbutton', { name: '被 @ 时回复概率', exact: true }).fill('0');
  await editor.getByRole('spinbutton', { name: '命中关键词回复概率', exact: true }).fill('37.5');
  await editor.getByRole('spinbutton', { name: '随机插话概率', exact: true }).fill('100');
  await editor.getByRole('textbox', { name: '本会话触发关键词', exact: true }).fill('  MOCK,保存  ');
  await selectSessionTab(editor, '主动发言');
  await setSessionSwitch(editor, '会自己找话说', true);
  await editor.getByRole('spinbutton', { name: '最短间隔', exact: true }).fill('1');
  await editor.getByRole('spinbutton', { name: '最长间隔', exact: true }).fill('1440');
  await editor.getByRole('spinbutton', { name: '最多连聊几轮', exact: true }).fill('10');
  await selectSessionTab(editor, '记忆管理');
  await setSessionSwitch(editor, '记忆互通', false);
  mock.sessionSaveFailures = 1;
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('保存失败：MOCK 会话保存失败');
  expect(member.name).toBe('MOCK 测试群');
  await expect(editor.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await selectSessionTab(editor, '基础设置');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue('  MOCK 保存目标  ');
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(editor).not.toBeVisible();
  const body = { name: 'MOCK 保存目标', enabled: false, prompt: 'MOCK 保存专属提示词', memoryShared: false, atProb: 0, keywordProb: 0.375, keywords: 'MOCK,保存', randomProb: 1, proactiveEnabled: true, proactiveMinMinutes: 1, proactiveMaxMinutes: 1440, proactiveMaxRounds: 10 };
  expect(mock.writes).toEqual([body, body].map(body => ({ path: `/api/sessions/${encodeURIComponent(member.key)}`, method: 'POST', body })));
  expect(member).toMatchObject(body);
  expect(mock.sessions[1].name).toBe('MOCK 测试好友');
});

test('session invalid probabilities and interval ranges reveal the correct tab and never send writes', async ({ page, mock }) => {
  await navigate(page, '会话');
  const editor = await openSessionEditor(page);
  const cases: { tab: typeof sessionTabs[number]; label: string; invalid: string; valid: string }[] = [
    { tab: '回复规则', label: '被 @ 时回复概率', invalid: '', valid: '100' },
    { tab: '回复规则', label: '命中关键词回复概率', invalid: '-1', valid: '60' },
    { tab: '回复规则', label: '随机插话概率', invalid: '100.01', valid: '5' },
    { tab: '主动发言', label: '最短间隔', invalid: '0', valid: '30' },
    { tab: '主动发言', label: '最长间隔', invalid: '1441', valid: '60' },
    { tab: '主动发言', label: '最多连聊几轮', invalid: '1.5', valid: '2' },
  ];
  for (const item of cases) {
    await selectSessionTab(editor, item.tab);
    const input = editor.getByRole('spinbutton', { name: item.label, exact: true });
    await input.fill(item.invalid);
    await selectSessionTab(editor, '基础设置');
    await editor.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(editor.getByRole('tab', { name: item.tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.getByRole('alert')).toBeVisible();
    await expect(input).toHaveValue(item.invalid);
    await input.fill(item.valid);
    expect(mock.writes).toEqual([]);
  }
  await editor.getByRole('spinbutton', { name: '最短间隔', exact: true }).fill('61');
  await selectSessionTab(editor, '记忆管理');
  await editor.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(editor.getByRole('tab', { name: '主动发言', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(editor.getByRole('alert')).toContainText('最长间隔不能小于最短间隔');
  expect(mock.writes).toEqual([]);
});

test('shared memory clearing requires warning and explicit confirmation', async ({ page, mock }) => {
  await navigate(page, '会话');
  const editor = await openSessionEditor(page);
  await selectSessionTab(editor, '记忆管理');
  await editor.getByRole('button', { name: '读取最近消息', exact: true }).click();
  await expect(editor.getByText('MOCK 虚构记忆，不含真实聊天', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '清空会话记忆', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '清空会话记忆', exact: true });
  await expect(confirmation).toContainText('所有使用互通记忆的会话会一起失去共享记忆');
  expect(mock.writes.filter(write => write.path === '/api/memory/clear')).toHaveLength(0);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.writes.filter(write => write.path === '/api/memory/clear')).toHaveLength(0);
  await editor.getByRole('button', { name: '清空会话记忆', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认清空记忆', exact: true }).click();
  await expect.poll(() => mock.writes.filter(write => write.path === '/api/memory/clear')).toHaveLength(1);
  expect(mock.writes.find(write => write.path === '/api/memory/clear')?.body).toEqual({ key: sharedKey });
});

test('session memory loads only explicitly, retries errors and clear nested dialogs retain unsaved draft and saved memory scope', async ({ page, mock }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '会话');
  const editor = await openSessionEditor(page);
  await editor.getByRole('textbox', { name: '备注名', exact: true }).fill('MOCK 危险操作仍保留草稿');
  await editor.getByRole('textbox', { name: '专属提示词', exact: true }).fill('MOCK 未保存人格不能丢失');
  await selectSessionTab(editor, '记忆管理');
  // An unsaved memory-mode change must not change the scope of a destructive operation.
  await setSessionSwitch(editor, '记忆互通', false);
  expect(mock.gets['/api/messages'] ?? 0).toBe(0);
  mock.memoryReadFailures = 1;
  await editor.getByRole('button', { name: '读取最近消息', exact: true }).click();
  const readError = editor.getByRole('alert').filter({ hasText: '读取消息失败' });
  await expect(readError).toContainText('MOCK 消息读取失败');
  await readError.getByRole('button', { name: '重试', exact: true }).click();
  await expect(editor.getByText('MOCK 虚构记忆，不含真实聊天', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '清空会话记忆', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '清空会话记忆', exact: true });
  await expect(confirmation).toContainText('所有使用互通记忆的会话会一起失去共享记忆');
  await expectContained(page, '.ui-modal:not(.session-editor-modal)');
  expect(mock.writes).toEqual([]);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('switch', { name: '记忆互通', exact: true })).not.toBeChecked();
  await selectSessionTab(editor, '基础设置');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue('MOCK 危险操作仍保留草稿');
  await selectSessionTab(editor, '记忆管理');
  await editor.getByRole('button', { name: '清空会话记忆', exact: true }).click();
  mock.memoryClearFailures = 1;
  await confirmation.getByRole('button', { name: '确认清空记忆', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('清空失败：MOCK 记忆清空失败');
  await expect(confirmation.getByRole('button', { name: '确认清空记忆', exact: true })).toBeEnabled();
  await confirmation.getByRole('button', { name: '确认清空记忆', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor.getByText('MOCK 虚构记忆，不含真实聊天', { exact: true })).not.toBeVisible();
  await expect(editor.getByText('这个会话还没有记忆。', { exact: true })).toBeVisible();
  await expect(editor.getByRole('switch', { name: '记忆互通', exact: true })).not.toBeChecked();
  await selectSessionTab(editor, '基础设置');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue('MOCK 危险操作仍保留草稿');
  await expect(editor.getByRole('textbox', { name: '专属提示词', exact: true })).toHaveValue('MOCK 未保存人格不能丢失');
  expect(mock.sessions[0].name).toBe('MOCK 测试群');
  expect(mock.clearedMemoryKeys).toEqual(['shared']);
  expect(mock.writes).toEqual([1, 2].map(() => ({ path: '/api/memory/clear', method: 'POST', body: { key: sharedKey } })));
});

test('session deletion cancel preserves draft, failed confirmation retries, confirmed DELETE removes only the encoded target', async ({ page, mock }) => {
  const member = mock.sessions[1]; member.key = 'private:MOCK /中文%?#';
  await navigate(page, '会话');
  const editor = await openSessionEditor(page, 1);
  await editor.getByRole('textbox', { name: '备注名', exact: true }).fill('MOCK 删除取消后保留');
  await selectSessionTab(editor, '记忆管理');
  await editor.getByRole('button', { name: '删除会话', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除会话', exact: true });
  await expect(confirmation).toContainText('聊天记忆不会删除');
  await expect(confirmation).toContainText(member.name);
  expect(mock.writes).toEqual([]);
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await selectSessionTab(editor, '基础设置');
  await expect(editor.getByRole('textbox', { name: '备注名', exact: true })).toHaveValue('MOCK 删除取消后保留');
  await selectSessionTab(editor, '记忆管理');
  await editor.getByRole('button', { name: '删除会话', exact: true }).click();
  mock.sessionDeleteFailures = 1;
  await confirmation.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(confirmation.getByRole('alert')).toContainText('删除失败：MOCK 删除会话失败');
  expect(mock.sessions).toHaveLength(2);
  await confirmation.getByRole('button', { name: '确认删除会话', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(editor).not.toBeVisible();
  await expect(sessionRows(page)).toHaveCount(1);
  expect(mock.sessions.map(item => item.key)).toEqual([sharedKey]);
  expect(mock.writes).toEqual([1, 2].map(() => ({ path: `/api/sessions/${encodeURIComponent(member.key)}`, method: 'DELETE', body: {} })));
});

test('unsaved settings survive leaving and returning through the main sidebar', async ({ page, mock }) => {
  await navigate(page, '设置');
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill('MOCK 跨页面保留的人格草稿');
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await page.getByRole('textbox', { name: '模型名称', exact: true }).fill('mock-unsaved-model');
  await navigate(page, '日志');
  await expect(page.getByRole('heading', { name: '运行日志', exact: true })).toBeVisible();
  await navigate(page, '设置');
  await page.getByRole('button', { name: '模型与接口', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '模型名称', exact: true })).toHaveValue('mock-unsaved-model');
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK 跨页面保留的人格草稿');
  await expect(page.getByText('有未保存修改', { exact: true })).toBeVisible();
  expect(mock.writes).toEqual([]);
});

test('same endpoint/model profiles with different keys retain selected identity for deletion', async ({ page, mock }) => {
  mock.config.llm.profiles.push({ id: 'mock-same-endpoint-other-key', name: 'MOCK 同模型第二密钥', baseUrl: mock.config.llm.baseUrl, model: mock.config.llm.model, apiKey: 'zz****zz' });
  await navigate(page, '设置');
  const profile = page.getByRole('combobox', { name: '已保存档案（选择立即生效）', exact: true });
  await expect(profile.locator('option')).toHaveCount(4);
  await profile.selectOption('mock-same-endpoint-other-key');
  await expect.poll(() => mock.writes.filter(write => write.path === '/api/llm/profiles/apply')).toHaveLength(1);
  await expect(profile).toHaveValue('mock-same-endpoint-other-key');
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除档案', exact: true });
  await expect(deletion).toContainText('MOCK 同模型第二密钥');
  await deletion.getByRole('button', { name: '确认删除档案', exact: true }).click();
  await expect.poll(() => mock.writes.filter(write => write.path === '/api/llm/profiles/delete')).toHaveLength(1);
  expect(mock.writes.find(write => write.path === '/api/llm/profiles/delete')?.body).toEqual({ id: 'mock-same-endpoint-other-key' });
  expect(mock.config.llm.profiles.some(item => item.id === 'mock-main')).toBe(true);
  expect(mock.config.llm.profiles.some(item => item.id === 'mock-same-endpoint-other-key')).toBe(false);
});

test('logs display, search and level filters use synthetic data', async ({ page, mock }) => {
  await navigate(page, '日志');
  await expect(page.getByRole('heading', { name: '运行日志', exact: true })).toBeVisible();
  await expect(page.getByText('MOCK 演示面板启动成功', { exact: true })).toBeVisible();
  await expect(page.getByText('MOCK 演示备用接口已就绪', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索日志', exact: true }).fill('备用接口');
  await expect(page.getByText('MOCK 演示备用接口已就绪', { exact: true })).toBeVisible();
  await expect(page.getByText('MOCK 演示面板启动成功', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'WARN', exact: true }).click();
  await expect(page.getByText('没有匹配的日志。', { exact: true })).toBeVisible();
  expect(mock.writes).toEqual([]);
});
