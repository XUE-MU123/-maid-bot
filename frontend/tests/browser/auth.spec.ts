import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test as base, type Page } from '@playwright/test';
import type { Config } from '../../src/lib/types';

type ApiCall = { path: string; method: string; body: Record<string, unknown>; csrf?: string };
type AuthMock = {
  authenticated: boolean; expired: boolean; loginFailures: number; sessionFailures: number;
  sessionGate?: Promise<void>; loginGate?: Promise<void>;
  calls: ApiCall[]; privateBeforeAuth: string[]; unexpected: string[]; appChunks: string[];
};
const origin = new URL(process.env.TEST_BASE_URL || 'http://127.0.0.1:3210').origin;
const password = 'MOCK-only-password-never-persist-7351';
const csrfToken = 'mocktoken';

const test = base.extend<{ auth: AuthMock }>({
  auth: async ({ page }, use) => {
    const state: AuthMock = { authenticated: false, expired: false, loginFailures: 0, sessionFailures: 0, calls: [], privateBeforeAuth: [], unexpected: [], appChunks: [] };
    // Only an example file, never production configuration or credentials.
    const config = JSON.parse(await readFile(new URL('../../../config.example.json', import.meta.url), 'utf8')) as Config;
    config.llm.baseUrl = 'https://mock-auth.invalid/v1'; config.llm.apiKey = ''; config.llm.model = 'mock-auth-model'; config.llm.profiles = [];
    config.persona.systemPrompt = 'MOCK saved persona'; config.bot.globalAutoReply = true;
    config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: false }; config.bot.masterIds = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    // Observe only local built assets; API mocks below still fail closed for every method.
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === origin && /\/App-[^/]+\.js$/.test(url.pathname)) state.appChunks.push(url.pathname);
    });
    // Every API method is intercepted before navigation; NEVER forward to a real API.
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const call: ApiCall = { path, method, body: request.postData() ? request.postDataJSON() : {}, csrf: request.headers()['x-csrf-token'] };
      state.calls.push(call);
      const respond = (data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/api/auth/session' && method === 'GET') {
        await state.sessionGate;
        if (state.sessionFailures > 0) { state.sessionFailures--; return respond({ error: 'MOCK session unavailable' }, 503); }
        return respond(state.authenticated ? { authenticated: true, username: 'mock-admin', csrfToken } : { authenticated: false });
      }
      if (path === '/api/auth/login' && method === 'POST') {
        expect(call.csrf, 'Anonymous login must not reuse a previous session token').toBeUndefined();
        await state.loginGate;
        if (state.loginFailures > 0) { state.loginFailures--; return respond({ error: 'MOCK 账号或密码错误' }, 401); }
        if (call.body.username !== 'mock-admin' || call.body.password !== password) return respond({ error: 'MOCK 账号或密码错误' }, 401);
        state.authenticated = true; state.expired = false;
        return respond({ authenticated: true, username: 'mock-admin', csrfToken });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        expect(call.csrf, 'Logout must carry the authenticated session CSRF token').toBe(csrfToken);
        state.authenticated = false;
        return respond({ authenticated: false });
      }
      if (!path.startsWith('/api/auth/')) {
        if (!state.authenticated) {
          state.privateBeforeAuth.push(`${method} ${path}`);
          return respond({ error: 'MOCK 尚未登录' }, 401);
        }
        if (state.expired) { state.authenticated = false; return respond({ error: 'MOCK 登录已过期' }, 401); }
        if (!['GET', 'HEAD'].includes(method)) expect(call.csrf, `${method} ${path} requires CSRF`).toBe(csrfToken);
        // Minimal dashboard/settings read contracts, not a second copy of the panel fixture.
        if (method === 'GET') {
          if (path === '/api/config') return respond(config);
          if (path === '/api/overview') return respond({ status: { onebotConnected: true, selfId: '900000', reconnects: 0, lastError: '' }, stats: { messages: 1234, sessions: 0 }, usage: { totalPrompt: 100, totalCompletion: 20 }, favorCount: 0, uptimeSec: 60, version: '0.1.1-auth-mock', masterStatus: { mode: 'none', primary: null, secondary: null } });
          if (path === '/api/groups') return respond({ groups: [] });
          if (path === '/api/friends') return respond({ friends: [] });
          if (path === '/api/logs') return respond({ lines: ['2026-01-01 16:00:00 [INFO] [auth] MOCK private log'], fileSize: 70, nextOffset: 70, file: 'MOCK/auth.log' });
        }
      }
      state.unexpected.push(`${method} ${path}`);
      return respond({ error: `Unmocked API blocked: ${method} ${path}` }, 501);
    });
    // Only deployed HTML/static assets may leave the browser; external assets fail closed too.
    await page.route(url => url.origin !== origin && !url.pathname.startsWith('/api/'), route => route.abort('blockedbyclient'));
    await use(state);
    expect(state.unexpected, 'All API requests require an explicit synthetic mock').toEqual([]);
    expect(pageErrors, 'No client-side exceptions').toEqual([]);
  },
});

