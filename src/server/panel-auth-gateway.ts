// Standalone panel authentication boundary. Node 24 native TypeScript; no bot imports.
// Run: PANEL_PUBLIC_ORIGIN=https://panel.example.com node src/server/panel-auth-gateway.ts
// nginx MUST preserve Host ($http_host), overwrite X-Forwarded-Proto with https and
// X-Real-IP with $remote_addr, and proxy ONLY to 127.0.0.1:3213. Never expose 3210.
// Static files and htpasswd are snapshotted at startup; restart ONLY this gateway to reload.
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const COOKIE = '__Host-maid_session';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const USERNAME = /^[A-Za-z0-9_.@-]{1,64}$/;
const ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const md5 = (...parts: (string | Buffer)[]) => {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

/** Apache $apr1$ (MD5 crypt), implemented locally: passwords never enter argv/logs. */
export function apr1(password: string, salt: string): string {
  if (!/^[./A-Za-z0-9]{1,8}$/.test(salt)) throw new Error('Invalid salt');
  const key = Buffer.from(password, 'utf8');
  const alternate = md5(key, salt, key);
  const initial: (string | Buffer)[] = [key, '$apr1$', salt];
  for (let left = key.length; left > 0; left -= 16) initial.push(alternate.subarray(0, Math.min(16, left)));
  for (let bits = key.length; bits > 0; bits >>= 1) initial.push(bits & 1 ? Buffer.from([0]) : key.subarray(0, 1));
  let digest = md5(...initial);
  for (let i = 0; i < 1000; i++) {
    const parts: (string | Buffer)[] = [i & 1 ? key : digest];
    if (i % 3) parts.push(salt);
    if (i % 7) parts.push(key);
    parts.push(i & 1 ? digest : key);
    digest = md5(...parts);
  }
  let encoded = '';
  for (const [a, b, c, count] of [[0, 6, 12, 4], [1, 7, 13, 4], [2, 8, 14, 4], [3, 9, 15, 4], [4, 10, 5, 4], [0, 0, 11, 2]]) {
    let value = count === 2 ? digest[c]! : (digest[a]! << 16) | (digest[b]! << 8) | digest[c]!;
    for (let n = 0; n < count!; n++) { encoded += ALPHABET[value & 63]; value >>>= 6; }
  }
  return `$apr1$${salt}$${encoded}`;
}

function equal(a: string, b: string): boolean {
  // Hash first so timingSafeEqual always receives the same byte length.
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export interface GatewayOptions {
  publicOrigin: string;
  htpasswdPath?: string;
  webRoot?: string;
  upstreamPort?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  loginWindowMs?: number;
  loginMaxPerIp?: number;
  loginMaxGlobal?: number;
  maxRateEntries?: number;
}
interface Session { username: string; csrfToken: string; expiresAt: number }
type ContentEncoding = 'br' | 'gzip' | 'identity';
interface StaticAsset { body: Buffer; type: string; cacheControl: string; gzip?: Buffer; br?: Buffer }
const STATIC_SNAPSHOT_LIMIT = 64 * 1024 * 1024;
const STATIC_FILE_LIMIT = 8 * 1024 * 1024;
const STATIC_ENTRY_LIMIT = 2048;
// Vite's default content hash is eight URL-safe characters, separated from the name
// by '-'. Only already allowlisted files under /assets/ may receive immutable caching.
const HASHED_ASSET = /^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
class RequestFailure extends Error {
  status: number;
  constructor(status: number) { super('Request rejected'); this.status = status; }
}

function positive(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > maximum) throw new Error('Invalid gateway configuration');
  return n;
}
function isLoopback(ip: string | undefined): boolean { return ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip === '::1'; }

function loadCredentials(path: string): Map<string, string> {
  if (!statSync(path).isFile() || statSync(path).size > 64 * 1024) throw new Error('Invalid credential file');
  const users = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    const name = line.slice(0, index);
    if (index < 1 || !USERNAME.test(name) || users.has(name)) throw new Error('Invalid credential file');
    // Unknown password schemes are retained but can never authenticate (fail closed).
    users.set(name, line.slice(index + 1));
  }
  if (!users.size) throw new Error('Empty credential file');
  return users;
}

