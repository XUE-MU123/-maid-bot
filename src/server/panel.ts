// 网页面板后端：只用 node:http 起的本地小服务，给老大点着用的控制台。
// 零依赖、零框架：REST 返回 JSON，静态页面从 web/ 目录读。
// 约定：所有接口失败都返回 { ok:false, error:'中文原因' }，前端直接弹红色提示。
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeLogger } from '../core/logger.ts';
import { isMasterQq } from '../core/config.ts';
import { listIgnores, releaseIgnore } from '../modules/ignore.ts';
import { maskKey } from '../core/util.ts';
import type { DB } from '../core/db.ts';
import type { Config, LLMProfile, Session } from '../core/types.ts';
import type { OneBotClient } from '../onebot/client.ts';
import { deleteSession, getSession, listSessions, updateSession } from '../modules/session.ts';
import { clearMemory, effectiveKey, historyStats, messageCount, recentMessages, searchHistory } from '../modules/memory.ts';
import { getFavor, listFavors, setScore } from '../modules/favor.ts';
import { pingLLM } from '../modules/llm.ts';

const log = makeLogger('panel');

/** web/ 目录：panel.ts 在 src/server/ 下，往上两级就是项目根 */
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
/** package.json：面板底部显示版本号用 */
const PKG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export interface PanelDeps {
  config: Config;
  configPath: string;
  db: DB;
  client: OneBotClient;
  startedAt: number;
  getStatus: () => { onebotConnected: boolean; selfId: string; reconnects: number; lastError: string };
  saveConfig: () => void;
  onConfigChange?: () => void;
}

export interface PanelHandle {
  port: number;
  close: () => Promise<void>;
}

// ---------- 小工具 ----------

function readVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version?: string };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 包一层 try/catch：某个模块坏了也不能把整个面板拖死 */
function safe<T>(fn: () => T, fallback: T, label: string): T {
  try {
    return fn();
  } catch (err) {
    log.warn(`${label} 失败：${String((err as Error)?.message ?? err)}`);
    return fallback;
  }
}

/**
 * QQ 头像外链：群用 gh 接口，人用 nk 接口。
 * 这两个是腾讯公开的 CDN，浏览器直接加载，不经过我们服务器。
 */
function avatarOf(kind: 'group' | 'private', id: string): string {
  const safeId = String(id).replace(/[^0-9]/g, '');
  if (!safeId) return '';
  return kind === 'group'
    ? `https://p.qlogo.cn/gh/${safeId}/${safeId}/100/`
    : `https://q1.qlogo.cn/g?b=qq&nk=${safeId}&s=100`;
}

/** 去掉零宽字符和首尾空白；只剩空白的名字等于没有名字 */
function cleanNick(raw: string): string {
  return raw.replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/** 从历史消息里捡昵称（最新一条非空的），没有就返回空串 */
function nickMap(db: DB): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db.prepare(`
      SELECT sender_id, sender_name FROM messages
      WHERE sender_name IS NOT NULL AND sender_name <> ''
        AND id IN (SELECT MAX(id) FROM messages WHERE sender_name IS NOT NULL AND sender_name <> '' GROUP BY sender_id)
    `).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const id = String(r.sender_id ?? '');
      const name = cleanNick(String(r.sender_name ?? ''));
      if (id && name) out.set(id, name);
    }
  } catch {
    /* 读不到就当没昵称，面板不该因此报错 */
  }
  return out;
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function fail(res: ServerResponse, code: number, message: string): void {
  sendJson(res, code, { ok: false, error: message });
}

