import type { Config } from './types';

/** The editable boundary deliberately excludes transports, storage, profile keys and bot internals. */
export function createSettingsDraft(config: Config) {
  return {
    llm: {
      baseUrl: config.llm.baseUrl, model: config.llm.model, apiKey: '',
      profiles: config.llm.profiles.map(profile => ({ ...profile, apiKey: '' })),
      temperature: String(config.llm.temperature), maxTokens: String(config.llm.maxTokens),
      timeoutMs: String(config.llm.timeoutMs), mock: config.llm.mock,
      fallback: { baseUrl: config.llm.fallback.baseUrl, model: config.llm.fallback.model, apiKey: '' },
    },
    vision: { enabled: config.vision.enabled, baseUrl: config.vision.baseUrl, model: config.vision.model, apiKey: '', timeoutMs: String(config.vision.timeoutMs), maxChars: String(config.vision.maxChars) },
    render: { ...config.render, maxImages: String(config.render.maxImages), timeoutMs: String(config.render.timeoutMs) },
    persona: { ...config.persona },
    bot: { globalAutoReply: config.bot.globalAutoReply, splitReply: config.bot.splitReply, triggerKeywords: config.bot.triggerKeywords.join(', '), historyLimit: String(config.bot.historyLimit), maxContextTokens: String(config.bot.maxContextTokens), masterRoles: { primaryId: config.bot.masterRoles?.primaryId ?? '', secondaryId: config.bot.masterRoles?.secondaryId ?? '', dualEnabled: config.bot.masterRoles?.dualEnabled ?? false } },
    defaults: { atProb: String(config.defaults.atProb * 100), keywordProb: String(config.defaults.keywordProb * 100), randomProb: String(config.defaults.randomProb * 100) },
    logging: { level: config.logging.level, keepDays: String(config.logging.keepDays) },
    panel: { port: String(config.panel.port) },
  };
}
export type SettingsDraft = ReturnType<typeof createSettingsDraft>;

const numericFields = {
  'llm.temperature': [0, 2, false], 'llm.maxTokens': [1, 100000, true], 'llm.timeoutMs': [1000, 600000, true],
  'vision.timeoutMs': [5000, 300000, true], 'vision.maxChars': [40, 1000, true],
  'render.maxImages': [0, 3, true], 'render.timeoutMs': [3000, 60000, true],
  'bot.historyLimit': [1, 200, true], 'bot.maxContextTokens': [500, 200000, true],
  'defaults.atProb': [0, 100, false], 'defaults.keywordProb': [0, 100, false], 'defaults.randomProb': [0, 100, false],
  'logging.keepDays': [1, 90, true], 'panel.port': [1, 65535, true],
} as const;
const textFields = ['llm.baseUrl', 'llm.model', 'llm.fallback.baseUrl', 'llm.fallback.model', 'vision.baseUrl', 'vision.model', 'render.tablePreset', 'logging.level', 'persona.systemPrompt', 'persona.groupProactive', 'persona.privateProactive', 'bot.triggerKeywords'] as const;
const booleanFields = ['llm.mock', 'vision.enabled', 'render.enabled', 'render.tables', 'render.svg', 'render.mermaid', 'persona.favorHint', 'bot.globalAutoReply', 'bot.splitReply'] as const;
const secretFields = ['llm.apiKey', 'llm.fallback.apiKey', 'vision.apiKey'] as const;
export type SettingsPath = keyof typeof numericFields | typeof textFields[number] | typeof booleanFields[number] | typeof secretFields[number] | 'bot.masterRoles.primaryId' | 'bot.masterRoles.secondaryId' | 'bot.masterRoles.dualEnabled';
type Patch = Record<string, unknown>;
function getPath(object: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], object);
}
function setPath(object: Patch, path: string, value: unknown) {
  const parts = path.split('.');
  const leaf = parts.pop()!;
  const parent = parts.reduce<Patch>((value, key) => (value[key] ??= {}) as Patch, object);
  parent[leaf] = value;
}
export function updateSettingsDraft(draft: SettingsDraft, path: SettingsPath, value: string | boolean): SettingsDraft {
  const next = structuredClone(draft);
  setPath(next, path, value);
  return next;
}
export function settingsDirty(saved: Config, draft: SettingsDraft): boolean {
  return JSON.stringify(createSettingsDraft(saved)) !== JSON.stringify(draft);
}
/** Never forwards a masked credential, even if someone pastes one into a password field. */
export function editableKey(value: string): string | undefined {
  const key = value.trim();
  return key && !key.includes('****') ? key : undefined;
}

