// Isolated integration suite: no robot, real credentials, production login or config.
// Usage: node scripts/panel-auth-test.ts (Node 24; openssl only for fixture oracle).
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { apr1, createGateway } from '../src/server/panel-auth-gateway.ts';
import type { GatewayOptions } from '../src/server/panel-auth-gateway.ts';

const ORIGIN = 'https://panel.example.test:3211';
const HOST = 'panel.example.test:3211';
const PASSWORD = 'Fixture p@ss: word 中文';
const directory = mkdtempSync(join(tmpdir(), 'maid-panel-auth-test-'));
const temporaryRoot = realpathSync(directory);
const web = join(directory, 'web');
mkdirSync(join(web, 'assets'), { recursive: true });
writeFileSync(join(web, 'index.html'), '<!doctype html><title>Public login shell</title>');
writeFileSync(join(web, 'assets', 'index-test.js'), 'console.log("public shell");');
writeFileSync(join(web, 'assets', 'index-test.css'), 'body{color:red}');
const textFixtures = new Map([
  ['/assets/index-Ab3d_5-X.js', Buffer.from('console.log("public shell 中文");\n'.repeat(128))],
  ['/assets/style-F6g7H8i9.css', Buffer.from('body{color:#abcdef;background:white}\n'.repeat(128))],
  ['/assets/icon-a1B2c3D4.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>Public</title></svg>'.repeat(64))],
]);
for (const [path, body] of textFixtures) writeFileSync(join(web, path), body);
writeFileSync(join(web, 'assets', 'logo.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));
mkdirSync(join(web, 'assets', 'nested'));
writeFileSync(join(web, 'assets', 'nested', 'hidden-Ab3d_5-X.js'), 'private nested');
writeFileSync(join(web, 'assets', 'private.json'), '{"secret":"must not be public"}');
writeFileSync(join(web, 'assets', 'index-test.js.map'), '{"secret":"source map"}');
writeFileSync(join(web, 'assets', '.hidden.js'), 'private');
writeFileSync(join(directory, 'outside.js'), 'OUTSIDE SECRET');
symlinkSync(join(directory, 'outside.js'), join(web, 'assets', 'linked.js'));
const htpasswd = join(directory, 'fixture.htpasswd');
const servers: Server[] = [];
let upstreamCalls = 0;
let time = 1_000_000;
let checks = 0;

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string; data: any }
interface Session { cookie: string; csrf: string }
async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn(); checks++; console.log(`ok ${checks} - ${name}`);
}
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string; chunks?: string[] } = {}): Promise<Reply> {
  return new Promise((done, fail) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host: HOST, 'x-forwarded-proto': 'https', 'x-real-ip': '192.0.2.10', ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', fail);
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let data: unknown;
        try { data = JSON.parse(text); } catch { data = undefined; }
        done({ status: response.statusCode!, headers: response.headers, body, text, data });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', fail);
    if (options.chunks) { for (const chunk of options.chunks) req.write(chunk); req.end(); }
    else req.end(options.body);
  });
}
function login(port: number, extra: Record<string, string> = {}, password = PASSWORD, username = 'mock-admin'): Promise<Reply> {
  return call(port, '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ username, password }) });
}
function session(reply: Reply): Session {
  assert.equal(reply.status, 200);
  assert.equal(reply.data.authenticated, true);
  assert.equal(reply.data.username, 'mock-admin');
  assert.match(reply.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const cookie = reply.headers['set-cookie']?.[0];
  assert(cookie);
  assert.match(cookie, /^__Host-maid_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=/);
  assert(!cookie.includes('Domain='));
  return { cookie: cookie.split(';')[0]!, csrf: reply.data.csrfToken };
}
function authHeaders(auth: Session): Record<string, string> { return { cookie: auth.cookie, origin: ORIGIN, 'x-csrf-token': auth.csrf, 'content-type': 'application/json' }; }

try {
  const openssl = spawnSync('openssl', ['passwd', '-apr1', '-salt', 'testSalt', '-stdin'], { input: PASSWORD + '\n', encoding: 'utf8' });
  assert.equal(openssl.status, 0, 'openssl fixture generation failed');
  const hash = openssl.stdout.trim();
  assert.match(hash, /^\$apr1\$testSalt\$/);
  writeFileSync(htpasswd, `mock-admin:${hash}\nshauser:{SHA}${createHash('sha1').update('sha-fixture').digest('base64')}\nunsupported:$2y$unknown\n`, { mode: 0o600 });
  await check('native APR1 equals independent OpenSSL oracle for Unicode and byte boundaries', () => {
    assert.equal(apr1(PASSWORD, 'testSalt'), hash);
    for (const password of ['a', '1234567890123456', '12345678901234567', 'a'.repeat(128)]) {
      const oracle = spawnSync('openssl', ['passwd', '-apr1', '-salt', 'x', '-stdin'], { input: password + '\n', encoding: 'utf8' });
      assert.equal(oracle.status, 0);
      assert.equal(apr1(password, 'x'), oracle.stdout.trim());
    }
  });
  const upstream = createServer((req, res) => {
    upstreamCalls++;
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(req.url?.startsWith('/api/unknown') ? 404 : 200, {
        'content-type': 'application/json', 'set-cookie': 'botSecret=bad',
        'www-authenticate': 'Basic realm="robot"', 'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString(), privateConfig: 'secret-from-protected-upstream' }));
    });
  });
  const upstreamPort = await listen(upstream);
  const defaults: GatewayOptions = { publicOrigin: ORIGIN, htpasswdPath: htpasswd, webRoot: web, upstreamPort, now: () => time, loginMaxPerIp: 100, loginMaxGlobal: 1000 };
  const port = await listen(createGateway(defaults));
  await check('configuration fails closed without canonical HTTPS origin or credential file', () => {
    for (const publicOrigin of ['', 'http://panel.example.test:3211', ORIGIN + '/', ORIGIN + '/path', 'https://user:pass@panel.example.test:3211']) assert.throws(() => createGateway({ ...defaults, publicOrigin }));
    assert.throws(() => createGateway({ ...defaults, htpasswdPath: join(directory, 'missing') }));
    assert.throws(() => createGateway({ ...defaults, sessionTtlMs: 13 * 3600_000 }));
  });
  await check('public shell/assets only, no API or credential data and no session allocation', async () => {
    const count = upstreamCalls;
    for (const path of ['/', '/index.html', '/assets/index-test.js', '/assets/index-test.css']) {
      const reply = await call(port, path);
      assert.equal(reply.status, 200); assert.equal(reply.headers['set-cookie'], undefined);
      assert(!reply.text.includes('secret'));
      assert.equal(reply.headers['cache-control'], path.startsWith('/assets/') ? 'public, max-age=0' : 'no-store');
      assert.equal(reply.headers['content-encoding'], undefined);
    }
    const reply = await call(port, '/api/auth/session');
    assert.deepEqual(reply.data, { authenticated: false }); assert.equal(reply.status, 200);
    assert.equal(reply.headers['set-cookie'], undefined);
    assert.equal(upstreamCalls, count);
  });
  await check('only allowlisted Vite-hashed assets are immutable; index stays no-store', async () => {
    for (const path of textFixtures.keys()) {
      const reply = await call(port, path + '?v=ignored');
      assert.equal(reply.status, 200);
      assert.equal(reply.headers['cache-control'], 'public, max-age=31536000, immutable');
    }
    for (const path of ['/assets/index-test.js', '/assets/index-test.css', '/assets/logo.png']) {
      assert.equal((await call(port, path)).headers['cache-control'], 'public, max-age=0');
    }
    for (const path of ['/', '/index.html']) {
      const reply = await call(port, path, { headers: { 'accept-encoding': 'br, gzip' } });
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['content-encoding'], undefined);
    }
  });
  await check('startup JS/CSS/SVG gzip and Brotli decode to exact original bytes', async () => {
    for (const [path, original] of textFixtures) {
      for (const encoding of ['br', 'gzip', 'identity']) {
        const reply = await call(port, path, { headers: { 'accept-encoding': encoding } });
        assert.equal(reply.status, 200);
        assert.equal(reply.headers.vary, 'Accept-Encoding');
        assert.equal(Number(reply.headers['content-length']), reply.body.length);
        assert.equal(reply.headers['content-encoding'], encoding === 'identity' ? undefined : encoding);
        assert.deepEqual(encoding === 'br' ? brotliDecompressSync(reply.body) : encoding === 'gzip' ? gunzipSync(reply.body) : reply.body, original);
      }
    }
    const image = await call(port, '/assets/logo.png', { headers: { 'accept-encoding': 'br, gzip' } });
    assert.equal(image.headers['content-encoding'], undefined);
  });
  await check('Accept-Encoding weights, exclusions, wildcard and identity are respected', async () => {
    const path = '/assets/index-Ab3d_5-X.js';
    for (const [header, expected] of [
      ['', 'identity'], ['br, gzip', 'br'], ['br;q=0, gzip', 'gzip'],
      ['br;q=0.2, gzip;q=0.8', 'gzip'], ['br;q=1, gzip;q=0', 'br'],
      ['BR;Q=0.8, GZip;q=0.1', 'br'], ['br;q=0.9, identity;q=1', 'identity'],
      ['br;q=0, gzip;q=0', 'identity'], ['*;q=0.5, br;q=0', 'gzip'],
      ['*;q=0, identity;q=0.5', 'identity'], ['gzip;q=0.5, identity;q=0', 'gzip'],
      ['deflate', 'identity'], ['br;q=bogus, gzip;q=0.5', 'gzip'],
      ['br;q=0, br;q=1, gzip;q=1', 'gzip'],
    ]) {
      const reply = await call(port, path, { headers: { 'accept-encoding': header! } });
      assert.equal(reply.status, 200, header);
      assert.equal(reply.headers['content-encoding'], expected === 'identity' ? undefined : expected, header);
    }
    for (const header of ['br;q=0, gzip;q=0, identity;q=0', '*;q=0', 'deflate, identity;q=0']) {
      const reply = await call(port, path, { headers: { 'accept-encoding': header } });
      assert.equal(reply.status, 406, header); assert.equal(reply.body.length, 0);
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers.vary, 'Accept-Encoding');
    }
  });
  await check('HEAD selects the same representation and length as GET but has no body', async () => {
    for (const path of ['/', '/assets/index-test.js', '/assets/index-Ab3d_5-X.js', '/assets/style-F6g7H8i9.css', '/assets/logo.png']) {
      for (const encoding of ['identity', 'br', 'gzip']) {
        const headers = { 'accept-encoding': encoding };
        const get = await call(port, path, { headers });
        const head = await call(port, path, { method: 'HEAD', headers });
        assert.equal(head.status, get.status); assert.equal(head.body.length, 0);
        for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'vary']) assert.equal(head.headers[name], get.headers[name], name);
      }
    }
    const reply = await call(port, '/assets/index-test.js', { method: 'HEAD', headers: { 'accept-encoding': '*;q=0' } });
    assert.equal(reply.status, 406); assert.equal(reply.body.length, 0);
  });
  await check('static files and all compressed variants remain an immutable startup snapshot', async () => {
    const path = '/assets/index-Ab3d_5-X.js';
    const original = textFixtures.get(path)!;
    writeFileSync(join(web, path), 'changed after gateway creation');
    writeFileSync(join(web, 'assets', 'later-A1b2C3d4.js'), 'not in startup allowlist');
    try {
      for (const encoding of ['identity', 'gzip', 'br']) {
        const reply = await call(port, path, { headers: { 'accept-encoding': encoding } });
        assert.deepEqual(encoding === 'br' ? brotliDecompressSync(reply.body) : encoding === 'gzip' ? gunzipSync(reply.body) : reply.body, original);
      }
      assert.equal((await call(port, '/assets/later-A1b2C3d4.js')).status, 404);
    } finally { writeFileSync(join(web, path), original); }
  });
  await check('snapshot caps raw file size, entry count and raw plus compressed aggregate', () => {
    function fixture(name: string): string {
      const root = join(directory, name);
      mkdirSync(join(root, 'assets'), { recursive: true });
      writeFileSync(join(root, 'index.html'), '<!doctype html>');
      return root;
    }
    const oversize = fixture('oversize');
    writeFileSync(join(oversize, 'assets', 'big.js'), Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.throws(() => createGateway({ ...defaults, webRoot: oversize }), /Static assets too large/);
    const crowded = fixture('crowded');
    for (let i = 0; i < 2048; i++) writeFileSync(join(crowded, 'assets', `empty-${i}.png`), '');
    assert.throws(() => createGateway({ ...defaults, webRoot: crowded }), /Static assets too large/);
    const aggregate = fixture('aggregate');
    // 24 MiB of high-entropy input is below 64 MiB raw, but both compressed
    // representations make the retained aggregate exceed the cap.
    const entropy = randomBytes(8 * 1024 * 1024);
    for (let i = 0; i < 3; i++) writeFileSync(join(aggregate, 'assets', `random-${i}.js`), entropy);
    assert.throws(() => createGateway({ ...defaults, webRoot: aggregate }), /Static assets too large/);
  });
  await check('all unauthenticated data routes blocked without Basic challenge', async () => {
    const count = upstreamCalls;
    for (const path of ['/api', '/api/config', '/api/status', '/api/unknown?x=1']) {
      const reply = await call(port, path);
      assert.equal(reply.status, 401); assert.equal(reply.headers['www-authenticate'], undefined);
      assert.equal(reply.headers['cache-control'], 'no-store'); assert(!reply.text.includes('secret'));
    }
    assert.equal((await call(port, '/api/config', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(upstreamCalls, count);
  });
  await check('unknown/static traversal and private file requests never reach upstream', async () => {
    const count = upstreamCalls;
    for (const path of ['/config.json', '/assets/private.json', '/assets/index-test.js.map', '/assets/.hidden.js', '/assets/linked.js', '/assets/missing.js', '/assets/missing-A1b2C3d4.js', '/assets/nested/hidden-Ab3d_5-X.js', '/anything', '/api/auth/unknown']) assert.equal((await call(port, path)).status, 404, path);
    for (const path of ['/assets/../config.json', '/assets/%2e%2e/config.json', '/assets%2f..%2fconfig.json', '/assets\\secret', '//api/config']) assert.equal((await call(port, path)).status, 400, path);
    assert.equal(upstreamCalls, count);
  });
  await check('Host and forwarded HTTPS are mandatory; arbitrary forwarded hosts ignored', async () => {
    for (const headers of [{ host: 'evil.example' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' }, { host: 'evil.example', 'x-forwarded-host': HOST }]) assert.equal((await call(port, '/', { headers })).status, 403);
    assert.equal((await call(port, '/', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-for': 'evil' } })).status, 200);
  });
  await check('login enforces exact Origin, fetch-site, JSON, valid body and credentials', async () => {
    assert.equal((await login(port, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await login(port, { origin: '' })).status, 403);
    assert.equal((await login(port, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await login(port, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await login(port, {}, 'wrong')).status, 401);
    assert.equal((await login(port, {}, PASSWORD, 'not-a-user')).status, 401);
    assert.equal((await login(port, {}, PASSWORD, 'unsupported')).status, 401);
    assert.equal((await login(port, {}, 'sha-fixture', 'shauser')).status, 200);
    for (const body of ['{', 'null', '[]', '{}', '{"username":"a:b","password":"x"}', JSON.stringify({ username: 'mock-admin', password: 'x'.repeat(1025) })]) {
      const reply = await call(port, '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body });
      assert.equal(reply.status, 400); assert(!reply.text.includes(PASSWORD));
    }
  });
  await check('oversized declared and chunked login bodies return 413 promptly', async () => {
    for (const extra of [{ body: 'x'.repeat(5000), headers: { 'content-length': '5000' } }, { chunks: ['x'.repeat(3000), 'x'.repeat(3000)], headers: {} }]) {
      const reply = await call(port, '/api/auth/login', { method: 'POST', ...extra, headers: { origin: ORIGIN, 'content-type': 'application/json', ...extra.headers } });
      assert.equal(reply.status, 413); assert.equal(reply.headers.connection, 'close');
    }
  });
  let auth = session(await login(port));
  await check('login cookie and session bootstrap contract, no cookie renewal', async () => {
    const reply = await call(port, '/api/auth/session', { headers: { cookie: auth.cookie } });
    assert.deepEqual(reply.data, { authenticated: true, username: 'mock-admin', csrfToken: auth.csrf });
    assert.equal(reply.headers['set-cookie'], undefined);
    assert.equal((await call(port, '/api/config', { headers: { cookie: '__Host-maid_session=' + 'a'.repeat(43) } })).status, 401);
    assert.equal((await call(port, '/api/config', { headers: { cookie: `${auth.cookie}; ${auth.cookie}` } })).status, 401);
  });
  await check('authenticated reads proxy exact query and strip request/response secrets', async () => {
    const reply = await call(port, '/api/config?selected=fixture', { headers: { ...authHeaders(auth), authorization: 'Basic do-not-forward', 'x-forwarded-for': 'evil', cookie: auth.cookie + '; botCookie=never', connection: 'x-secret', 'x-secret': 'never' } });
    assert.equal(reply.status, 200); assert.equal(reply.data.path, '/api/config?selected=fixture');
    assert.equal(reply.data.privateConfig, 'secret-from-protected-upstream');
    for (const header of ['cookie', 'authorization', 'x-csrf-token', 'x-forwarded-for', 'x-real-ip', 'x-secret']) assert.equal(reply.data.headers[header], undefined, header);
    for (const header of ['set-cookie', 'www-authenticate', 'access-control-allow-origin']) assert.equal(reply.headers[header], undefined, header);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal((await call(port, '/api/unknown', { headers: { cookie: auth.cookie } })).status, 404);
  });
  await check('auth and private API responses stay uncompressed and no-store for br/gzip clients', async () => {
    const headers = { 'accept-encoding': 'br, gzip' };
    const replies = [
      await call(port, '/api/auth/session', { headers: { ...headers, cookie: auth.cookie } }),
      await call(port, '/api/config', { headers: { ...headers, cookie: auth.cookie } }),
      await call(port, '/api/config', { headers: { 'accept-encoding': 'br, gzip' } }),
      await call(port, '/api/auth/unknown', { headers }),
      await login(port, { 'accept-encoding': 'br, gzip' }),
      await login(port, { 'accept-encoding': 'br, gzip' }, 'wrong'),
    ];
    for (const reply of replies) {
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.equal(reply.headers['content-encoding'], undefined);
      assert.equal(reply.headers.vary, undefined);
    }
    const proxied = replies[1]!;
    assert.equal(proxied.status, 200);
    assert.equal(proxied.data.headers['accept-encoding'], undefined);
    const logout = await call(port, '/api/auth/logout', { method: 'POST', headers: { ...authHeaders(session(replies[4]!)), 'accept-encoding': 'br, gzip' } });
    assert.equal(logout.status, 200); assert.equal(logout.headers['cache-control'], 'no-store');
    assert.equal(logout.headers['content-encoding'], undefined);
  });
  await check('every mutation requires both same-origin and exact CSRF, even JSON', async () => {
    const count = upstreamCalls;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const headers of [{ cookie: auth.cookie }, { ...authHeaders(auth), origin: '' }, { ...authHeaders(auth), origin: 'https://evil.test' }, { ...authHeaders(auth), 'x-csrf-token': '' }, { ...authHeaders(auth), 'x-csrf-token': 'a'.repeat(43) }, { ...authHeaders(auth), 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await call(port, '/api/config', { method, headers, body: '{}' })).status, 403);
      }
    }
    assert.equal(upstreamCalls, count);
    const reply = await call(port, '/api/config', { method: 'POST', headers: authHeaders(auth), body: '{"enabled":true}' });
    assert.equal(reply.status, 200); assert.equal(reply.data.body, '{"enabled":true}');
    assert.equal(reply.data.headers['x-csrf-token'], undefined);
  });
  await check('login rotation invalidates previous cookie', async () => {
    const previous = auth;
    auth = session(await login(port, { cookie: previous.cookie }));
    assert.notEqual(auth.cookie, previous.cookie); assert.notEqual(auth.csrf, previous.csrf);
    assert.equal((await call(port, '/api/config', { headers: { cookie: previous.cookie } })).status, 401);
  });
  await check('logout needs Origin and CSRF, destroys session and clears Secure cookie', async () => {
    assert.equal((await call(port, '/api/auth/logout', { method: 'POST', headers: { cookie: auth.cookie } })).status, 403);
    const reply = await call(port, '/api/auth/logout', { method: 'POST', headers: authHeaders(auth) });
    assert.deepEqual(reply.data, { authenticated: false });
    assert.match(reply.headers['set-cookie']![0]!, /HttpOnly; Secure; SameSite=Strict; Max-Age=0$/);
    assert.equal((await call(port, '/api/config', { headers: { cookie: auth.cookie } })).status, 401);
    assert.equal((await call(port, '/api/auth/logout', { method: 'POST', headers: authHeaders(auth) })).status, 401);
  });
  await check('absolute 12-hour expiry and bounded session eviction', async () => {
    const boundedPort = await listen(createGateway({ ...defaults, maxSessions: 2, sessionTtlMs: 1000 }));
    const first = session(await login(boundedPort));
    const second = session(await login(boundedPort));
    session(await login(boundedPort));
    assert.equal((await call(boundedPort, '/api/config', { headers: { cookie: first.cookie } })).status, 401);
    assert.equal((await call(boundedPort, '/api/config', { headers: { cookie: second.cookie } })).status, 200);
    time += 1000;
    assert.deepEqual((await call(boundedPort, '/api/auth/session', { headers: { cookie: second.cookie } })).data, { authenticated: false });
    assert.equal((await call(boundedPort, '/api/config', { headers: { cookie: second.cookie } })).status, 401);
    const fullTtl = session(await login(port));
    time += 12 * 3600_000 - 1;
    assert.equal((await call(port, '/api/config', { headers: { cookie: fullTtl.cookie } })).status, 200);
    time += 1;
    assert.equal((await call(port, '/api/config', { headers: { cookie: fullTtl.cookie } })).status, 401);
  });
  await check('per-IP rate ignores X-Forwarded-For, resets by clock and has global cap', async () => {
    const limited = await listen(createGateway({ ...defaults, loginMaxPerIp: 2, loginMaxGlobal: 4, loginWindowMs: 1000 }));
    assert.equal((await login(limited, {}, 'bad')).status, 401);
    assert.equal((await login(limited, { 'x-forwarded-for': '198.51.100.99' }, 'bad')).status, 401);
    assert.equal((await login(limited, { 'x-forwarded-for': '198.51.100.100' }, 'bad')).status, 429);
    assert.equal((await login(limited, { 'x-real-ip': '192.0.2.11' }, 'bad')).status, 401);
    assert.equal((await login(limited, { 'x-real-ip': '192.0.2.12' }, 'bad')).status, 429);
    time += 1000;
    assert.equal((await login(limited)).status, 200);
    const bounded = await listen(createGateway({ ...defaults, maxRateEntries: 1 }));
    assert.equal((await login(bounded, {}, 'bad')).status, 401);
    assert.equal((await login(bounded, { 'x-real-ip': '192.0.2.20' }, 'bad')).status, 429);
  });
  await check('auth method mismatch and HEAD handling remain safe', async () => {
    for (const [path, method] of [['/api/auth/login', 'GET'], ['/api/auth/session', 'POST'], ['/api/auth/logout', 'GET']]) assert.equal((await call(port, path!, { method })).status, 405);
    assert.equal((await call(port, '/', { method: 'POST', body: '{}' })).status, 404);
    const reply = await call(port, '/assets/index-test.js', { method: 'HEAD' });
    assert.equal(reply.status, 200); assert.equal(reply.text, '');
  });
  await check('upstream failure is generic 502, never a raw socket error', async () => {
    const dead = await listen(createServer());
    const deadServer = servers[servers.length - 1]!;
    await new Promise<void>(done => deadServer.close(() => done()));
    const disconnected = await listen(createGateway({ ...defaults, upstreamPort: dead }));
    const active = session(await login(disconnected));
    const reply = await call(disconnected, '/api/config', { headers: { cookie: active.cookie } });
    assert.equal(reply.status, 502); assert.equal(reply.data.error, 'Upstream unavailable'); assert(!reply.text.includes('ECONN'));
  });
  console.log(`PASS: ${checks} isolated panel auth test groups; production untouched`);
} finally {
  await Promise.all(servers.map(server => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); })));
  // Check the exact resolved deletion target before removing only our own fixture.
  assert.equal(realpathSync(directory), temporaryRoot);
  assert(temporaryRoot.startsWith(realpathSync(tmpdir()) + sep + 'maid-panel-auth-test-'));
  assert.equal(resolve(directory), temporaryRoot);
  rmSync(temporaryRoot, { recursive: true, force: true });
}
