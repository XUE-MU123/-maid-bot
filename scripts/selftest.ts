// 离线自测：不连 QQ、不花 token，用假 OneBot 客户端把整条流水线跑一遍。
// 用法：node scripts/selftest.ts
import { openDb } from '../src/core/db.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { Pipeline } from '../src/modules/pipeline.ts';
import { listSessions } from '../src/modules/session.ts';
import { messageCount, recentMessages } from '../src/modules/memory.ts';
import { listFavors, getFavor } from '../src/modules/favor.ts';
import { rmSync } from 'node:fs';
import type { Config, OneBotEvent } from '../src/core/types.ts';

const DIR = '/tmp/maid-selftest';
rmSync(DIR, { recursive: true, force: true });

const config: Config = structuredClone(DEFAULT_CONFIG);
config.llm.mock = true;
config.bot.selfIds = ['999999'];
config.bot.masterIds = ['111111', '222222'];  // 假回复模式只陪老大试，测试里把两个人都当老大
config.bot.splitReply = true;

const sent: Array<{ api: string; id: string; message: unknown }> = [];
const fakeClient = {
  sendGroupMsg: async (id: string, message: unknown) => { sent.push({ api: 'group', id, message }); return 'm1'; },
  sendPrivateMsg: async (id: string, message: unknown) => { sent.push({ api: 'private', id, message }); return 'm2'; },
  setGroupBan: async () => { sent.push({ api: 'ban', id: '', message: null }); },
  setGroupWholeBan: async () => { /* noop */ },
  kickGroupMember: async () => { /* noop */ },
  deleteMsg: async () => { /* noop */ },
  getMutedList: async () => [],
  getGroupMemberList: async () => [],
  getGroupInfo: async () => ({ group_name: '测试群' }),
  getMsg: async (id: string) => (id === 'm1' ? { sender: { user_id: 999999 } } : null),
  getGroupMemberInfo: async (_g: string, uid: string) => (uid === '7355608' ? { card: '黑石', nickname: '黑石' } : null),
  call: async () => null,
} as unknown as import('../src/onebot/client.ts').OneBotClient;

const db = openDb(DIR);
const pipeline = new Pipeline({ config, db, client: fakeClient });
pipeline.setBotNames(['女仆']);

function groupMsg(userId: string, text: string, atSelf = true, msgId = String(Math.random()).slice(2, 10)): OneBotEvent {
  const segs: unknown[] = [];
  if (atSelf) segs.push({ type: 'at', data: { qq: '999999' } });
  segs.push({ type: 'text', data: { text } });
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 999999, time: Math.floor(Date.now() / 1000),
    message_id: Number(msgId), group_id: 123456, user_id: Number(userId),
    message: segs,
    sender: { user_id: Number(userId), nickname: '小明', card: '小明', role: 'member' },
  } as OneBotEvent;
}

function privateMsg(userId: string, text: string): OneBotEvent {
  return {
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    self_id: 999999, time: Math.floor(Date.now() / 1000),
    message_id: 777, user_id: Number(userId),
    message: [{ type: 'text', data: { text } }],
    sender: { user_id: Number(userId), nickname: '老大', role: 'member' },
  } as OneBotEvent;
}