export class MasterRolesValidationError extends Error {}

/** Validate both slots, including a retained but inactive second account. */
export function validateMasterRoles(roles: SettingsDraft['bot']['masterRoles']) {
  const primaryId = roles.primaryId.trim();
  const secondaryId = roles.secondaryId.trim();
  if (primaryId && !/^\d{5,15}$/.test(primaryId)) throw new MasterRolesValidationError('第一老大 QQ 请填写 5–15 位数字');
  if (secondaryId && !/^\d{5,15}$/.test(secondaryId)) throw new MasterRolesValidationError('二老大 QQ 请填写 5–15 位数字；关闭开关后仍会保留并校验此账号');
  if (secondaryId && !primaryId) throw new MasterRolesValidationError('请先填写第一老大 QQ；若要设为无老大，请同时清空二老大 QQ');
  if (primaryId && primaryId === secondaryId) throw new MasterRolesValidationError('第一老大与二老大不能使用同一个 QQ');
  return { primaryId, secondaryId, dualEnabled: roles.dualEnabled };
}

/** Only changed, whitelisted leaves are sent. Blank numbers are errors, never implicit defaults. */
export function buildSettingsPatch(saved: Config, draft: SettingsDraft): Patch {
  const patch: Patch = {};
  const initial = createSettingsDraft(saved);
  const masterRoles = validateMasterRoles(draft.bot.masterRoles);
  if (JSON.stringify(masterRoles) !== JSON.stringify(initial.bot.masterRoles)) setPath(patch, 'bot.masterRoles', masterRoles);
  const changed = (path: string) => getPath(initial, path) !== getPath(draft, path);
  for (const [path, [min, max, integer]] of Object.entries(numericFields)) {
    if (!changed(path)) continue;
    const raw = String(getPath(draft, path)).trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      throw new Error(`${path} 请填写 ${min}–${max} 之间的${integer ? '整数' : '数字'}`);
    }
    const normalized = path.startsWith('defaults.') ? value / 100 : value;
    if (normalized !== getPath(saved, path)) setPath(patch, path, normalized);
  }
  for (const path of textFields) {
    if (!changed(path)) continue;
    const raw = String(getPath(draft, path));
    const value = path.startsWith('persona.') ? raw : raw.trim();
    if (['llm.baseUrl', 'llm.model', 'vision.model'].includes(path) && !value) throw new Error(`${path} 不能为空`);
    if (path === 'bot.triggerKeywords') {
      const keywords = value.split(/[,，\s]+/).filter(Boolean).slice(0, 50);
      if (JSON.stringify(keywords) !== JSON.stringify(saved.bot.triggerKeywords)) setPath(patch, path, keywords.join(', '));
    } else if (value !== getPath(saved, path)) {
      setPath(patch, path, value);
    }
  }
  for (const path of booleanFields) if (changed(path)) setPath(patch, path, getPath(draft, path));
  for (const path of secretFields) {
    const key = editableKey(String(getPath(draft, path)));
    if (key) setPath(patch, path, key);
  }
  return patch;
}

/** Profile responses must not discard unrelated unsaved form values. */
export function mergeProfileDraft(draft: SettingsDraft, response: Config, apply: boolean): SettingsDraft {
  return { ...draft, llm: { ...draft.llm, profiles: createSettingsDraft(response).llm.profiles,
    ...(apply ? { baseUrl: response.llm.baseUrl, model: response.llm.model, apiKey: '' } : {}),
  } };
}
export function mergeProfileSaved(saved: Config, response: Config, apply: boolean): Config {
  return { ...saved, llm: { ...saved.llm, profiles: response.llm.profiles,
    ...(apply ? { baseUrl: response.llm.baseUrl, model: response.llm.model, apiKey: response.llm.apiKey } : {}),
  } };
}
