// 真实 WebSocket 端到端：本地起一个假的 OneBot v11 服务端，
// 让真的 OneBotClient + Pipeline 连上去走完整流程（登录握手 → 推事件 → 收回复）。
// 用法：node scripts/e2e-fake-onebot.ts
import { WebSocketServer } from 'ws';
import { openDb } from '../src/core/db.ts';
import { DEFAULT_CONFIG } from '../src/core/config.ts';
import { OneBotClient } from '../src/onebot/client.ts';
import { Pipeline } from '../src/modules/pipeline.ts';
import { rmSync } from 'node:fs';
import type { Config } from '../src/core/types.ts';

const PORT = 3987;
const DIR = '/tmp/maid-e2e';
rmSync(DIR, { recursive: true, force: true });

const config: Config = structuredClone(DEFAULT_CONFIG);
config.onebot.wsUrl = `ws://127.0.0.1:${PORT}/`;
config.onebot.accessToken = 'test-token';
const REAL = process.env.E2E_REAL === '1';
config.llm.mock = !REAL;
config.llm.apiKey = REAL ? config.llm.apiKey : '';
if (REAL) { const { loadConfig } = await import('../src/core/config.ts'); const live = loadConfig('./data').config; config.llm = live.llm; }
config.bot.selfIds = ['1000001'];
config.bot.masterIds = ['1000002'];
config.bot.cooldownMs = 0;
config.panel.port = 3998;
config.persona.systemPrompt = '你是测试机器人，老大的女仆大总管。';

const db = openDb(DIR);
const client = new OneBotClient(config);
const pipeline = new Pipeline({ config, db, client });
pipeline.setBotNames(['测试机器人']);
client.on('event', (ev) => { void pipeline.handleEvent(ev as never); });

const received: Array<{ action: string; params: Record<string, unknown> }> = [];
let authed = false;
let pushed = false;

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (sock, req) => {
  authed = req.headers.authorization === 'Bearer test-token';
  console.log(`[fake] 客户端已连接，鉴权头${authed ? '正确' : '错误'}`);
  sock.on('message', (buf) => {
    const msg = JSON.parse(buf.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string };
    if (!msg.action) return;
    received.push({ action: msg.action, params: msg.params ?? {} });
    let data: unknown = null;
    if (msg.action === 'get_login_info') data = { user_id: 1000001, nickname: '测试机器人' };
    else if (msg.action === 'get_group_info') data = { group_id: 123456, group_name: '老大的测试群' };
    else if (msg.action === 'send_group_msg' || msg.action === 'send_private_msg') data = { message_id: 1001 };
    sock.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: msg.echo }));
  });
});

function push(ev: unknown): void {
  const sock = [...wss.clients][0];
  if (!sock) return;
  sock.send(JSON.stringify(ev));
}

let pass = 0; let fail = 0;
const check = (name: string, ok: boolean, extra = ''): void => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

setTimeout(() => client.connect(), 200);

setTimeout(() => {
  check('WS 连接与鉴权成功', authed);
  check('握手后调用了 get_login_info', received.some((r) => r.action === 'get_login_info'));
  check('登录后记下了自己的 QQ', client.getStatus().selfId === '1000001', client.getStatus().selfId);
  pushed = true;
  push({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    self_id: 1000001, time: Math.floor(Date.now() / 1000),
    message_id: 5555, group_id: 123456, user_id: 1000002,
    message: [
      { type: 'at', data: { qq: '1000001' } },
      { type: 'text', data: { text: '女仆，在吗' } },
    ],
    sender: { user_id: 1000002, nickname: '老大', card: '老大', role: 'owner' },
  });
}, 1200);

setTimeout(() => {
  const sends = received.filter((r) => r.action === 'send_group_msg');
  check('确实收到了 send_group_msg', sends.length >= 1, `收到 ${sends.length} 条`);
  const first = sends[0]?.params as { group_id?: number; message?: unknown } | undefined;
  check('发给了正确的群', first?.group_id === 123456, JSON.stringify(first?.group_id));
  const segs = JSON.stringify(first?.message ?? '');
  check('回复里带引用段', segs.includes('"reply"'), segs.slice(0, 120));
  check('回复里带文本', segs.includes('"text"'), segs.slice(0, 120));
  check('群名已回填', (db.prepare("select name from sessions where key='g:123456'").get() as { name?: string } | undefined)?.name === '老大的测试群');
  check('对话已入库（用户+助手）', (db.prepare('select count(*) c from messages').get() as { c: number }).c >= 2);
  // 老大按设计不参与打分（锁定），所以这里应该是 0 行
  check('老大不记好感（锁定生效）', (db.prepare('select count(*) c from favor').get() as { c: number }).c === 0);

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  client.close(); db.close(); wss.close();
  process.exit(fail === 0 ? 0 : 1);
}, REAL ? 60000 : 4500);

setTimeout(() => { console.log('超时'); process.exit(1); }, REAL ? 120000 : 20000).unref();
