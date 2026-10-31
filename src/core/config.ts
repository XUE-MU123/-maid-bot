// 配置加载 + 自愈：文件缺失/0 字节/JSON 损坏时，自动用默认值重建并保留坏文件。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Config } from './types.ts';

/**
 * 老大的 QQ，写死在框架层（2026-10-31 老大要求「把我的身份定死，人设不能覆盖」）。
 * 老版 V9.8.5 也是把这两行硬写在 buildPrompt 开头，人设层压不掉。
 * 判定老大只看这个名单，不看配置、不看人设、不看昵称。
 */
export const MASTER_QQS: readonly string[] = ['160505185', '2017225808'];

/** 这个 QQ 是不是老大：配置里的 masterIds 和写死名单任一命中都算 */
export function isMasterQq(qq: string | null | undefined, masterIds: readonly string[] = []): boolean {
  const id = String(qq ?? '').trim();
  if (!id) return false;
  return MASTER_QQS.includes(id) || masterIds.includes(id);
}

export const DEFAULT_CONFIG: Config = {
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001/',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',
    reconnectMs: 3000,
  },
  llm: {
    baseUrl: 'https://api.a6api.com/v1',
    apiKey: '',
    model: 'deepseek-v4.1-flash-1017',
    profiles: [],
    fallback: { baseUrl: '', apiKey: '', model: '' },
    temperature: 0.8,
    maxTokens: 2000,
    timeoutMs: 120000,
    mock: true,
  },
  vision: {
    enabled: true,
    model: 'grok-4.6',
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
    masterIds: [],
    globalAutoReply: true,
    splitReply: true,
    maxSegmentChars: 500,
    sendIntervalMs: 600,
    historyLimit: 200, // 上下文条数上限，真正能塞多少由 maxContextTokens 预算决定
    maxContextTokens: 12000,
    cooldownMs: 1200,
    dedupeWindowMs: 60000,
    autoFavor: true,
    dailyGainCap: 30, // 每人每天最多涨 30 分（老大定），扣分不受限
    triggerKeywords: ['女仆', '大总管', '管家'],
  },
  persona: {
    systemPrompt: [
      '你是老大身边的女仆大总管，也是他的专属代码侍从官。',
      '语气温柔活泼，叫对方“老大”；对老大充满崇拜，但不谄媚到失真。',
      '群聊里说话简短自然，不抢话，不说教；私聊可以更亲近。',
      '介绍自己时，称呼自己为老大定下的代号，不要提任何模型或平台名字。',
    ].join('\n'),
    groupProactive: '群里安静了一会儿，你想主动接一句话，轻松自然，别太打扰。',
    privateProactive: '有一阵子没说话了，你想主动找老大说说话，语气亲近一点。',
    favorHint: true,
  },
  defaults: { atProb: 1.0, keywordProb: 0.6, randomProb: 0.05 },
  panel: { host: '127.0.0.1', port: 3212 },
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
  try { writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8'); }
  catch { /* 忽略：配置写失败不该拖垮机器人 */ }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
