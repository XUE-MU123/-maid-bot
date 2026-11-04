// 配置加载 + 自愈：文件缺失/0 字节/JSON 损坏时，自动用默认值重建并保留坏文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { BotConfig, Config, MasterRole, MasterRoles } from './types.ts';

/** Normalize and validate a complete identity configuration before assigning any permissions. */
export function normalizeMasterRoles(raw: unknown): MasterRoles {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('老大身份配置必须是对象');
  const value = raw as Record<string, unknown>;
  if (typeof value.primaryId !== 'string' || typeof value.secondaryId !== 'string'
    || typeof value.dualEnabled !== 'boolean') throw new Error('老大身份配置需要 primaryId、secondaryId 和 dualEnabled');
  const roles: MasterRoles = {
    primaryId: value.primaryId.trim(), secondaryId: value.secondaryId.trim(), dualEnabled: value.dualEnabled,
  };
  for (const [name, id] of [['第一老大', roles.primaryId], ['二老大', roles.secondaryId]]) {
    if (id && !/^\d{5,15}$/.test(id)) throw new Error(`${name} QQ 号必须是 5-15 位数字`);
  }
  if (roles.secondaryId && !roles.primaryId) throw new Error('请先填写第一老大，再填写二老大');
  if (roles.primaryId && roles.primaryId === roles.secondaryId) throw new Error('第一老大和二老大不能使用相同 QQ 号');
  return roles;
}

/** Same validating/throwing contract for callers that explicitly request validation. */
export const validateMasterRoles = normalizeMasterRoles;

type MasterBot = Partial<BotConfig>;
export type MasterSource = MasterBot | readonly string[];

/** The legacy masterIds cache never grants authority, including when the new field is absent. */
export function getMasterIds(bot: MasterBot | null | undefined): string[] {
  if (!bot?.masterRoles) return [];
  try {
    const roles = normalizeMasterRoles(bot.masterRoles);
    if (!roles.primaryId) return [];
    return roles.dualEnabled && roles.secondaryId ? [roles.primaryId, roles.secondaryId] : [roles.primaryId];
  } catch {
    return []; // A corrupted runtime identity configuration must fail closed.
  }
}

/** Array compatibility is for memory/favor helpers and isolated tests only. */
export function masterRole(qq: string | null | undefined, source: MasterSource = []): MasterRole {
  const id = String(qq ?? '').trim();
  if (!id) return 'none';
  const ids = Array.isArray(source) ? source : getMasterIds(source as MasterBot);
  const index = ids.indexOf(id);
  return index === 0 ? 'primary' : index === 1 ? 'secondary' : 'none';
}

export function isMasterQq(qq: string | null | undefined, source: MasterSource = []): boolean {
  return masterRole(qq, source) !== 'none';
}

export const DEFAULT_CONFIG: Config = {
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001/',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    reconnectMs: 3000,
  },
  llm: {
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    model: 'your-model',
    profiles: [],
    fallback: { baseUrl: '', apiKey: '', model: '' },
    temperature: 0.8,
    maxTokens: 2000,
    timeoutMs: 120000,
    mock: true,
  },
  vision: {
    enabled: true,
    model: 'your-vision-model',
    baseUrl: '',
    apiKey: '',
    timeoutMs: 90000,
    maxChars: 240,
  },
  render: {
    enabled: true,
    tables: true,
    svg: true,
    mermaid: false,
    maxImages: 3,
    timeoutMs: 12000,
    tablePreset: 'yuzu-deep',
  },
  bot: {
    selfIds: [],
    masterRoles: { primaryId: '', secondaryId: '', dualEnabled: false },
    masterIds: [],
    globalAutoReply: true,
    splitReply: true,
    maxSegmentChars: 500,
    sendIntervalMs: 600,
    historyLimit: 200, // 上下文条数上限，真正能塞多少由 maxContextTokens 预算决定
    maxContextTokens: 12000,
    cooldownMs: 1200,
    triggerCooldownMs: 15000,
    dedupeWindowMs: 60000,
    autoFavor: true,
    dailyGainCap: 30, // 每人每天最多涨 30 分，扣分不受限
    triggerKeywords: ['助手'],
  },
  persona: {
    systemPrompt: [
      '你是友好、可靠的聊天助手。',
      '表达自然简洁，尊重不同成员；不确定时明确说明。',
      '群聊里不抢话，不说教；根据上下文提供有帮助的回复。',
    ].join('\n'),
    groupProactive: '群里安静了一会儿，你想主动接一句话，轻松自然，别太打扰。',
    privateProactive: '有一阵子没说话了，你想主动问候对方，语气友好自然。',
    favorHint: true,
  },
  defaults: { atProb: 1.0, keywordProb: 0.6, randomProb: 0.05 },
  panel: { host: '127.0.0.1', port: 3210 },
  logging: { level: 'info', keepDays: 14 },
  storage: { dataDir: './data' },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : (patch as T));
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface LoadResult {
  config: Config;
  healed: string[];
  configPath: string;
}