let pass = 0; let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main(): Promise<void> {
  console.log('\n[1] 群里被 @ 应回复');
  await pipeline.handleEvent(groupMsg('222222', '你好呀'));
  check('确实发出了一条群消息', sent.length === 1, `sent=${sent.length}`);
  check('回复带引用段', JSON.stringify(sent[0]?.message ?? '').includes('"reply"'), JSON.stringify(sent[0]?.message));
  check('会话已建档', listSessions(db).length === 1);
  check('记忆已写入（用户+助手）', messageCount(db, 'g:123456') >= 2, String(messageCount(db, 'g:123456')));

  console.log('\n[2] 自己的消息不该回复');
  const before = sent.length;
  await pipeline.handleEvent({ ...groupMsg('999999', '我自己说的'), self_id: 999999 } as OneBotEvent);
  check('没有多发一条', sent.length === before);

  console.log('\n[3] 重复内容被防刷屏拦掉');
  const dup = groupMsg('222222', '重复的话', true, 'dup1');
  await pipeline.handleEvent(dup);
  const afterFirst = sent.length;
  await pipeline.handleEvent({ ...dup, message_id: 8888 } as OneBotEvent);
  check('第二次相同内容未回复', sent.length === afterFirst, `${afterFirst} → ${sent.length}`);

  console.log('\n[4] 私聊必回');
  await pipeline.handleEvent(privateMsg('111111', '在吗'));
  check('私聊发出了消息', sent.some((s) => s.api === 'private'));

  console.log('\n[5] 好感度按人记录');
  const favors = listFavors(db, 10, config.bot.masterIds);
  check('好感表有条目', favors.length >= 1, JSON.stringify(favors));
  const master = getFavor(db, '111111', true);
  check('老大锁定为第 10 级', master.levelIndex === 9 && master.levelName.includes('至高主权'), JSON.stringify(master));

  console.log('\n[6] 历史检索');
  const hits = recentMessages(db, { key: 'g:123456' } as never, 50);
  check('能取回历史消息', hits.length >= 2, String(hits.length));

  console.log('\n[7] 引用别人的消息，不该插嘴');
  const before2 = sent.length;
  const quoteOther: OneBotEvent = {
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 999999,
    time: Math.floor(Date.now() / 1000), message_id: 9101, group_id: 123456, user_id: 222222,
    message: [
      { type: 'reply', data: { id: 'someone-else-msg' } },
      { type: 'text', data: { text: '你说得对' } },
    ],
    sender: { user_id: 222222, nickname: '小明', role: 'member' },
  } as OneBotEvent;
  await pipeline.handleEvent(quoteOther);
  check('引用别人消息时没有回复', sent.length === before2, `${before2} → ${sent.length}`);

  console.log('\n[8] 引用机器人自己的消息，应该回');
  const quoteSelf: OneBotEvent = {
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 999999,
    time: Math.floor(Date.now() / 1000), message_id: 9102, group_id: 123456, user_id: 222222,
    message: [
      { type: 'reply', data: { id: 'm1' } },
      { type: 'text', data: { text: '这话什么意思呀' } },
    ],
    sender: { user_id: 222222, nickname: '小明', role: 'member' },
  } as OneBotEvent;
  await pipeline.handleEvent(quoteSelf);
  check('引用自己消息时回复了', sent.length === before2 + 1, `${before2} → ${sent.length}`);

  console.log('\n[10] 发图但不吭声：只登记，不识别、不回复');
  const before3 = sent.length;
  const picOnly: OneBotEvent = {
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 999999,
    time: Math.floor(Date.now() / 1000), message_id: 9104, group_id: 123456, user_id: 333333,
    message: [{ type: 'image', data: { url: 'https://example.com/a.png', file: 'PIC.image' } }],
    sender: { user_id: 333333, nickname: '小红', role: 'member' },
  } as OneBotEvent;
  await pipeline.handleEvent(picOnly);
  const picRows = db.prepare('SELECT COUNT(*) AS c FROM images').get() as { c: number };
  check('图片已登记', picRows.c >= 1, String(picRows.c));
  const picRec = db.prepare('SELECT desc FROM images ORDER BY last_seen DESC LIMIT 1').get() as { desc: string };
  check('只登记没识别（描述为空）', picRec.desc === '', JSON.stringify(picRec.desc));
  check('没有乱回复', sent.length === before3, `${before3} → ${sent.length}`);

  console.log('\n[11] [跳过] 判定');
  const wantsSkip = (pipeline as unknown as { wantsSkip: (t: string) => boolean }).wantsSkip.bind(pipeline);
  check('纯 [跳过] → 跳过', wantsSkip('[跳过]'));
  check('【跳过】 → 跳过', wantsSkip('【跳过】'));
  check('正常说话里带"跳过" → 不跳过', !wantsSkip('这个先跳过吧，我们说别的'));

  console.log('\n[9] @ 别人时要能翻译成昵称');
  const atOther: OneBotEvent = {
    post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 999999,
    time: Math.floor(Date.now() / 1000), message_id: 9103, group_id: 123456, user_id: 111111,
    message: [
      { type: 'at', data: { qq: '999999' } },
      { type: 'text', data: { text: ' 这个' } },
      { type: 'at', data: { qq: '7355608' } },
      { type: 'text', data: { text: ' 是gay 你记一下' } },
    ],
    sender: { user_id: 111111, nickname: '老大', role: 'owner' },
  } as OneBotEvent;
  await pipeline.handleEvent(atOther);
  const atRow = db.prepare("SELECT content FROM messages WHERE role='user' ORDER BY id DESC LIMIT 1").get() as { content: string };
  check('@ 提到了黑石的名字', atRow.content.includes('黑石'), atRow.content.slice(0, 120));
  check('@ 里保留了 QQ 号', atRow.content.includes('7355608'), atRow.content.slice(0, 120));

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