const loginHeading = (page: Page) => page.getByRole('heading', { name: '女仆大总管', exact: true });
const accountInput = (page: Page) => page.getByLabel('账号', { exact: true });
const passwordInput = (page: Page) => page.getByLabel('密码', { exact: true });
const loginButton = (page: Page) => page.getByRole('button', { name: '进入控制台', exact: true });
const privateCalls = (auth: AuthMock) => auth.calls.filter(call => !call.path.startsWith('/api/auth/'));
const loginCalls = (auth: AuthMock) => auth.calls.filter(call => call.path === '/api/auth/login');
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fillCredentials(page: Page) { await accountInput(page).fill('mock-admin'); await passwordInput(page).fill(password); }
async function login(page: Page) {
  await expect(loginHeading(page)).toBeVisible();
  await fillCredentials(page);
  await loginButton(page).click();
  await expect(page.locator('.topbar-title')).toHaveText('总览');
  await expect(loginHeading(page)).toHaveCount(0);
}
async function navigateSettings(page: Page) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^设置/ }).click();
  await page.getByRole('button', { name: '人格与触发', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK saved persona');
}
async function expectNoPasswordStorage(page: Page) {
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(JSON.stringify(storage)).not.toContain(password);
  expect(Object.keys(storage.local).join(' ')).not.toMatch(/password|csrf|token/i);
}
async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

// A deferred session makes the initial authentication boundary observable, not just a fast-response race.
test('pending and anonymous session never fetch the App chunk, mount App or request private APIs', async ({ page, auth }) => {
  const gate = deferred(); auth.sessionGate = gate.promise;
  await page.goto('/');
  await expect.poll(() => auth.calls.filter(call => call.path === '/api/auth/session').length).toBeGreaterThan(0);
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(privateCalls(auth)).toEqual([]);
  expect(auth.appChunks, 'Pending session must not preload the private App bundle').toEqual([]);
  gate.release();
  await expect(loginHeading(page)).toBeVisible();
  await expect(accountInput(page)).toHaveAttribute('autocomplete', 'username');
  await expect(passwordInput(page)).toHaveAttribute('type', 'password');
  await expect(passwordInput(page)).toHaveAttribute('autocomplete', 'current-password');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(privateCalls(auth)).toEqual([]);
  expect(auth.privateBeforeAuth).toEqual([]);
  expect(auth.appChunks, 'Anonymous login must not preload the private App bundle').toEqual([]);
  await login(page);
  await expect.poll(() => auth.appChunks.length, { message: 'Successful authentication should fetch the deferred App bundle' }).toBeGreaterThan(0);
  expect(auth.privateBeforeAuth).toEqual([]);
});

test('session check failure stays closed and an explicit retry recovers the login screen', async ({ page, auth }) => {
  // More than StrictMode's two mount requests: remain failed until the user explicitly retries.
  auth.sessionFailures = 10;
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('登录状态读取失败');
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(privateCalls(auth)).toEqual([]);
  expect(auth.appChunks, 'Failed session bootstrap must not fetch App').toEqual([]);
  auth.sessionFailures = 0;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(loginHeading(page)).toBeVisible();
  expect(privateCalls(auth)).toEqual([]);
  expect(auth.appChunks, 'Retrying an anonymous session must remain bundle-gated').toEqual([]);
  await login(page);
  await expect.poll(() => auth.appChunks.length).toBeGreaterThan(0);
  expect(auth.privateBeforeAuth).toEqual([]);
});

test('wrong credentials show an error and Enter retries without storing the password', async ({ page, auth }) => {
  auth.loginFailures = 1;
  await page.goto('/'); await fillCredentials(page);
  await passwordInput(page).press('Enter');
  await expect(page.getByRole('alert')).toContainText('登录未成功，请检查账号和密码，或稍后重试。');
  await expect(passwordInput(page)).toHaveValue('');
  await expect(loginButton(page)).toBeEnabled();
  expect(loginCalls(auth)).toHaveLength(1);
  expect(privateCalls(auth)).toEqual([]);
  await expectNoPasswordStorage(page);
  await fillCredentials(page); await passwordInput(page).press('Enter');
  await expect(page.locator('.topbar-title')).toHaveText('总览');
  expect(loginCalls(auth)).toHaveLength(2);
  expect(loginCalls(auth)[1].body).toEqual({ username: 'mock-admin', password });
  expect(auth.privateBeforeAuth).toEqual([]);
  await expectNoPasswordStorage(page);
});

test('busy login disables submit and rejects duplicate form submissions', async ({ page, auth }) => {
  const gate = deferred(); auth.loginGate = gate.promise;
  await page.goto('/'); await fillCredentials(page); await loginButton(page).click();
  await expect.poll(() => loginCalls(auth).length).toBe(1);
  const submit = page.locator('form button[type="submit"]');
  await expect(submit).toBeDisabled();
  await page.locator('form').evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await page.keyboard.press('Enter');
  expect(loginCalls(auth)).toHaveLength(1);
  expect(privateCalls(auth)).toEqual([]);
  gate.release();
  await expect(page.locator('.topbar-title')).toHaveText('总览');
  expect(loginCalls(auth)).toHaveLength(1);
});

test('logout carries CSRF, removes private UI and destroys unsaved frontend state', async ({ page, auth }) => {
  await page.goto('/'); await login(page); await navigateSettings(page);
  const draft = 'MOCK private unsaved draft must be destroyed';
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill(draft);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(loginHeading(page)).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  expect(auth.authenticated).toBe(false);
  const logout = auth.calls.filter(call => call.path === '/api/auth/logout');
  expect(logout).toHaveLength(1); expect(logout[0].csrf).toBe(csrfToken);
  const privateCount = privateCalls(auth).length;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(privateCalls(auth)).toHaveLength(privateCount);
  await login(page); await navigateSettings(page);
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).not.toHaveValue(draft);
  await expectNoPasswordStorage(page);
});