/** 读请求体（限制 1MB，防止有人怼大包） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((ok, no) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        no(new Error('请求内容太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => no(err));
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text) as unknown;
    return asObj(data);
  } catch {
    throw new Error('请求内容不是合法 JSON');
  }
}

/** 日志文件：先看项目根 logs/，再看配置目录旁边的 logs/ */
function findLogFile(deps: PanelDeps): string | null {
  const candidates = [
    join(process.cwd(), 'logs', 'bot.log'),
    resolve(dirname(deps.configPath), '..', 'logs', 'bot.log'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 只读文件尾部，别把整个大日志读进内存。
 * tailOffset = 上次读到哪个字节（必须在行边界上）；返回的 nextOffset 已越过最后一行完整日志，
 * 所以写了一半的行会留到下次再读，不会丢、也不会重复。
 */
function readLogTail(
  file: string,
  limit: number,
  tailOffset: number,
): { lines: string[]; fileSize: number; nextOffset: number } {
  try {
    const fileSize = statSync(file).size;
    const windowBytes = 512 * 1024;
    let begin: number;
    let atLineBoundary: boolean;

    if (tailOffset > 0 && tailOffset <= fileSize) {
      begin = tailOffset;
      atLineBoundary = true;
      if (fileSize - begin > windowBytes) {
        // 一下子攒了太多新日志，只取最后一段，第一行可能被切半
        begin = fileSize - windowBytes;
        atLineBoundary = false;
      }
    } else {
      // 首次读取，或日志被清空/轮转过：从最后 512KB 读
      begin = Math.max(0, fileSize - windowBytes);
      atLineBoundary = begin === 0;
    }

    if (fileSize <= begin) return { lines: [], fileSize, nextOffset: begin };

    const len = fileSize - begin;
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, begin);
    } finally {
      closeSync(fd);
    }

    // 末尾可能是正在写、还没换行的一行：只认最后一个换行之前的内容
    const lastNl = buf.lastIndexOf(0x0a);
    const complete = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : Buffer.alloc(0);
    const nextOffset = lastNl >= 0 ? begin + lastNl + 1 : begin;
    const parts = complete.toString('utf8').split(/\r?\n/);
    if (!atLineBoundary && parts.length > 0) parts.shift(); // 第一行被切半，丢掉
    const lines = parts.filter((l) => l.trim() !== '').slice(-limit);
    return { lines, fileSize, nextOffset };
  } catch {
    return { lines: [], fileSize: 0, nextOffset: 0 };
  }
}

function usageTotals(db: DB): { totalPrompt: number; totalCompletion: number } {
  try {
    const row = db
      .prepare('SELECT COALESCE(SUM(prompt_tok), 0) AS p, COALESCE(SUM(complet_tok), 0) AS c FROM token_usage')
      .get() as Record<string, unknown> | undefined;
    return { totalPrompt: Number(row?.p ?? 0), totalCompletion: Number(row?.c ?? 0) };
  } catch {
    return { totalPrompt: 0, totalCompletion: 0 };
  }
}

/** 配置副本：Key 一律打码再给前端，绝不把真 Key 送到浏览器 */
function maskedConfig(config: Config): Config {
  const copy = structuredClone(config);
  copy.llm.apiKey = maskKey(copy.llm.apiKey);
  copy.vision.apiKey = maskKey(copy.vision.apiKey);
  copy.llm.fallback.apiKey = maskKey(copy.llm.fallback.apiKey);
  copy.onebot.accessToken = maskKey(copy.onebot.accessToken);
  // 每份接口档案的 Key 同样打码，浏览器永远拿不到真 Key
  copy.llm.profiles = (copy.llm.profiles ?? []).map((p) => ({ ...p, apiKey: maskKey(p.apiKey) }));
  return copy;
}

/** 接口档案的 ID：时间戳 + 随机尾巴，够用且不会撞 */
function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 档案名去重：重名自动加「(2)」「(3)」，免得下拉框里两行一模一样分不清 */
function uniqueProfileName(config: Config, name: string, exceptId = ''): string {
  const taken = new Set(
    (config.llm.profiles ?? []).filter((p) => p.id !== exceptId).map((p) => p.name),
  );
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

// ---------- 配置白名单更新 ----------

/** 把一个字符串 Key 写进配置；空串 / 打码值表示「不改」 */
function isKeepKey(v: string): boolean {
  return v.trim() === '' || v.includes('****');
}

function applyConfigPatch(config: Config, body: Record<string, unknown>): { changed: string[]; notes: string[] } {
  const changed: string[] = [];
  const notes: string[] = [];

  // ---- 模型接口 ----
  const llm = asObj(body.llm);
  const baseUrl = asStr(llm.baseUrl);
  if (baseUrl !== null && baseUrl.trim() !== '' && baseUrl.trim() !== config.llm.baseUrl) {
    config.llm.baseUrl = baseUrl.trim();
    changed.push('llm.baseUrl');
  }
  const apiKey = asStr(llm.apiKey);
  if (apiKey !== null && !isKeepKey(apiKey) && apiKey.trim() !== config.llm.apiKey) {
    config.llm.apiKey = apiKey.trim();
    changed.push('llm.apiKey');
  }
  const model = asStr(llm.model);
  if (model !== null && model.trim() !== '' && model.trim() !== config.llm.model) {
    config.llm.model = model.trim();
    changed.push('llm.model');
  }
  const fb = asObj(llm.fallback);
  const fbBase = asStr(fb.baseUrl);
  if (fbBase !== null && fbBase.trim() !== config.llm.fallback.baseUrl) {
    config.llm.fallback.baseUrl = fbBase.trim();
    changed.push('llm.fallback.baseUrl');
  }
  const fbKey = asStr(fb.apiKey);
  if (fbKey !== null && !isKeepKey(fbKey) && fbKey.trim() !== config.llm.fallback.apiKey) {
    config.llm.fallback.apiKey = fbKey.trim();
    changed.push('llm.fallback.apiKey');
  }
  const fbModel = asStr(fb.model);
  if (fbModel !== null && fbModel.trim() !== config.llm.fallback.model) {
    config.llm.fallback.model = fbModel.trim();
    changed.push('llm.fallback.model');
  }
  const temperature = asNum(llm.temperature);
  if (temperature !== null && clampNum(temperature, 0, 2) !== config.llm.temperature) {
    config.llm.temperature = clampNum(temperature, 0, 2);
    changed.push('llm.temperature');
  }
  const maxTokens = asNum(llm.maxTokens);
  if (maxTokens !== null) {
    const v = Math.round(clampNum(maxTokens, 1, 100000));
    if (v !== config.llm.maxTokens) {
      config.llm.maxTokens = v;
      changed.push('llm.maxTokens');
    }
  }
  const timeoutMs = asNum(llm.timeoutMs);
  if (timeoutMs !== null) {
    const v = Math.round(clampNum(timeoutMs, 1000, 600000));
    if (v !== config.llm.timeoutMs) {
      config.llm.timeoutMs = v;
      changed.push('llm.timeoutMs');
    }
  }
  const mock = asBool(llm.mock);
  if (mock !== null && mock !== config.llm.mock) {
    config.llm.mock = mock;
    changed.push('llm.mock');
  }

  // ---- 人格提示词 ----
  const persona = asObj(body.persona);
  const sysPrompt = asStr(persona.systemPrompt);
  if (sysPrompt !== null && sysPrompt !== config.persona.systemPrompt) {
    config.persona.systemPrompt = sysPrompt;
    changed.push('persona.systemPrompt');
  }
  const groupPro = asStr(persona.groupProactive);
  if (groupPro !== null && groupPro !== config.persona.groupProactive) {
    config.persona.groupProactive = groupPro;
    changed.push('persona.groupProactive');
  }
  const privatePro = asStr(persona.privateProactive);
  if (privatePro !== null && privatePro !== config.persona.privateProactive) {
    config.persona.privateProactive = privatePro;
    changed.push('persona.privateProactive');
  }
  const favorHint = asBool(persona.favorHint);
  if (favorHint !== null && favorHint !== config.persona.favorHint) {
    config.persona.favorHint = favorHint;
    changed.push('persona.favorHint');
  }

  // ---- 机器人开关 ----
  const bot = asObj(body.bot);
  const autoReply = asBool(bot.globalAutoReply);
  if (autoReply !== null && autoReply !== config.bot.globalAutoReply) {
    config.bot.globalAutoReply = autoReply;
    changed.push('bot.globalAutoReply');
  }
  const splitReply = asBool(bot.splitReply);
  if (splitReply !== null && splitReply !== config.bot.splitReply) {
    config.bot.splitReply = splitReply;
    changed.push('bot.splitReply');
  }
  const historyLimit = asNum(bot.historyLimit);
  if (historyLimit !== null) {
    const v = Math.round(clampNum(historyLimit, 1, 200));
    if (v !== config.bot.historyLimit) {
      config.bot.historyLimit = v;
      changed.push('bot.historyLimit');
    }
  }
  const maxCtx = asNum(bot.maxContextTokens);
  if (maxCtx !== null) {
    const v = Math.round(clampNum(maxCtx, 500, 200000));
    if (v !== config.bot.maxContextTokens) {
      config.bot.maxContextTokens = v;
      changed.push('bot.maxContextTokens');
    }
  }

  // ---- 出图 ----
  const render = asObj(body.render);
  const rEnabled = asBool(render.enabled);
  if (rEnabled !== null && rEnabled !== config.render.enabled) {
    config.render.enabled = rEnabled;
    changed.push('render.enabled');
  }
  for (const key of ['tables', 'svg', 'mermaid'] as const) {
    const v = asBool(render[key]);
    if (v !== null && v !== config.render[key]) {
      config.render[key] = v;
      changed.push(`render.${key}`);
    }
  }
  const rMax = asNum(render.maxImages);
  if (rMax !== null) {
    const v = Math.round(clampNum(rMax, 0, 3));
    if (v !== config.render.maxImages) {
      config.render.maxImages = v;
      changed.push('render.maxImages');
    }
  }
  const rPreset = asStr(render.tablePreset);
  const PRESETS = ['yuzu-deep', 'yuzu-lace', 'yuzu-bubble', 'magazine', 'cyber', 'candy'];
  if (rPreset !== null && PRESETS.includes(rPreset) && rPreset !== config.render.tablePreset) {
    config.render.tablePreset = rPreset;
    changed.push('render.tablePreset');
  }
  const rTimeout = asNum(render.timeoutMs);
  if (rTimeout !== null) {
    const v = Math.round(clampNum(rTimeout, 3000, 60000));
    if (v !== config.render.timeoutMs) {
      config.render.timeoutMs = v;
      changed.push('render.timeoutMs');
    }
  }

  // ---- 日志级别 ----
  const logging = asObj(body.logging);
  const logLevel = asStr(logging.level);
  if (logLevel !== null) {
    const lv = logLevel.trim().toLowerCase();
    if (['debug', 'info', 'warn', 'error'].includes(lv) && lv !== config.logging.level) {
      config.logging.level = lv as Config['logging']['level'];
      changed.push('logging.level');
    }
  }
  const keepDays = asNum(logging.keepDays);
  if (keepDays !== null) {
    const v = Math.round(clampNum(keepDays, 1, 90));
    if (v !== config.logging.keepDays) {
      config.logging.keepDays = v;
      changed.push('logging.keepDays');
      notes.push(`日志保留天数已改为 ${v} 天，重启机器人后生效`);
    }
  }

  // ---- 识图 ----
  const vision = asObj(body.vision);
  const vEnabled = asBool(vision.enabled);
  if (vEnabled !== null && vEnabled !== config.vision.enabled) {
    config.vision.enabled = vEnabled;
    changed.push('vision.enabled');
  }
  const vModel = asStr(vision.model);
  if (vModel !== null && vModel.trim() && vModel.trim() !== config.vision.model) {
    config.vision.model = vModel.trim();
    changed.push('vision.model');
  }
  const vBase = asStr(vision.baseUrl);
  if (vBase !== null && vBase.trim() !== config.vision.baseUrl) {
    config.vision.baseUrl = vBase.trim();
    changed.push('vision.baseUrl');
  }
  const vKey = asStr(vision.apiKey);
  if (vKey !== null && vKey.trim() && !isKeepKey(vKey) && vKey.trim() !== config.vision.apiKey) {
    config.vision.apiKey = vKey.trim();
    changed.push('vision.apiKey');
  }
  const vTimeout = asNum(vision.timeoutMs);
  if (vTimeout !== null) {
    const v = Math.round(clampNum(vTimeout, 5000, 300000));
    if (v !== config.vision.timeoutMs) {
      config.vision.timeoutMs = v;
      changed.push('vision.timeoutMs');
    }
  }
  const vChars = asNum(vision.maxChars);
  if (vChars !== null) {
    const v = Math.round(clampNum(vChars, 40, 1000));
    if (v !== config.vision.maxChars) {
      config.vision.maxChars = v;
      changed.push('vision.maxChars');
    }
  }

  // ---- 全局触发关键词（逗号分隔）----
  if (typeof bot.triggerKeywords === 'string') {
    const list = String(bot.triggerKeywords)
      .split(/[,，\s]+/)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (JSON.stringify(list) !== JSON.stringify(config.bot.triggerKeywords)) {
      config.bot.triggerKeywords = list;
      changed.push('bot.triggerKeywords');
    }
  }

  // ---- 新会话默认触发概率 ----
  const defaults = asObj(body.defaults);
  const atProb = asNum(defaults.atProb);
  if (atProb !== null && clampNum(atProb, 0, 1) !== config.defaults.atProb) {
    config.defaults.atProb = clampNum(atProb, 0, 1);
    changed.push('defaults.atProb');
  }
  const keywordProb = asNum(defaults.keywordProb);
  if (keywordProb !== null && clampNum(keywordProb, 0, 1) !== config.defaults.keywordProb) {
    config.defaults.keywordProb = clampNum(keywordProb, 0, 1);
    changed.push('defaults.keywordProb');
  }
  const randomProb = asNum(defaults.randomProb);
  if (randomProb !== null && clampNum(randomProb, 0, 1) !== config.defaults.randomProb) {
    config.defaults.randomProb = clampNum(randomProb, 0, 1);
    changed.push('defaults.randomProb');
  }

  // ---- 面板端口（改完要重启才生效）----
  const panel = asObj(body.panel);
  const port = asNum(panel.port);
  if (port !== null) {
    const v = Math.round(clampNum(port, 1, 65535));
    if (v !== config.panel.port) {
      config.panel.port = v;
      changed.push('panel.port');
      notes.push(`面板端口已改为 ${v}，重启机器人后才会生效`);
    }
  }

  return { changed, notes };
}

// ---------- 会话补丁校验 ----------

function sanitizeSessionPatch(body: Record<string, unknown>): Partial<Session> {
  const patch: Partial<Session> = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.memoryShared === 'boolean') patch.memoryShared = body.memoryShared;
  if (typeof body.proactiveEnabled === 'boolean') patch.proactiveEnabled = body.proactiveEnabled;
  if (typeof body.prompt === 'string') patch.prompt = body.prompt.slice(0, 8000);
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 100);
  if (typeof body.keywords === 'string') patch.keywords = body.keywords.trim().slice(0, 500);
  const atProb = asNum(body.atProb);
  if (atProb !== null) patch.atProb = clampNum(atProb, 0, 1);
  const keywordProb = asNum(body.keywordProb);
  if (keywordProb !== null) patch.keywordProb = clampNum(keywordProb, 0, 1);
  const randomProb = asNum(body.randomProb);
  if (randomProb !== null) patch.randomProb = clampNum(randomProb, 0, 1);
  const pMin = asNum(body.proactiveMinMinutes);
  if (pMin !== null) patch.proactiveMinMinutes = Math.round(clampNum(pMin, 1, 1440));
  const pMax = asNum(body.proactiveMaxMinutes);
  if (pMax !== null) patch.proactiveMaxMinutes = Math.round(clampNum(pMax, 1, 1440));
  const pRounds = asNum(body.proactiveMaxRounds);
  if (pRounds !== null) patch.proactiveMaxRounds = Math.round(clampNum(pRounds, 1, 10));
  return patch;
}