export function loadConfig(dataDir: string): LoadResult {
  const healed: string[] = [];
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');

  // 首次启动：从模板复制一份，方便老大直接改
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    return { config: structuredClone(DEFAULT_CONFIG), healed: ['created config.json'], configPath };
  }

  // 0 字节 / 极小文件 → 自愈
  let size = 0;
  try { size = statSync(configPath).size; } catch { size = 0; }
  if (size < 3) {
    const bad = `${configPath}.bad-${Date.now()}`;
    try { copyFileSync(configPath, bad); } catch { /* 忽略 */ }
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    healed.push('config.json 空文件已重建');
    return { config: structuredClone(DEFAULT_CONFIG), healed, configPath };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    const bad = `${configPath}.bad-${Date.now()}`;
    try { copyFileSync(configPath, bad); } catch { /* 忽略 */ }
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    healed.push(`config.json 解析失败，已备份为 ${bad}`);
    return { config: structuredClone(DEFAULT_CONFIG), healed, configPath };
  }

  const config = deepMerge(DEFAULT_CONFIG, raw);
  const rawBot = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).bot : undefined;
  const hasRoles = !!rawBot && typeof rawBot === 'object' && !Array.isArray(rawBot)
    && Object.prototype.hasOwnProperty.call(rawBot, 'masterRoles');
  if (!hasRoles) {
    // Deliberately do not copy historical IDs: migration starts with empty identity slots.
    config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: false };
    healed.push('旧版老大身份已迁移为空槽位，请在设置中重新配置');
  } else {
    try { config.bot.masterRoles = normalizeMasterRoles((rawBot as Record<string, unknown>).masterRoles); }
    catch (err) {
      config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: false };
      healed.push(`老大身份配置无效，已安全清空：${String((err as Error).message)}`);
    }
  }
  config.bot.masterIds = getMasterIds(config.bot);
  // 缺字段就补写回去，让老大在文件里能看见全部可调项
  const merged = JSON.stringify(config, null, 2);
  try {
    if (merged !== JSON.stringify(raw, null, 2)) {
      const bad = `${configPath}.bak-${Date.now()}`;
      copyFileSync(configPath, bad);
      writeFileSync(configPath, merged, 'utf8');
      healed.push('config.json 缺省字段已补全');
    }
  } catch { /* 忽略 */ }

  // 环境变量覆盖，方便临时改而不动文件
  const env = process.env;
  if (env.MAID_ONEBOT_TOKEN) config.onebot.accessToken = env.MAID_ONEBOT_TOKEN;
  if (env.MAID_LLM_KEY) config.llm.apiKey = env.MAID_LLM_KEY;
  if (env.MAID_LLM_BASE) config.llm.baseUrl = env.MAID_LLM_BASE;
  if (env.MAID_LLM_MODEL) config.llm.model = env.MAID_LLM_MODEL;
  if (env.MAID_PANEL_PORT) config.panel.port = Number(env.MAID_PANEL_PORT) || config.panel.port;

  ensureDir(dirname(configPath));
  return { config, healed, configPath };
}

export function saveConfig(config: Config, configPath: string): void {
  config.bot.masterRoles = normalizeMasterRoles(config.bot.masterRoles);
  config.bot.masterIds = getMasterIds(config.bot);
  try { writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8'); }
  catch { /* 忽略：配置写失败不该拖垮机器人 */ }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
