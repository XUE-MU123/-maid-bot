// 启动入口：装配配置、数据库、OneBot、流水线、面板，全部就绪后待命。
import { loadConfig, saveConfig } from './core/config.ts';
import { initLogger, makeLogger, setLevel } from './core/logger.ts';
import { openDb } from './core/db.ts';
import { OneBotClient } from './onebot/client.ts';
import { Pipeline } from './modules/pipeline.ts';
import { startPanel } from './server/panel.ts';
import { migrateLegacyIgnores } from './modules/ignore.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = makeLogger('main');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  console.log('\n maid-bot —— 老大的专属女仆大总管，正在起床……\n');

  const { config, healed, configPath } = loadConfig(resolve(ROOT, 'data'));
  if (healed.length) log.info(`配置自愈：${healed.join('；')}`);
  initLogger(resolve(ROOT, 'logs'), config.logging.level, config.logging.keepDays);
  setLevel(config.logging.level);

  if (config.llm.mock || !config.llm.apiKey) {
    log.warn('现在是「假回复模式」：只会用固定话术回答老大，不会真聊天。到面板「设置」里填好接口和 Key，再把 mock 关掉就正常了。');
  }

  const db = openDb(resolve(ROOT, config.storage.dataDir.replace(/^\.\//, '')));
  migrateLegacyIgnores(db);   // 老的不理记录（存在 meta 里）搬到 ignore_state 表
  const client = new OneBotClient(config);
  const pipeline = new Pipeline({ config, db, client });

  client.on('event', (ev) => {
    try { void pipeline.handleEvent(ev); }
    catch (err) { log.error(`事件处理异常：${String(err)}`); }
  });
  client.on('login', (selfId: string, nick: string) => {
    if (!config.bot.selfIds.includes(selfId)) config.bot.selfIds.push(selfId);
    saveConfig(config, configPath);
    pipeline.setBotNames([nick, ...config.bot.triggerKeywords]);
    log.info(`已把机器人 ${nick}(${selfId}) 记入防自回名单`);
  });
  client.on('disconnected', () => log.warn('与 OneBot 的连接断开，稍后自动重连'));

  client.connect();

  let stopping = false;
  const shutdown = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${sig}，准备下班……`);
    try { client.close(); } catch { /* 忽略 */ }
    try { db.close(); } catch { /* 忽略 */ }
    setTimeout(() => process.exit(0), 200).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    const panel = await startPanel({
      config, configPath, db, client, startedAt: Date.now(),
      getStatus: () => {
        const s = client.getStatus();
        return { onebotConnected: s.connected, selfId: s.selfId, reconnects: s.reconnects, lastError: s.lastError };
      },
      saveConfig: () => saveConfig(config, configPath),
      onConfigChange: () => setLevel(config.logging.level),
    });
    log.info(`面板已启动：http://127.0.0.1:${panel.port}（nginx 反代到 3211 后用浏览器访问）`);
  } catch (err) {
    log.error(`面板启动失败：${String((err as Error)?.message ?? err)}（机器人本身不受影响）`);
  }

  log.info('一切就绪，等老大吩咐。');
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
