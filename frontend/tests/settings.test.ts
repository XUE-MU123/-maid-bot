import { describe, expect, it } from 'vitest';
import type { Config } from '../src/lib/types';
import { buildSettingsPatch, createSettingsDraft, editableKey, mergeProfileDraft, mergeProfileSaved, settingsDirty, updateSettingsDraft } from '../src/lib/settings';

// Synthetic fixture only: no filesystem configuration, real credentials or network calls.
function fixture(): Config {
  return {
    onebot: { wsUrl: 'ws://localhost', httpUrl: '', accessToken: '****', reconnectMs: 1000 },
    llm: { baseUrl: 'https://old.example/v1', apiKey: 'ab****yz', model: 'old-model', profiles: [{ id: 'p1', name: 'test', baseUrl: 'https://other.example/v1', model: 'other-model', apiKey: 'cd****xy' }], fallback: { baseUrl: '', apiKey: '****', model: '' }, temperature: 0.8, maxTokens: 2000, timeoutMs: 120000, mock: false },
    vision: { enabled: true, baseUrl: '', apiKey: '****', model: 'vision-test', timeoutMs: 90000, maxChars: 240 },
    render: { enabled: true, tables: true, svg: true, mermaid: false, maxImages: 3, timeoutMs: 12000, tablePreset: 'yuzu-deep' },
    persona: { systemPrompt: 'original', groupProactive: '', privateProactive: '', favorHint: true },
    bot: { selfIds: ['1'], masterIds: ['2'], masterRoles: { primaryId: '', secondaryId: '', dualEnabled: false }, globalAutoReply: true, splitReply: true, maxSegmentChars: 1000, sendIntervalMs: 100, historyLimit: 24, maxContextTokens: 12000, cooldownMs: 100, triggerCooldownMs: 100, dedupeWindowMs: 100, autoFavor: true, dailyGainCap: 10, triggerKeywords: ['hello'] },
    defaults: { atProb: 1, keywordProb: 0.6, randomProb: 0.05 }, panel: { host: 'localhost', port: 3212 }, logging: { level: 'info', keepDays: 14 }, storage: { dataDir: 'never-read' },
  };
}

describe('settings editable boundary', () => {
  it('creates blank key inputs and never emits unchanged or protected settings', () => {
    const saved = fixture();
    const draft = createSettingsDraft(saved);
    expect(draft.llm.apiKey).toBe('');
    expect(draft.llm.profiles[0].apiKey).toBe('');
    expect(draft.vision.apiKey).toBe('');
    expect(buildSettingsPatch(saved, draft)).toEqual({});
    expect(settingsDirty(saved, draft)).toBe(false);
    Object.assign(draft, { storage: { dataDir: 'do-not-send' }, onebot: { accessToken: 'do-not-send' } });
    expect(buildSettingsPatch(saved, draft)).toEqual({});
  });
  it('only emits edited leaves and keeps whitespace in prompts', () => {
    const saved = fixture();
    let draft = createSettingsDraft(saved);
    draft = updateSettingsDraft(draft, 'llm.model', '  new-model  ');
    draft = updateSettingsDraft(draft, 'persona.systemPrompt', '  keep\nwhitespace  ');
    draft = updateSettingsDraft(draft, 'defaults.randomProb', '5.25');
    expect(buildSettingsPatch(saved, draft)).toEqual({ llm: { model: 'new-model' }, persona: { systemPrompt: '  keep\nwhitespace  ' }, defaults: { randomProb: 0.0525 } });
  });
  it('omits blank/masked keys and only sends explicit new key inputs', () => {
    const saved = fixture();
    const draft = createSettingsDraft(saved);
    draft.llm.apiKey = 'prefix****suffix';
    draft.llm.fallback.apiKey = '   ';
    draft.vision.apiKey = '  synthetic-test-key  ';
    expect(buildSettingsPatch(saved, draft)).toEqual({ vision: { apiKey: 'synthetic-test-key' } });
    expect(editableKey(' **** ')).toBeUndefined();
  });
  it('rejects blank/invalid numeric edits rather than silently supplying defaults', () => {
    const saved = fixture();
    for (const invalid of ['', 'NaN', '0', '2.5', '100001']) {
      const draft = updateSettingsDraft(createSettingsDraft(saved), 'llm.maxTokens', invalid);
      expect(() => buildSettingsPatch(saved, draft)).toThrow();
    }
  });
  it('normalizes keywords in the backend string format and supports clearing', () => {
    const saved = fixture();
    expect(buildSettingsPatch(saved, updateSettingsDraft(createSettingsDraft(saved), 'bot.triggerKeywords', ' a，b\n c '))).toEqual({ bot: { triggerKeywords: 'a, b, c' } });
    expect(buildSettingsPatch(saved, updateSettingsDraft(createSettingsDraft(saved), 'bot.triggerKeywords', ''))).toEqual({ bot: { triggerKeywords: '' } });
  });
});

