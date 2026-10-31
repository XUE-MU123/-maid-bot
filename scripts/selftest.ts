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

  // ---- mermaid：说明书教会了，出图参数锁住了 ----
  const { RENDER_GUIDE } = await import('../src/modules/prompt.ts');
  check('说明书教会了 mermaid 流程图', RENDER_GUIDE.includes('```mermaid'), 'prompt 里没有 mermaid 代码块说明');
  check('说明书列了流程图种类', /flowchart|sequenceDiagram|gantt|mindmap/.test(RENDER_GUIDE), '');
  check('说明书警告了隐私', /密码/.test(RENDER_GUIDE) && /mermaid/.test(RENDER_GUIDE), '缺「敏感信息别走 mermaid」的警告');
  check('表格仍是最后一条', RENDER_GUIDE.includes('④ **表格'), '表格编号没递延');

  const { mermaidUrl, pickWidth } = await import('../src/modules/render/mermaid.ts');
  check('原图请求带白底', mermaidUrl('flowchart TD\n  A-->B').includes('bgColor=white'), '');
  check('原图请求不乱指定宽度', !/width=/.test(mermaidUrl('flowchart TD\n  A-->B')), '量尺寸时不能带 width');
  check('指定宽度时能带上', mermaidUrl('x', 'default', 1200).includes('width=1200'), '');
  // 尺子：只放大不缩小；超宽图给足放大余量
  check('甘特图不被缩小', pickWidth(1904, 196) >= 1904, String(pickWidth(1904, 196)));
  check('超宽图长边到 2600', pickWidth(1904, 196) === 2600, String(pickWidth(1904, 196)));
  check('普通图长边到 1800', pickWidth(250, 382) === 1178, String(pickWidth(250, 382)));
  check('已经够大的图不放大', pickWidth(3000, 300) === 3000, String(pickWidth(3000, 300)));

  // ---- 表格里的 emoji：正文照删，表格要留 ----
  const tidy = (pipeline as unknown as { tidyReply: (t: string) => string }).tidyReply;
  const tableReply = [
    '老大，榜单来了',
    '',
    '| 排名 | 昵称 | 好感度 |',
    '|---|---|---|',
    '| 5 | 🍃 | 31 |',
    '',
    '今天天气不错😀',
  ].join('\n');
  const tidied = tidy(tableReply);
  check('表格里的 emoji 留住了', tidied.includes('🍃'), tidied);
  check('正文里的 emoji 照样删掉', !tidied.includes('😀'), tidied);

  const { renderTable } = await import('../src/modules/render/table.ts');
  const dirty = renderTable({ head: ['排名', '昵称'], rows: [['1', '劫瑞\ue814']] });
  check('私用区字符不会画成空方框', dirty.width > 0, '渲染失败');

  // ---- 不理名单：阶梯时长 + 记录不删 ----
  const { markIgnore, releaseIgnore, isIgnored, listIgnores, humanRemain, durationFor, FOREVER } = await import('../src/modules/ignore.ts');
  const S = 'g:123456';
  const Q = '999888777';
  const d1 = markIgnore(db, S, Q, '测试');
  check('第一次 10 分钟', !!d1 && Math.round(d1.durationMs / 60000) === 10, String(d1?.durationMs));
  check('第一次后排进名单', isIgnored(db, S, Q), '标记后应当命中');
  const d2 = markIgnore(db, S, Q, '测试');
  check('第二次 1 小时', !!d2 && Math.round(d2.durationMs / 3600000) === 1, String(d2?.durationMs));
  const d3 = markIgnore(db, S, Q, '测试');
  check('第三次 半小时', !!d3 && Math.round(d3.durationMs / 60000) === 30, String(d3?.durationMs));
  const d4 = markIgnore(db, S, Q, '测试');
  check('第四次 6 小时', !!d4 && Math.round(d4.durationMs / 3600000) === 6, String(d4?.durationMs));
  const d5 = markIgnore(db, S, Q, '测试');
  check('第五次 1 天', !!d5 && Math.round(d5.durationMs / 86400000) === 1, String(d5?.durationMs));
  const d6 = markIgnore(db, S, Q, '测试');
  check('第六次 永久', !!d6 && d6.until >= FOREVER, String(d6?.until));
  check('第七次仍是永久', durationFor(7) >= FOREVER, String(durationFor(7)));
  check('累计次数只增不减', (listIgnores(db).find((x) => x.qq === Q)?.times ?? 0) === 6, '');
  releaseIgnore(db, S, Q, '测试');
  check('解除后不在名单', !isIgnored(db, S, Q), '解除后不该命中');
  const kept = db.prepare('SELECT times FROM ignore_state WHERE session_key=? AND qq=?').get(S, Q) as { times?: number } | undefined;
  check('解除不删记录', Number(kept?.times) === 6, JSON.stringify(kept));
  check('剩余时间说人话', humanRemain(3870) === '1 小时 4 分钟', humanRemain(3870));

  // ---- 中转站残留的内部调用 ----
  const { cleanArtifacts } = await import('../src/modules/llm.ts');
  const emitDirty = '遵命！画好了～(*/ω＼*)\n\nemit_complete_response_f8ce0ea99f80c93987e726a0(content="遵命！画好了～(*/ω＼*)")';
  check('剥掉 emit_complete_response 残留', !cleanArtifacts(emitDirty).includes('emit_complete_response'), cleanArtifacts(emitDirty));
  check('正常回复不动', cleanArtifacts('正常的几句话。') === '正常的几句话。', '');
  check('只剩残留时取出正文', cleanArtifacts('emit_complete_response_abc123def456(content="正常一句话")') === '正常一句话', '');

  // ---- 引用消息里的图 ----
  const p2: any = pipeline as any;
  check('能从数组段取图', JSON.stringify(p2.rawMessageImages([{ type: 'image', data: { url: 'https://a/1.jpg' } }])) === '["https://a/1.jpg"]', '');
  check('能从 CQ 码取图且优先 url', JSON.stringify(p2.rawMessageImages('[CQ:image,file=abc.jpg,url=https://a/2.jpg]')) === '["https://a/2.jpg"]', '');
  check('没图返回空', p2.rawMessageImages([{ type: 'text', data: { text: 'x' } }]).length === 0, '');

  // ---- 被转义吐出来的代码块 ----
  const escapedDup = '画好啦\n\n```draw\n@100x100 #fff\n```\n\n\\n\\n```draw\\n@100x100 #fff\\n```"})';
  const fixed = cleanArtifacts(escapedDup);
  check('转义的代码块被解包', fixed.includes('```draw\n'), JSON.stringify(fixed.slice(0, 40)));
  check('重复的代码块只留一份', (fixed.match(/```draw/g) || []).length === 1, String((fixed.match(/```draw/g) || []).length));
  check('JSON 尾巴被清掉', !/["'}]\s*$/.test(fixed.trim()), JSON.stringify(fixed.slice(-10)));

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  db.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