test('refresh restores authenticated server session without another login', async ({ page, auth }) => {
  await page.goto('/'); await login(page);
  const logins = loginCalls(auth).length;
  await page.reload();
  await expect(page.locator('.topbar-title')).toHaveText('总览');
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  expect(loginCalls(auth)).toHaveLength(logins);
  expect(auth.calls.filter(call => call.path === '/api/auth/session').length).toBeGreaterThanOrEqual(2);
  expect(auth.privateBeforeAuth).toEqual([]);
  await expectNoPasswordStorage(page);
});

test('private API 401 expires the gate and clears drafts before a fresh login', async ({ page, auth }) => {
  await page.goto('/'); await login(page); await navigateSettings(page);
  await page.getByRole('textbox', { name: '系统人格提示词', exact: true }).fill('MOCK expired private draft');
  auth.expired = true;
  // Returning to Dashboard starts real application reads; no synthetic DOM event bypasses the API helper.
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^总览/ }).click();
  await expect(loginHeading(page)).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByText('MOCK private log', { exact: true })).toHaveCount(0);
  expect(auth.authenticated).toBe(false);
  await login(page); await navigateSettings(page);
  await expect(page.getByRole('textbox', { name: '系统人格提示词', exact: true })).toHaveValue('MOCK saved persona');
  await expectNoPasswordStorage(page);
});

type BackgroundFrame = { arcs: number[][]; glows: number[][]; lines: number[][] };
type BackgroundProbe = { step: (stamp: number) => BackgroundFrame; read: () => BackgroundFrame; restore: () => void };
declare global { interface Window { __backgroundProbe: BackgroundProbe } }