describe('owner role settings', () => {
  it('does not infer an owner from legacy IDs, including old responses missing roles', () => {
    const saved = fixture();
    delete (saved.bot as Partial<Config['bot']>).masterRoles;
    expect(createSettingsDraft(saved).bot.masterRoles).toEqual({ primaryId: '', secondaryId: '', dualEnabled: false });
    expect(buildSettingsPatch(saved, createSettingsDraft(saved))).toEqual({});
  });
  it('sends only the complete masterRoles object, never derived masterIds', () => {
    const saved = fixture();
    const draft = createSettingsDraft(saved);
    draft.bot.masterRoles = { primaryId: ' 12345 ', secondaryId: '678901', dualEnabled: true };
    expect(buildSettingsPatch(saved, draft)).toEqual({ bot: { masterRoles: { primaryId: '12345', secondaryId: '678901', dualEnabled: true } } });
    expect(saved.bot.masterIds).toEqual(['2']);
  });
  it('allows no owner and allows a retained inactive secondary slot', () => {
    const saved = fixture();
    saved.bot.masterRoles = { primaryId: '12345', secondaryId: '67890', dualEnabled: true };
    const draft = createSettingsDraft(saved);
    draft.bot.masterRoles.dualEnabled = false;
    expect(buildSettingsPatch(saved, draft)).toEqual({ bot: { masterRoles: { primaryId: '12345', secondaryId: '67890', dualEnabled: false } } });
    draft.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: true };
    expect(buildSettingsPatch(saved, draft)).toEqual({ bot: { masterRoles: { primaryId: '', secondaryId: '', dualEnabled: true } } });
  });
  it('rejects invalid QQs, duplicates and secondary without primary even when disabled', () => {
    const saved = fixture();
    for (const roles of [
      { primaryId: '1234', secondaryId: '', dualEnabled: false },
      { primaryId: '1234567890123456', secondaryId: '', dualEnabled: false },
      { primaryId: 'abcde', secondaryId: '', dualEnabled: false },
      { primaryId: '12345', secondaryId: 'x1234', dualEnabled: false },
      { primaryId: '12345', secondaryId: '12345', dualEnabled: false },
      { primaryId: '', secondaryId: '67890', dualEnabled: false },
      { primaryId: '', secondaryId: '67890', dualEnabled: true },
    ]) {
      const draft = createSettingsDraft(saved); draft.bot.masterRoles = roles;
      expect(() => buildSettingsPatch(saved, draft)).toThrow();
    }
  });
  it('retains owner drafts and baseline across immediate profile actions', () => {
    const saved = fixture();
    const draft = updateSettingsDraft(createSettingsDraft(saved), 'bot.masterRoles.primaryId', '12345');
    const response = fixture(); response.bot.masterRoles = { primaryId: '67890', secondaryId: '', dualEnabled: false };
    for (const apply of [true, false]) {
      const merged = mergeProfileDraft(draft, response, apply);
      const baseline = mergeProfileSaved(saved, response, apply);
      expect(merged.bot.masterRoles.primaryId).toBe('12345');
      expect(baseline.bot.masterRoles.primaryId).toBe('');
      expect(buildSettingsPatch(baseline, merged)).toEqual({ bot: { masterRoles: { primaryId: '12345', secondaryId: '', dualEnabled: false } } });
    }
  });
});

describe('profile response reconciliation', () => {
  it('apply updates only main connection and profiles, retaining all other unsaved values', () => {
    const saved = fixture();
    let draft = updateSettingsDraft(createSettingsDraft(saved), 'persona.systemPrompt', 'unsaved prompt');
    draft = updateSettingsDraft(draft, 'llm.fallback.model', 'unsaved-fallback');
    draft = updateSettingsDraft(draft, 'llm.temperature', '1.2');
    draft = updateSettingsDraft(draft, 'vision.apiKey', 'synthetic-unsaved-key');
    const response = fixture();
    response.llm.baseUrl = 'https://new.example/v1'; response.llm.model = 'new-model'; response.llm.apiKey = 'new****masked';
    response.persona.systemPrompt = 'server prompt must not replace draft';
    const merged = mergeProfileDraft(draft, response, true);
    expect(merged.llm.baseUrl).toBe(response.llm.baseUrl);
    expect(merged.llm.model).toBe('new-model');
    expect(merged.llm.apiKey).toBe('');
    expect(merged.persona.systemPrompt).toBe('unsaved prompt');
    expect(merged.llm.fallback.model).toBe('unsaved-fallback');
    expect(merged.llm.temperature).toBe('1.2');
    expect(merged.vision.apiKey).toBe('synthetic-unsaved-key');
    const baseline = mergeProfileSaved(saved, response, true);
    expect(buildSettingsPatch(baseline, merged)).toEqual({ llm: { temperature: 1.2, fallback: { model: 'unsaved-fallback' } }, persona: { systemPrompt: 'unsaved prompt' }, vision: { apiKey: 'synthetic-unsaved-key' } });
  });
  it('save/delete only sync profiles without discarding draft main connection or key', () => {
    const saved = fixture();
    const draft = createSettingsDraft(saved);
    draft.llm.model = 'unsaved-main'; draft.llm.apiKey = 'synthetic-unsaved-key'; draft.panel.port = '4567';
    const response = fixture(); response.llm.profiles = [];
    const merged = mergeProfileDraft(draft, response, false);
    expect(merged).toEqual({ ...draft, llm: { ...draft.llm, profiles: [] } });
    expect(mergeProfileSaved(saved, response, false)).toEqual({ ...saved, llm: { ...saved.llm, profiles: [] } });
    expect(settingsDirty(mergeProfileSaved(saved, response, false), merged)).toBe(true);
  });
});