function staticAssets(root: string): Map<string, StaticAsset> {
  const base = realpathSync(root);
  const assets = new Map<string, StaticAsset>();
  let total = 0;
  function retain(body: Buffer): Buffer {
    total += body.length;
    if (total > STATIC_SNAPSHOT_LIMIT) throw new Error('Static assets too large');
    return body;
  }
  function add(url: string, path: string, type: string): void {
    if (lstatSync(path).isSymbolicLink()) return;
    const actual = realpathSync(path);
    if (!actual.startsWith(base + sep) || !statSync(actual).isFile()) return;
    const size = statSync(actual).size;
    if (size > STATIC_FILE_LIMIT || total + size > STATIC_SNAPSHOT_LIMIT || assets.size >= STATIC_ENTRY_LIMIT) throw new Error('Static assets too large');
    const body = retain(readFileSync(actual));
    if (body.length > STATIC_FILE_LIMIT) throw new Error('Static assets too large');
    const asset: StaticAsset = {
      body, type,
      cacheControl: url.startsWith('/assets/') ? HASHED_ASSET.test(url) ? 'public, max-age=31536000, immutable' : 'public, max-age=0' : 'no-store',
    };
    // Only public JS/CSS/SVG text is compressed, once per startup, never auth/API or
    // index HTML. Fast settings keep retained historical Vite bundles inexpensive.
    if (/\.(?:js|css|svg)$/.test(url)) {
      asset.gzip = retain(gzipSync(body, { level: 1 }));
      asset.br = retain(brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } }));
    }
    assets.set(url, asset);
  }
  add('/', join(base, 'index.html'), 'text/html; charset=utf-8');
  if (!assets.has('/')) throw new Error('Missing public index');
  assets.set('/index.html', assets.get('/')!);
  const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  const dir = join(base, 'assets');
  // Only explicit, flat, known static extensions; no source maps, JSON, directories,
  // symlinks, dotfiles, fallback-to-index, or arbitrary upstream public requests.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(entry.name)) continue;
    const type = types[extname(entry.name)];
    if (type) add(`/assets/${entry.name}`, join(dir, entry.name), type);
  }
  return assets;
}

/** Negotiate only stored representations; malformed/duplicate weights fail closed. */
function contentEncoding(header: string | undefined, asset: StaticAsset): ContentEncoding | undefined {
  if (!header?.trim()) return 'identity';
  const weights = new Map<string, number>();
  for (const part of header.split(',')) {
    const fields = part.trim().toLowerCase().split(';').map(field => field.trim());
    const coding = fields[0]!;
    if (!['br', 'gzip', 'identity', '*'].includes(coding)) continue;
    const parameter = fields[1];
    const valid = fields.length === 1 || (fields.length === 2 && /^q=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(parameter!));
    const weight = valid ? parameter ? Number(parameter.slice(2)) : 1 : 0;
    weights.set(coding, Math.min(weights.get(coding) ?? 1, weight));
  }
  let selected: ContentEncoding | undefined;
  let best = 0;
  // Preference breaks equal q values; implicit identity is the fallback unless
  // explicitly weighted/excluded (RFC 9110 also excludes it for wildcard q=0).
  for (const coding of ['br', 'gzip', 'identity'] as const) {
    if (coding !== 'identity' && !asset[coding]) continue;
    const weight = weights.get(coding) ?? (coding === 'identity' ? 0 : weights.get('*') ?? 0);
    if (weight > best) { selected = coding; best = weight; }
  }
  if (!selected && !weights.has('identity') && weights.get('*') !== 0) return 'identity';
  return selected;
}

function json(res: ServerResponse, status: number, data: unknown, cookie?: string): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 413 || status === 408 ? { connection: 'close' } : {}),
    ...(cookie ? { 'set-cookie': cookie } : {}),
  });
  res.end(body);
}
function reject(res: ServerResponse, status: number): void {
  const errors: Record<number, string> = { 400: 'Invalid request', 401: 'Authentication required', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 408: 'Request timeout', 413: 'Request too large', 415: 'JSON required', 429: 'Too many requests', 502: 'Upstream unavailable' };
  json(res, status, { ok: false, error: errors[status] ?? 'Request failed' });
}
function readBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: RequestFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', aborted);
      if (error) { req.resume(); fail(error); } else done(Buffer.concat(chunks));
    };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > maximum) finish(new RequestFailure(413)); else chunks.push(chunk); };
    const end = () => finish();
    const aborted = () => finish(new RequestFailure(400));
    const timer = setTimeout(() => finish(new RequestFailure(408)), 10_000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('aborted', aborted);
    req.once('error', aborted);
    if (Number(req.headers['content-length'] ?? 0) > maximum) finish(new RequestFailure(413));
  });
}