// ---------- 静态文件 ----------

function serveStatic(res: ServerResponse, pathname: string): void {
  let rel = pathname;
  if (rel === '' || rel === '/') rel = '/index.html';

  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    fail(res, 400, '网址里有乱码');
    return;
  }
  if (decoded.includes('\0')) {
    fail(res, 400, '网址不合法');
    return;
  }

  // 防目录穿越：拼完必须还在 web/ 里面
  const full = resolve(WEB_ROOT, '.' + decoded);
  if (full !== WEB_ROOT && !full.startsWith(WEB_ROOT + sep)) {
    fail(res, 403, '不许访问面板目录以外的文件');
    return;
  }

  let target = full;
  try {
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  } catch {
    /* 忽略 */
  }

  const ext = extname(target).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    fail(res, 404, '没有这个文件');
    return;
  }
  if (!existsSync(target)) {
    fail(res, 404, '没有这个文件');
    return;
  }
  try {
    const buf = readFileSync(target);
    res.writeHead(200, {
      'content-type': mime,
      'content-length': buf.length,
      // 面板文件常改，别让浏览器缓存旧的
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(buf);
  } catch (err) {
    log.error(`读静态文件失败 ${target}：${String((err as Error)?.message ?? err)}`);
    fail(res, 500, '读取页面文件失败');
  }
}

// ---------- 启动面板 ----------

export async function startPanel(deps: PanelDeps): Promise<PanelHandle> {
  const version = readVersion();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const host = req.headers.host ?? '127.0.0.1';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      fail(res, 400, '网址不合法');
      return;
    }
    const pathname = url.pathname;

    // 非 /api/ 一律当静态文件
    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        fail(res, 405, '页面只支持 GET');
        return;
      }
      serveStatic(res, pathname);
      return;
    }

    // ===== 总览 =====
    if (pathname === '/api/overview' && method === 'GET') {
      const sessions = safe(() => listSessions(deps.db), [] as Session[], '读取会话列表');
      const favorList = safe(() => listFavors(deps.db, 500, deps.config.bot.masterIds), [], '读取好感度');
      let favorCount = favorList.length;
      try {
        const row = deps.db.prepare('SELECT COUNT(*) AS n FROM favor').get() as Record<string, unknown> | undefined;
        favorCount = Number(row?.n ?? favorCount);
      } catch {
        /* 表还没建也不该炸 */
      }
      sendJson(res, 200, {
        status: safe(() => deps.getStatus(), {
          onebotConnected: false, selfId: '', reconnects: 0, lastError: '',
        }, '读取连接状态'),
        stats: {
          messages: safe(() => messageCount(deps.db), 0, '统计消息总数'),
          sessions: sessions.length,
        },
        usage: usageTotals(deps.db),
        favorCount,
        uptimeSec: Math.max(0, Math.floor((Date.now() - deps.startedAt) / 1000)),
        version,
      });
      return;
    }

    // ===== 历史统计（面板「Token 用量」细节） =====
    if (pathname === '/api/stats' && method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        stats: safe(() => historyStats(deps.db), { total: 0, sessions: 0 }, '读取历史统计'),
        usage: usageTotals(deps.db),
      });
      return;
    }

    // ===== 配置读写 =====
    if (pathname === '/api/config' && method === 'GET') {
      sendJson(res, 200, maskedConfig(deps.config));
      return;
    }

    if (pathname === '/api/config' && method === 'POST') {
      const body = await readJson(req);
      const { changed, notes } = applyConfigPatch(deps.config, body);
      if (changed.length > 0) {
        try {
          deps.saveConfig();
        } catch (err) {
          fail(res, 500, `配置写回失败：${String((err as Error)?.message ?? err)}`);
          return;
        }
        try {
          deps.onConfigChange?.();
        } catch (err) {
          log.warn(`配置变更回调出错：${String((err as Error)?.message ?? err)}`);
        }
        log.info(`配置已更新：${changed.join('、')}`);
        sendJson(res, 200, { ok: true, changed, notes, config: maskedConfig(deps.config) });
      } else {
        sendJson(res, 200, { ok: true, changed, notes: ['没有需要保存的改动'], config: maskedConfig(deps.config) });
      }
      return;
    }

    // ===== 会话 =====
    if (pathname === '/api/sessions' && method === 'GET') {
      const sessions = safe(() => listSessions(deps.db), [] as Session[], '读取会话列表');
      const counts: Record<string, number> = {};
      for (const s of sessions) {
        // 用了「记忆互通」的会话，消息实际记在共享桶里，统计也要按实际键算
        counts[s.key] = safe(() => messageCount(deps.db, effectiveKey(s)), 0, `统计 ${s.key} 消息数`);
      }
      const nicks = nickMap(deps.db);
      const decorated = sessions.map((s) => ({
        ...s,
        avatar: avatarOf(s.type === 'group' ? 'group' : 'private', s.targetId),
        nickname: s.type === 'group' ? s.name : (nicks.get(s.targetId) || s.name || ''),
      }));
      sendJson(res, 200, { sessions: decorated, counts });
      return;
    }

    if (pathname.startsWith('/api/sessions/')) {
      const rawKey = pathname.slice('/api/sessions/'.length);
      let key = '';
      try {
        key = decodeURIComponent(rawKey);
      } catch {
        fail(res, 400, '会话编号不合法');
        return;
      }
      if (!key) {
        fail(res, 400, '缺少会话编号');
        return;
      }
      const session = getSession(deps.db, key);
      if (!session) {
        fail(res, 404, '找不到这个会话');
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const patch = sanitizeSessionPatch(body);
        if (Object.keys(patch).length === 0) {
          sendJson(res, 200, { ok: true, session, changed: false });
          return;
        }
        const updated = updateSession(deps.db, key, patch);
        if (!updated) {
          fail(res, 500, '会话保存失败');
          return;
        }
        log.info(`会话 ${key} 已更新：${Object.keys(patch).join('、')}`);
        sendJson(res, 200, { ok: true, session: updated, changed: true });
        return;
      }
      if (method === 'DELETE') {
        deleteSession(deps.db, key);
        log.info(`会话 ${key} 已删除`);
        sendJson(res, 200, { ok: true, deleted: key });
        return;
      }
      fail(res, 405, '这个接口只支持 POST / DELETE');
      return;
    }

    // ===== 记忆消息 =====
    if (pathname === '/api/messages' && method === 'GET') {
      const key = (url.searchParams.get('key') ?? '').trim();
      const keyword = (url.searchParams.get('kw') ?? '').trim();
      const limit = Math.round(clampNum(asNum(url.searchParams.get('limit')) ?? 30, 1, 500));
      if (!key) {
        fail(res, 400, '缺少 key 参数（要查哪个会话）');
        return;
      }
      const session = getSession(deps.db, key);
      if (!session) {
        fail(res, 404, '找不到这个会话');
        return;
      }
      const messages = keyword
        ? safe(() => searchHistory(deps.db, keyword, limit), [], `搜索历史「${keyword}」`)
        : safe(() => recentMessages(deps.db, session, limit), [], '读取最近记忆');
      sendJson(res, 200, { ok: true, key, keyword, limit, messages });
      return;
    }

    if (pathname === '/api/memory/clear' && method === 'POST') {
      const body = await readJson(req);
      const key = asStr(body.key)?.trim() ?? '';
      // 记忆互通的会话，实际存在 'shared' 桶里，得按实际键删
      let target = key;
      if (key) {
        const session = getSession(deps.db, key);
        if (session) target = effectiveKey(session);
      }
      let removed = 0;
      try {
        removed = target ? clearMemory(deps.db, target) : clearMemory(deps.db);
      } catch (err) {
        fail(res, 500, `清空记忆失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      log.info(key ? `已清空会话 ${key} 的记忆（${removed} 条）` : `已清空全部记忆（${removed} 条）`);
      sendJson(res, 200, { ok: true, key: key || null, removed });
      return;
    }

    // ===== 好感度 =====
    // ===== 不理名单 =====
    if (pathname === '/api/ignores' && method === 'GET') {
      const rows = listIgnores(deps.db);
      const nicks = nickMap(deps.db);
      const sessions = safe(() => listSessions(deps.db), [], '读取会话');
      const nameOf = new Map<string, string>();
      for (const s of sessions) nameOf.set(s.key, s.name || s.key);
      const list = rows.map((r) => ({
        ...r,
        nickname: nicks.get(r.qq) || '',
        avatar: avatarOf('private', r.qq),
        sessionName: nameOf.get(r.sessionKey) || r.sessionKey,
        remainText: r.forever ? '永久' : r.durationText,
        untilText: r.forever ? '不自动解除' : new Date(r.until).toLocaleString('zh-CN', { hour12: false }),
        times: r.times,
      }));
      sendJson(res, 200, { ok: true, ignores: list });
      return;
    }

    if (pathname === '/api/ignores' && method === 'POST') {
      const body = await readJson(req);
      const sessionKey = String(body.sessionKey ?? '').trim();
      const qq = String(body.qq ?? '').trim();
      const action = String(body.action ?? 'release').trim();
      if (!sessionKey || !/^\d{4,12}$/.test(qq)) {
        fail(res, 400, '会话或 QQ 号不对');
        return;
      }
      if (action === 'release') {
        releaseIgnore(deps.db, sessionKey, qq, '面板');
        log.info(`面板解除不理：${sessionKey} / ${qq}`);
        sendJson(res, 200, { ok: true, released: true });
        return;
      }
      fail(res, 400, '只支持解除');
      return;
    }

    if (pathname === '/api/favors' && method === 'GET') {
      const favors = safe(() => listFavors(deps.db, 200, deps.config.bot.masterIds), [], '读取好感度');
      const nicks = nickMap(deps.db);
      const decorated = favors.map((f) => ({
        ...f,
        nickname: nicks.get(String(f.qq)) || (f.isMaster ? '老大' : ''),
        avatar: avatarOf('private', String(f.qq)),
      }));
      sendJson(res, 200, { ok: true, favors: decorated });
      return;
    }

    if (pathname === '/api/favors' && method === 'POST') {
      const body = await readJson(req);
      const qq = String(body.qq ?? '').trim();
      const score = asNum(body.score);
      if (!/^\d{4,12}$/.test(qq)) {
        fail(res, 400, 'QQ 号不对，应该是 4-12 位数字');
        return;
      }
      if (score === null) {
        fail(res, 400, '分数必须是数字');
        return;
      }
      const value = Math.round(clampNum(score, -9999, 9999));
      try {
        setScore(deps.db, qq, value);
      } catch (err) {
        fail(res, 500, `改分失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      const isMaster = isMasterQq(qq, deps.config.bot.masterIds);
      const favor = safe(() => getFavor(deps.db, qq, isMaster), null, '读取好感度');
      log.info(`好感度手动调整：${qq} → ${value}`);
      sendJson(res, 200, { ok: true, qq, score: value, favor });
      return;
    }

    // ===== OneBot 群 / 好友 =====
    if (pathname === '/api/groups' && method === 'GET') {
      if (!safe(() => deps.client.isConnected(), false, '读取连接状态')) {
        // 没连上不算错，返回空数组 + 提示，前端好处理
        sendJson(res, 200, { ok: true, groups: [], note: 'OneBot 还没连上，先启动 SnowLuma 吧' });
        return;
      }
      let groups: unknown[] = [];
      try {
        groups = (await deps.client.getGroupList()) ?? [];
      } catch (err) {
        log.warn(`取群列表失败：${String((err as Error)?.message ?? err)}`);
        sendJson(res, 200, { ok: true, groups: [], note: '取群列表失败，稍后再试' });
        return;
      }
      sendJson(res, 200, { ok: true, groups });
      return;
    }

    if (pathname === '/api/friends' && method === 'GET') {
      if (!safe(() => deps.client.isConnected(), false, '读取连接状态')) {
        sendJson(res, 200, { ok: true, friends: [], note: 'OneBot 还没连上' });
        return;
      }
      let friends: unknown[] = [];
      try {
        friends = (await deps.client.getFriendList()) ?? [];
      } catch (err) {
        log.warn(`取好友列表失败：${String((err as Error)?.message ?? err)}`);
        sendJson(res, 200, { ok: true, friends: [], note: '取好友列表失败，稍后再试' });
        return;
      }
      sendJson(res, 200, { ok: true, friends });
      return;
    }

    // ===== 模型连通性 =====
    if (pathname === '/api/llm/test' && method === 'POST') {
      try {
        const result = await pingLLM(deps.config);
        log.info(`模型测试：${result.ok ? '通' : '不通'} ${result.ms}ms`);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          ms: 0,
          model: deps.config.llm.model,
          error: String((err as Error)?.message ?? err),
        });
      }
      return;
    }

    // ===== 拉取模型列表（中转站 /models） =====
    if (pathname === '/api/llm/models' && method === 'GET') {
      const cfg = deps.config.llm;
      const base = (url.searchParams.get('baseUrl') || cfg.baseUrl || '').replace(/\/+$/, '');
      const key = url.searchParams.get('apiKey') || cfg.apiKey || '';
      if (!base) { fail(res, 400, '还没有填接口地址'); return; }
      if (!key) { fail(res, 400, '还没有填 API Key，拉不到模型列表'); return; }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      try {
        const r = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: ctrl.signal,
        });
        const text = await r.text();
        let data: unknown = null;
        try { data = JSON.parse(text); } catch { data = null; }
        if (!r.ok) {
          fail(res, 502, `接口返回 HTTP ${r.status}：${text.slice(0, 120)}`);
          return;
        }
        const list = (data as { data?: Array<{ id?: string }> } | null)?.data ?? [];
        const models = list.map((m) => String(m?.id ?? '')).filter(Boolean).sort();
        log.info(`拉取模型列表：${models.length} 个`);
        sendJson(res, 200, { ok: true, models });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        fail(res, 502, msg.includes('abort') ? '拉取超时（25 秒），中转站可能有点慢，再试一次' : `拉取失败：${msg}`);
      } finally {
        clearTimeout(timer);
      }
      return;
    }

    // ===== 接口档案：把多份 API 存起来，用下拉框一键切换，不用每次重填 =====
    // 存一份新档案。Key 留空或传打码值 = 沿用当前主接口的 Key
    if (pathname === '/api/llm/profiles' && method === 'POST') {
      const body = await readJson(req);
      const baseUrl = (asStr(body.baseUrl) ?? '').trim();
      const model = (asStr(body.model) ?? '').trim();
      const nameIn = (asStr(body.name) ?? '').trim();
      const keyIn = (asStr(body.apiKey) ?? '').trim();
      if (!baseUrl) { fail(res, 400, '先填接口地址再存档案'); return; }
      if (!model) { fail(res, 400, '先填模型名再存档案'); return; }
      const apiKey = isKeepKey(keyIn) ? deps.config.llm.apiKey : keyIn;
      if (!apiKey) { fail(res, 400, '还没有 API Key，填一个再存'); return; }

      const profile: LLMProfile = {
        id: newProfileId(),
        name: uniqueProfileName(deps.config, nameIn || model),
        baseUrl,
        model,
        apiKey,
      };
      deps.config.llm.profiles = [...(deps.config.llm.profiles ?? []), profile];
      try {
        deps.saveConfig();
      } catch (err) {
        fail(res, 500, `配置写回失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      log.info(`接口档案已保存：${profile.name}（${profile.model}）`);
      sendJson(res, 200, {
        ok: true,
        note: `已存为「${profile.name}」`,
        config: maskedConfig(deps.config),
      });
      return;
    }

    // 切换到某份档案：填回主接口三项，改完立刻生效（不用重启）
    if (pathname === '/api/llm/profiles/apply' && method === 'POST') {
      const body = await readJson(req);
      const id = (asStr(body.id) ?? '').trim();
      const p = (deps.config.llm.profiles ?? []).find((x) => x.id === id);
      if (!p) { fail(res, 404, '找不到这份档案，可能已经被删掉了'); return; }

      deps.config.llm.baseUrl = p.baseUrl;
      deps.config.llm.model = p.model;
      deps.config.llm.apiKey = p.apiKey;
      try {
        deps.saveConfig();
      } catch (err) {
        fail(res, 500, `配置写回失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      log.info(`已切换到接口档案：${p.name}（${p.model}）`);
      sendJson(res, 200, {
        ok: true,
        note: `已切换到「${p.name}」，马上生效`,
        config: maskedConfig(deps.config),
      });
      return;
    }

    // 删除某份档案（只删存档，不动当前正在用的配置）
    if (pathname === '/api/llm/profiles/delete' && method === 'POST') {
      const body = await readJson(req);
      const id = (asStr(body.id) ?? '').trim();
      const list = deps.config.llm.profiles ?? [];
      const p = list.find((x) => x.id === id);
      if (!p) { fail(res, 404, '找不到这份档案，可能已经删过了'); return; }

      deps.config.llm.profiles = list.filter((x) => x.id !== id);
      try {
        deps.saveConfig();
      } catch (err) {
        fail(res, 500, `配置写回失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      log.info(`接口档案已删除：${p.name}`);
      sendJson(res, 200, { ok: true, note: `已删除「${p.name}」`, config: maskedConfig(deps.config) });
      return;
    }

    // ===== 日志 =====
    if (pathname === '/api/logs' && method === 'GET') {
      const limit = Math.round(clampNum(asNum(url.searchParams.get('limit')) ?? 200, 10, 1000));
      // 前端带 tailOff（上次读到的位置附近），实现「只看新增」，日志再大也不卡
      const tailOffset = Math.max(0, Math.round(asNum(url.searchParams.get('tailOff')) ?? 0));
      const file = findLogFile(deps);
      if (!file) {
        sendJson(res, 200, { ok: true, lines: [], fileSize: 0, file: null, note: '还没有日志文件，机器人跑起来后就有了' });
        return;
      }
      const tail = readLogTail(file, limit, tailOffset);
      sendJson(res, 200, {
        ok: true,
        lines: tail.lines,
        fileSize: tail.fileSize,
        nextOffset: tail.nextOffset,
        file: file.replace(process.cwd(), '.'),
      });
      return;
    }

    // ===== 全局回复开关 =====
    if (pathname === '/api/reply/toggle' && method === 'POST') {
      deps.config.bot.globalAutoReply = !deps.config.bot.globalAutoReply;
      try {
        deps.saveConfig();
      } catch (err) {
        fail(res, 500, `保存失败：${String((err as Error)?.message ?? err)}`);
        return;
      }
      try {
        deps.onConfigChange?.();
      } catch (err) {
        log.warn(`配置变更回调出错：${String((err as Error)?.message ?? err)}`);
      }
      log.info(`全局回复已${deps.config.bot.globalAutoReply ? '开启' : '关闭'}`);
      sendJson(res, 200, { ok: true, globalAutoReply: deps.config.bot.globalAutoReply });
      return;
    }

    fail(res, 404, '没有这个接口');
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      const msg = String((err as Error)?.message ?? err);
      log.error(`处理 ${req.method} ${req.url} 失败：${msg}`);
      if (!res.headersSent) {
        const code = msg.includes('JSON') || msg.includes('太大') ? 400 : 500;
        fail(res, code, msg.includes('JSON') || msg.includes('太大') ? msg : '面板内部错误');
      } else {
        try { res.end(); } catch { /* 忽略 */ }
      }
    });
  });

  const host = deps.config.panel.host || '127.0.0.1';
  const wantedPort = deps.config.panel.port;

  await new Promise<void>((ok, no) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      no(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      ok();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(wantedPort, host);
  }).catch((err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      throw new Error(`面板端口 ${wantedPort} 被占用了，关掉占用的程序或改 config.json 里的 panel.port`);
    }
    if (e.code === 'EACCES') {
      throw new Error(`没有权限监听 ${host}:${wantedPort}`);
    }
    throw err;
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : wantedPort;

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    log.warn(`面板监听在 ${host}，同网络的人都能访问，注意别把 Key 泄露出去`);
  }
  log.info(`网页面板已启动：http://${host}:${port}/ （页面目录 ${WEB_ROOT}）`);

  const close = (): Promise<void> => new Promise<void>((ok) => {
    server.closeAllConnections?.();
    server.close(() => ok());
  });

  return { port, close };
}