test('autonomous particles keep steady flow independent of the mouse while connection lines and click ripples remain', async ({ page, auth }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    // Drive identical animation timestamps and inspect drawing commands, not renderer-dependent pixels.
    const nativeRequest = window.requestAnimationFrame.bind(window), nativeCancel = window.cancelAnimationFrame.bind(window);
    let nextId = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    window.requestAnimationFrame = callback => { const id = ++nextId; callbacks.set(id, callback); return id; };
    window.cancelAnimationFrame = id => { callbacks.delete(id); };
    let frame: BackgroundFrame = { arcs: [], glows: [], lines: [] };
    const prototype = CanvasRenderingContext2D.prototype;
    const clear = prototype.clearRect, arc = prototype.arc, gradient = prototype.createRadialGradient, line = prototype.lineTo;
    const tracked = (context: CanvasRenderingContext2D) => context.canvas.matches('canvas.login-starfield');
    prototype.clearRect = function (...args) {
      if (tracked(this)) frame = { arcs: [], glows: [], lines: [] };
      return clear.apply(this, args);
    };
    prototype.arc = function (...args) {
      if (tracked(this)) frame.arcs.push(args.slice(0, 3) as number[]);
      return arc.apply(this, args);
    };
    prototype.createRadialGradient = function (...args) {
      if (tracked(this)) frame.glows.push([...args]);
      return gradient.apply(this, args);
    };
    prototype.lineTo = function (...args) {
      if (tracked(this)) frame.lines.push([...args]);
      return line.apply(this, args);
    };
    const read = () => structuredClone(frame);
    window.__backgroundProbe = {
      read,
      restore() { callbacks.clear(); window.requestAnimationFrame = nativeRequest; window.cancelAnimationFrame = nativeCancel; },
      step(stamp) {
        const pending = [...callbacks.values()]; callbacks.clear();
        for (const callback of pending) callback(stamp);
        return read();
      },
    };
  });
  await page.goto('/'); await expect(loginHeading(page)).toBeVisible();
  const canvas = page.locator('canvas.login-starfield');
  await expect(canvas).toHaveAttribute('data-motion', 'autonomous');
  await expect(canvas).toHaveAttribute('data-running', 'true');
  const count = Number(await canvas.getAttribute('data-particle-count'));
  expect(count).toBeGreaterThanOrEqual(80);
  await page.evaluate(() => window.__backgroundProbe.step(100));
  const before = await page.evaluate(() => window.__backgroundProbe.step(140));
  const after = await page.evaluate(() => window.__backgroundProbe.step(180));
  expect(before.arcs).toHaveLength(count);
  expect(after.arcs).toHaveLength(count);
  const speeds = before.arcs.map(([x, y], index) => Math.hypot(after.arcs[index][0] - x, after.arcs[index][1] - y) / .04)
    // Ignore wrapping at a viewport edge; it is not a velocity jump.
    .filter(speed => speed < 100).sort((a, b) => a - b);
  expect(speeds.length).toBeGreaterThan(count * .9);
  expect(speeds[0], 'Autonomous flow should not be a barely moving oscillation').toBeGreaterThanOrEqual(3.5);
  expect(speeds.at(-1), 'Autonomous flow should remain approximately 4–9 CSS px/sec').toBeLessThanOrEqual(9.5);
  expect(after.glows, 'Ambient glows must be static, not time-parallax layers').toEqual(before.glows);
  const point = await page.evaluate(() => window.__backgroundProbe.read().arcs.find(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return x > 30 && x < innerWidth - 30 && y > 100 && y < innerHeight - 60 && !!hit
      && !hit.closest('form, button, input, a, select, textarea, [data-background-exclude]');
  }));
  expect(point, 'A visible decorative particle should have an unobscured scene interaction point').toBeDefined();
  const redrawAtSameTime = () => page.evaluate(async () => {
    // Theme invalidation redraws without advancing the controlled RAF clock.
    document.documentElement.setAttribute('data-theme', document.documentElement.dataset.theme!);
    await Promise.resolve();
    return window.__backgroundProbe.read();
  });
  await page.mouse.move(point![0], point![1]);
  const hovered = await redrawAtSameTime();
  expect(hovered.arcs, 'Mouse proximity must not attract or offset any particle at the same timestamp').toEqual(after.arcs);
  expect(hovered.glows, 'Mouse movement must not offset ambient glows').toEqual(after.glows);
  expect(hovered.lines.length, 'Keep the previous pointer connection lines').toBeGreaterThan(after.lines.length);
  expect(hovered.lines.some(([x, y]) => Math.hypot(x - point![0], y - point![1]) < 1)).toBe(true);
  await page.mouse.click(point![0], point![1]);
  const clicked = await redrawAtSameTime();
  expect(clicked.arcs.slice(0, count), 'A ripple must not displace the particle flow').toEqual(after.arcs);
  expect(clicked.arcs.slice(count).some(([x, y, radius]) => Math.hypot(x - point![0], y - point![1]) < 1 && radius > 0), 'Keep the previous click ripple').toBe(true);
  // Playwright screenshots wait for native animation frames; leave the captured scene frozen.
  await page.evaluate(() => window.__backgroundProbe.restore());
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/flow-login.png', import.meta.url)), fullPage: true });
  expect(privateCalls(auth)).toEqual([]);
  expect(auth.appChunks).toEqual([]);
});

