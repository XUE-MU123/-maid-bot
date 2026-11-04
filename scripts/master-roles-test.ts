// Isolated identity and permission regressions. No production config, DB, QQ, or LLM access.
// Run: node scripts/master-roles-test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DEFAULT_CONFIG, getMasterIds, isMasterQq, loadConfig, masterRole, normalizeMasterRoles, saveConfig } from '../src/core/config.ts';
import { openDb } from '../src/core/db.ts';
import type { NormalizedMessage } from '../src/core/types.ts';
import type { ToolContext } from '../src/modules/context.ts';
import type { OneBotClient } from '../src/onebot/client.ts';
import { Pipeline } from '../src/modules/pipeline.ts';
import { appendMessage } from '../src/modules/memory.ts';
import { ensureSession } from '../src/modules/session.ts';
import { applyFavorDelta, hasAdmin, protectedTarget, runTool, toolDefsFor } from '../src/modules/tools.ts';
import { executeTagActions } from '../src/modules/tags.ts';
import { startPanel } from '../src/server/panel.ts';

const root = mkdtempSync(join(tmpdir(), 'maid-master-roles-'));
const config = structuredClone(DEFAULT_CONFIG);
const primary = '111111', secondary = '222222', ordinary = '333333';
const roles = { primaryId: primary, secondaryId: secondary, dualEnabled: true };
let count = 0;
function check(label: string, fn: () => void): void { fn(); count++; console.log(`PASS ${label}`); }
const db = openDb(root);
let panel: Awaited<ReturnType<typeof startPanel>> | undefined;
try {
  check('blank defaults and synthetic legacy IDs have no authority', () => {
    assert.deepEqual(getMasterIds(config.bot), []);
    for (const id of ['750001', '750002']) assert.equal(isMasterQq(id, config.bot), false);
    assert.deepEqual(getMasterIds({ masterIds: [primary] }), []);
    config.bot.masterIds = [primary];
    assert.equal(masterRole(primary, config.bot), 'none');
    assert.equal(masterRole(primary, [primary]), 'primary');
    assert.equal(isMasterQq('7', ['7']), true);
  });
  check('normalization and validation', () => {
    assert.deepEqual(normalizeMasterRoles({ primaryId: ' 111111 ', secondaryId: '', dualEnabled: false }), { primaryId: primary, secondaryId: '', dualEnabled: false });
    assert.deepEqual(normalizeMasterRoles({ primaryId: '', secondaryId: '', dualEnabled: true }), { primaryId: '', secondaryId: '', dualEnabled: true });
    for (const raw of [null, {}, { ...roles, primaryId: '1234' }, { ...roles, primaryId: '1'.repeat(16) }, { ...roles, secondaryId: primary }, { ...roles, primaryId: '' }, { ...roles, dualEnabled: 'true' }]) assert.throws(() => normalizeMasterRoles(raw));
  });
  check('legacy migration intentionally clears all owners', () => {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ bot: { masterIds: ['750001', '750002', primary] } }));
    const loaded = loadConfig(root);
    assert.deepEqual(loaded.config.bot.masterRoles, DEFAULT_CONFIG.bot.masterRoles);
    assert.deepEqual(loaded.config.bot.masterIds, []);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).bot.masterIds, []);
    loaded.config.bot.masterRoles = roles;
    loaded.config.bot.masterIds = ['stale'];
    saveConfig(loaded.config, path);
    assert.deepEqual(loaded.config.bot.masterIds, [primary, secondary]);
    assert.deepEqual(getMasterIds(loadConfig(root).config.bot), [primary, secondary]);
  });
  check('effective ranks ignore stale cache and inactive secondary draft', () => {
    config.bot.masterRoles = { ...roles, dualEnabled: false };
    assert.deepEqual(getMasterIds(config.bot), [primary]);
    assert.equal(masterRole(secondary, config.bot), 'none');
    assert.equal(config.bot.masterRoles.secondaryId, secondary);
    config.bot.masterRoles = { ...roles };
    config.bot.masterIds = ['stale'];
    assert.equal(masterRole(secondary, config.bot), 'secondary');
  });
  const calls: string[] = [];
  const client = {
    setGroupBan: async () => { calls.push('ban'); }, deleteMsg: async () => { calls.push('recall'); },
    getMsg: async () => ({ sender: { user_id: primary } }),
  } as unknown as OneBotClient;
  const session = ensureSession(db, 'g:444444', 'group', '444444', 'Test', config.defaults);
  const msg: NormalizedMessage = {
    sessionKey: session.key, type: 'group', targetId: session.targetId, sessionName: session.name,
    senderId: secondary, senderName: 'secondary', senderRole: 'member', senderTitle: '', messageId: '10',
    text: '', images: [], imageFiles: [], atSelf: true, atOthers: [], replyTo: null, quotedText: null, raw: {}, time: 0,
  };
  const ctx: ToolContext = { config, db, client, session, msg, isMaster: true, note: () => {} };
  check('secondary tool definitions omit primary-only capabilities', () => {
    const defs = toolDefsFor(ctx);
    assert.equal(defs.some(d => d.name === 'set_favor' || d.name === 'list_ignore'), false);
    const clear = defs.find(d => d.name === 'clear_memory')!;
    assert.deepEqual((clear.parameters.properties as Record<string, { enum: string[] }>).scope.enum, ['session']);
    assert.doesNotMatch(clear.description, /老大|主人|全部/);
  });
  check('both ranks protected from ordinary and self-request punishment', () => {
    assert.equal(hasAdmin(ctx), true);
    assert.ok(protectedTarget(ctx, primary)); assert.ok(protectedTarget(ctx, secondary));
    assert.equal(applyFavorDelta(ctx, primary, -10, 'test').ok, false);
    assert.equal(applyFavorDelta(ctx, secondary, -10, 'test').ok, false);
  });
  for (const tool of [
    { name: 'set_favor', args: { user_id: ordinary, score: 100 } },
    { name: 'clear_memory', args: { scope: 'all' } },
    { name: 'list_ignore', args: {} },
    { name: 'ban_member', args: { user_id: primary } },
    { name: 'ban_member', args: { user_id: secondary } },
    { name: 'recall_message', args: { message_id: '20' } },
  ]) { assert.equal((await runTool(ctx, { id: 'test', ...tool })).ok, false, tool.name); count++; }
  assert.equal(calls.length, 0);
  assert.match((await executeTagActions([{ kind: 'ban', userId: primary, seconds: 60 }, { kind: 'recall', msgId: '20' }], ctx)).join(''), /失败/);
  assert.equal(calls.length, 0); count++;
  msg.senderId = primary;
  check('primary retains privileged tool definitions', () => {
    const defs = toolDefsFor(ctx);
    assert.ok(defs.some(d => d.name === 'set_favor'));
    assert.ok(defs.some(d => d.name === 'list_ignore'));
    assert.ok(((defs.find(d => d.name === 'clear_memory')!.parameters.properties as Record<string, { enum: string[] }>).scope.enum).includes('all'));
  });
  assert.equal((await runTool(ctx, { id: 'test', name: 'set_favor', args: { user_id: ordinary, score: 42 } })).ok, true); count++;
  assert.equal((await runTool(ctx, { id: 'test', name: 'list_ignore', args: {} })).ok, true); count++;
  config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: true };
  msg.senderId = ordinary; msg.senderRole = 'admin';
  check('no-owner tool definitions contain no owner-specific input', () => {
    const defs = toolDefsFor(ctx);
    assert.equal(defs.some(d => d.name === 'set_favor' || d.name === 'list_ignore'), false);
    assert.doesNotMatch(JSON.stringify(defs), /老大|主人/);
    assert.deepEqual((defs.find(d => d.name === 'clear_memory')!.parameters.properties as Record<string, { enum: string[] }>).scope.enum, ['session']);
  });
  check('no-owner group admin and forged isMaster cannot obtain owner privileges', () => {
    assert.equal(hasAdmin(ctx), true); // ordinary group moderation is not owner configuration
    assert.equal(applyFavorDelta(ctx, ordinary, 12, 'test', 'set').ok, false);
  });
  for (const name of ['set_favor', 'list_ignore', 'clear_memory']) {
    assert.equal((await runTool(ctx, { id: 'test', name, args: { user_id: ordinary, score: 5, scope: 'all' } })).ok, false); count++;
  }
  const pipeline = new Pipeline({ config, db, client });
  const internals = pipeline as unknown as {
    respond: (item: { msg: NormalizedMessage; session: typeof session }) => Promise<void>;
    respondProactive: (item: { msg: NormalizedMessage; session: typeof session }) => Promise<void>;
    runModel: (context: ToolContext) => Promise<string>;
    sendReply: () => Promise<boolean>;
  };
  const proactive = internals.respondProactive.bind(pipeline);
  let synthetic: NormalizedMessage | undefined;
  internals.respondProactive = async item => { synthetic = item.msg; };
  await pipeline.proactive(session.key);
  assert.equal(synthetic?.senderId, '0'); assert.equal(synthetic?.senderName, '主动发言'); assert.equal(isMasterQq(synthetic?.senderId, config.bot), false); count++;
  let proactiveMaster: boolean | undefined;
  internals.runModel = async context => { proactiveMaster = context.isMaster; return ''; };
  await proactive({ msg: synthetic!, session });
  assert.equal(proactiveMaster, false); count++;
  internals.sendReply = async () => false;
  internals.runModel = async () => `[设置好感 ${ordinary} 99] test`;
  for (const sender of [secondary, ordinary]) {
    config.bot.masterRoles = sender === secondary ? { ...roles } : { primaryId: '', secondaryId: '', dualEnabled: false };
    msg.senderId = sender; msg.senderRole = 'admin';
    await internals.respond({ msg, session });
    assert.equal((db.prepare('SELECT score FROM favor WHERE qq = ?').get(ordinary) as { score: number }).score, 42); count++;
  }
  config.bot.masterRoles = { ...roles }; msg.senderId = primary;
  await internals.respond({ msg, session });
  assert.equal((db.prepare('SELECT score FROM favor WHERE qq = ?').get(ordinary) as { score: number }).score, 99); count++;
  config.bot.masterRoles = { primaryId: '', secondaryId: '', dualEnabled: true };

  config.panel.port = 0;
  let saves = 0, changes = 0;
  panel = await startPanel({ config, configPath: join(root, 'panel-config.json'), db, client, startedAt: Date.now(), getStatus: () => ({ onebotConnected: false, selfId: '', reconnects: 0, lastError: '' }), saveConfig: () => { saves++; }, onConfigChange: () => { changes++; } });
  const base = `http://127.0.0.1:${panel.port}`;
  const post = (body: unknown) => fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const before = structuredClone(config);
  const invalid = await post({ llm: { model: 'must-not-change' }, persona: { systemPrompt: 'must-not-change' }, bot: { globalAutoReply: false, masterRoles: { ...roles, secondaryId: primary } } });
  assert.equal(invalid.status, 400); assert.deepEqual(config, before); assert.equal(saves, 0); assert.equal(changes, 0); count++;
  const emptyOverview = await (await fetch(`${base}/api/overview`)).json();
  assert.deepEqual(emptyOverview.masterStatus, { mode: 'none', primary: null, secondary: null }); count++;
  appendMessage(db, { sessionKey: session.key, role: 'user', content: 'nick', senderId: primary, senderName: 'Primary nickname', msgId: '30' });
  assert.equal((await post({ bot: { masterRoles: roles } })).status, 200);
  assert.deepEqual(config.bot.masterIds, [primary, secondary]); assert.equal(saves, 1); assert.equal(changes, 1); count++;
  const overview = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(overview.masterStatus.mode, 'dual'); assert.equal(overview.masterStatus.primary.nickname, 'Primary nickname'); assert.equal(overview.masterStatus.secondary.qq, secondary); count++;
  const favors = await (await fetch(`${base}/api/favors`)).json();
  assert.equal(favors.favors.find((f: { qq: string }) => f.qq === primary)?.masterRole, 'primary');
  assert.equal(favors.favors.find((f: { qq: string }) => f.qq === secondary)?.masterRole, 'secondary'); count++;
  const locked = await fetch(`${base}/api/favors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qq: primary, score: 2 }) });
  assert.equal(locked.status, 400); count++;
  assert.equal((await post({ bot: { masterRoles: { ...roles, dualEnabled: false } } })).status, 200);
  assert.deepEqual(getMasterIds(config.bot), [primary]);
  const single = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(single.masterStatus.mode, 'single'); assert.equal(single.masterStatus.secondary, null); count++;
  console.log(`\n${count} identity/permission regression checks passed.`);
} finally {
  await panel?.close(); db.close();
  // This directory was created by this test. Verify its exact resolved scope before deleting.
  const resolved = realpathSync(root), temporaryRoot = realpathSync(tmpdir());
  assert.ok(resolved.startsWith(temporaryRoot + sep + 'maid-master-roles-'));
  rmSync(resolved, { recursive: true, force: true });
}