/** Creates but does not listen; tests can bind port 0 and inject a deterministic clock. */
export function createGateway(options: GatewayOptions): Server {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== options.publicOrigin || origin.username || origin.password) throw new Error('PANEL_PUBLIC_ORIGIN must be a canonical HTTPS origin');
  const upstreamPort = positive(options.upstreamPort, 3210, 65535);
  const ttl = positive(options.sessionTtlMs, 12 * 60 * 60 * 1000, 12 * 60 * 60 * 1000);
  const maxSessions = positive(options.maxSessions, 1024, 100_000);
  const windowMs = positive(options.loginWindowMs, 60_000);
  const maxPerIp = positive(options.loginMaxPerIp, 10);
  const maxGlobal = positive(options.loginMaxGlobal, 100);
  const maxEntries = positive(options.maxRateEntries, 4096, 100_000);
  const now = options.now ?? Date.now;
  const credentials = loadCredentials(options.htpasswdPath ?? '/etc/maid-bot/panel.htpasswd');
  const assets = staticAssets(options.webRoot ?? resolve(HERE, '../../web'));
  const sessions = new Map<string, Session>();
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  let global = { count: 0, expiresAt: 0 };
  function rateLimit(req: IncomingMessage): boolean {
    const time = now();
    if (global.expiresAt <= time) global = { count: 0, expiresAt: time + windowMs };
    if (++global.count > maxGlobal) return false;
    for (const [ip, entry] of attempts) if (entry.expiresAt <= time) attempts.delete(ip);
    // Only a verified loopback nginx peer supplies this. Never use X-Forwarded-For.
    const forwarded = req.headers['x-real-ip'];
    const ip = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : 'unknown';
    let entry = attempts.get(ip);
    if (!entry) {
      if (attempts.size >= maxEntries) return false;
      entry = { count: 0, expiresAt: time + windowMs };
      attempts.set(ip, entry);
    }
    return ++entry.count <= maxPerIp;
  }
  function currentSession(req: IncomingMessage): { id: string; session: Session } | undefined {
    const time = now();
    for (const [id, entry] of sessions) if (entry.expiresAt <= time) sessions.delete(id);
    const parts = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
    if (parts.length !== 1) return;
    const id = parts[0]!.slice(COOKIE.length + 1);
    if (!TOKEN.test(id)) return;
    const session = sessions.get(id);
    if (session) return { id, session };
  }
  function sameOrigin(req: IncomingMessage): boolean {
    return req.headers.origin === origin.origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin');
  }
  function csrf(req: IncomingMessage, session: Session): boolean {
    const token = req.headers['x-csrf-token'];
    return sameOrigin(req) && typeof token === 'string' && TOKEN.test(token) && equal(token, session.csrfToken);
  }
  const cookie = (id: string, maxAge: number) => `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A local process can impersonate nginx: loopback is a deployment trust boundary.
    // Canonical Host + HTTPS forwarding are mandatory even for public/session routes.
    if (!isLoopback(req.socket.remoteAddress) || req.headers.host !== origin.host || req.headers['x-forwarded-proto'] !== 'https') { reject(res, 403); req.resume(); return; }
    const rawPath = (req.url ?? '').split('?')[0]!;
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /[\\\x00-\x20]/.test(rawPath) || /%(?:2e|2f|5c)/i.test(rawPath) || rawPath.split('/').some(p => p === '.' || p === '..')) { reject(res, 400); req.resume(); return; }
    const method = req.method ?? '';
    const active = currentSession(req);
    if (rawPath === '/api/auth/session') {
      if (method !== 'GET') { reject(res, 405); req.resume(); return; }
      json(res, 200, active ? { authenticated: true, username: active.session.username, csrfToken: active.session.csrfToken } : { authenticated: false });
      return;
    }
    if (rawPath === '/api/auth/login') {
      if (method !== 'POST') { reject(res, 405); req.resume(); return; }
      if (!sameOrigin(req)) { reject(res, 403); req.resume(); return; }
      if (!rateLimit(req)) { reject(res, 429); req.resume(); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { reject(res, 415); req.resume(); return; }
      const body = await readBody(req, 4096);
      let data: unknown;
      try { data = JSON.parse(body.toString('utf8')); } catch { throw new RequestFailure(400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestFailure(400);
      const { username, password } = data as Record<string, unknown>;
      if (typeof username !== 'string' || !USERNAME.test(username) || typeof password !== 'string' || Buffer.byteLength(password) < 1 || Buffer.byteLength(password) > 1024 || /[\x00-\x1f\x7f]/.test(password)) throw new RequestFailure(400);
      const stored = credentials.get(username) ?? '$apr1$invalid$......................';
      const match = /^\$apr1\$([./A-Za-z0-9]{1,8})\$[./A-Za-z0-9]{22}$/.exec(stored);
      const sha = /^\{SHA\}[A-Za-z0-9+/]{27}=$/.test(stored);
      const actual = match ? apr1(password, match[1]!) : sha ? `{SHA}${createHash('sha1').update(password, 'utf8').digest('base64')}` : apr1(password, 'invalid');
      if (!equal(actual, stored) || !credentials.has(username) || (!match && !sha)) { reject(res, 401); return; }
      // Rotate an existing session on every successful login; expire oldest when full.
      if (active) sessions.delete(active.id);
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value!);
      const id = randomBytes(32).toString('base64url');
      const session = { username, csrfToken: randomBytes(32).toString('base64url'), expiresAt: now() + ttl };
      sessions.set(id, session);
      json(res, 200, { authenticated: true, username, csrfToken: session.csrfToken }, cookie(id, Math.floor(ttl / 1000)));
      return;
    }
    if (rawPath === '/api/auth/logout') {
      if (method !== 'POST') { reject(res, 405); req.resume(); return; }
      if (!active) { reject(res, 401); req.resume(); return; }
      if (!csrf(req, active.session)) { reject(res, 403); req.resume(); return; }
      sessions.delete(active.id);
      req.resume();
      json(res, 200, { authenticated: false }, cookie('', 0));
      return;
    }
    if (rawPath === '/api/auth' || rawPath.startsWith('/api/auth/')) { reject(res, 404); req.resume(); return; }
    if (rawPath === '/api' || rawPath.startsWith('/api/')) {
      if (!active) { reject(res, 401); req.resume(); return; }
      if (!['GET', 'HEAD'].includes(method) && !csrf(req, active.session)) { reject(res, 403); req.resume(); return; }
      const body = ['GET', 'HEAD'].includes(method) ? undefined : await readBody(req, 1024 * 1024);
      // Strict request/response header allowlists: no credentials, cookies, forwarding,
      // hop-by-hop headers, CSRF tokens, Set-Cookie, CORS, or auth challenges reach bot/client.
      const headers: Record<string, string> = { host: `127.0.0.1:${upstreamPort}`, accept: 'application/json' };
      if (typeof req.headers['content-type'] === 'string') headers['content-type'] = req.headers['content-type'];
      if (body) headers['content-length'] = String(body.length);
      const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, method, path: req.url, headers }, response => {
        const output: Record<string, string | string[]> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
        for (const name of ['content-type', 'content-length', 'content-encoding']) if (response.headers[name] !== undefined) output[name] = response.headers[name]!;
        res.writeHead(response.statusCode ?? 502, output);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      // Match nginx's existing 120-second budget for LLM test/generation calls.
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.on('error', () => { if (res.headersSent) res.destroy(); else reject(res, 502); });
      res.on('close', () => upstream.destroy());
      upstream.end(body);
      return;
    }
    if (!['GET', 'HEAD'].includes(method)) { reject(res, 404); req.resume(); return; }
    const asset = assets.get(rawPath);
    if (!asset) { reject(res, 404); return; }
    const encoding = contentEncoding(req.headers['accept-encoding'], asset);
    if (!encoding) {
      // No acceptable stored representation. In particular, never send identity
      // against an explicit q=0. Keep HEAD bodyless, including this error case.
      res.writeHead(406, { 'content-length': 0, 'cache-control': 'no-store', vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff' });
      res.end();
      return;
    }
    const body = encoding === 'identity' ? asset.body : asset[encoding]!;
    res.writeHead(200, {
      'content-type': asset.type, 'content-length': body.length, 'cache-control': asset.cacheControl,
      vary: 'Accept-Encoding', ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
      'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    // No raw exception, body, credentials, request URL or upstream errors are logged.
    void handle(req, res).catch(error => { reject(res, error instanceof RequestFailure ? error.status : 500); req.resume(); });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createGateway({ publicOrigin: process.env.PANEL_PUBLIC_ORIGIN ?? '', htpasswdPath: process.env.PANEL_HTPASSWD_PATH, webRoot: process.env.PANEL_WEB_ROOT, upstreamPort: process.env.PANEL_UPSTREAM_PORT ? Number(process.env.PANEL_UPSTREAM_PORT) : undefined });
    const port = positive(process.env.PANEL_GATEWAY_PORT ? Number(process.env.PANEL_GATEWAY_PORT) : undefined, 3213, 65535);
    server.on('error', () => { console.error('Panel auth gateway failed to listen'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Panel auth gateway ready on 127.0.0.1:${port}`));
    const shutdown = () => { server.close(); server.closeIdleConnections(); setTimeout(() => process.exit(0), 5000).unref(); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  } catch { console.error('Panel auth gateway startup failed; check gateway configuration and readable files'); process.exitCode = 1; }
}