test('login theme and pointer canvas respond while effects-off and reduced motion freeze drawing', async ({ page, auth }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/'); await expect(loginHeading(page)).toBeVisible();
  const canvas = page.locator('canvas.login-starfield');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');
  await expect(canvas).toHaveCSS('pointer-events', 'none');
  await expect(page.getByRole('button', { name: '关闭背景动效', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const initial = await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL());
  await page.mouse.move(120, 220); await page.mouse.click(120, 220);
  await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).not.toBe(initial);
  await page.getByRole('button', { name: '关闭背景动效', exact: true }).click();
  await expect(page.getByRole('button', { name: '开启背景动效', exact: true })).toHaveAttribute('aria-pressed', 'false');
  // Compare actual canvas pixels over several RAF opportunities, not merely the toggle label.
  const remainsStill = () => canvas.evaluate(async element => {
    const bitmap = element as HTMLCanvasElement;
    const before = bitmap.toDataURL();
    await new Promise<void>(resolve => { let frames = 0; const next = () => { if (++frames === 8) resolve(); else requestAnimationFrame(next); }; requestAnimationFrame(next); });
    return bitmap.toDataURL() === before;
  });
  await expect.poll(remainsStill).toBe(true);
  await page.mouse.move(180, 320); await page.mouse.click(180, 320);
  expect(await remainsStill()).toBe(true);
  await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const gradient = await loginButton(page).evaluate(element => getComputedStyle(element).backgroundImage);
  for (const color of ['rgb(116, 190, 255)', 'rgb(181, 229, 225)', 'rgb(255, 180, 160)']) expect(gradient).toContain(color);
  await page.reload();
  await expect(loginHeading(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '切换到浅色主题', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开启背景动效', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: fileURLToPath(new URL('../../test-results/login-screenshot-coral-dark.png', import.meta.url)), fullPage: true });
  await page.getByRole('button', { name: '切换到浅色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: '开启背景动效', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭背景动效', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('button', { name: '开启背景动效', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(remainsStill).toBe(true);
  expect(privateCalls(auth)).toEqual([]);
});

for (const width of [280, 390, 680, 1440]) {
  test(`login at ${width}px keeps its form and theme controls accessible without overflow`, async ({ page, auth }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect(loginHeading(page)).toBeVisible();
    for (const control of [accountInput(page), passwordInput(page), loginButton(page), page.getByRole('button', { name: '切换到深色主题', exact: true }), page.getByRole('button', { name: '开启背景动效', exact: true })]) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
    }
    await expect(page.getByRole('button', { name: '开启背景动效', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expectNoOverflow(page);
    await expect(page.locator('.login-scene-label, .login-interaction-hint, .login-footer')).toHaveCount(0);
    const card = page.locator('.login-card');
    for (const side of ['top', 'right', 'bottom', 'left']) await expect(card).toHaveCSS(`border-${side}-width`, '2px');
    await expect(card).toHaveCSS('background-clip', 'padding-box, border-box');
    await expect(card).toHaveCSS('background-image', /linear-gradient.*linear-gradient/);
    await expect.poll(() => card.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
    if (width === 1440 || width === 390) await page.screenshot({ path: fileURLToPath(new URL(`../../test-results/login-screenshot-coral-${width === 1440 ? 'desktop' : 'mobile'}.png`, import.meta.url)), fullPage: true });
    expect(privateCalls(auth)).toEqual([]);
  });
}
