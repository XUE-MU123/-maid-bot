// 触发判定：@、回复机器人、关键词、随机比例，四种命中方式各自独立。
import type { Config, NormalizedMessage, Session } from '../core/types.ts';

export type TriggerKind = 'at' | 'reply' | 'keyword' | 'random' | 'private';

export interface TriggerResult {
  hit: boolean;
  kind: TriggerKind | null;
  /** 给日志看的一句话 */
  reason: string;
}

function roll(p: number): boolean {
  if (p <= 0) return false;
  if (p >= 1) return true;
  return Math.random() < p;
}

export function decideTrigger(
  msg: NormalizedMessage,
  session: Session,
  config: Config,
  botNames: string[],
  opts: { quotedIsSelf?: boolean } = {},
): TriggerResult {
  // 私聊：默认每次都回（一对一聊天没必要摇概率）
  if (session.type === 'private') {
    return { hit: true, kind: 'private', reason: '私聊直接回' };
  }

  if (session.enabled === false) return { hit: false, kind: null, reason: '会话已停用' };

  // 1. 被 @
  if (msg.atSelf) {
    const p = session.atProb;
    return roll(p)
      ? { hit: true, kind: 'at', reason: `被@（概率 ${(p * 100).toFixed(0)}%）` }
      : { hit: false, kind: null, reason: `被@但概率未命中` };
  }

  // 2. 引用了「机器人自己的」某条消息（引用别人的不算，别乱插嘴）
  if (msg.replyTo && opts.quotedIsSelf) {
    const p = Math.max(session.atProb, 0.8);
    return roll(p)
      ? { hit: true, kind: 'reply', reason: '被引用回复' }
      : { hit: false, kind: null, reason: '被引用但概率未命中' };
  }

  // 3. 关键词命中
  const text = msg.text.toLowerCase();
  // 会话自己配了关键词就只认它自己的，没配才用全局 + 机器人名字
  const own = String(session.keywords || '')
    .split(/[,，\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const kws = (own.length ? own : [...config.bot.triggerKeywords, ...botNames]).filter(Boolean);
  const hitKw = kws.find((k) => k && text.includes(k.toLowerCase()));
  if (hitKw) {
    const p = session.keywordProb;
    return roll(p)
      ? { hit: true, kind: 'keyword', reason: `命中关键词「${hitKw}」` }
      : { hit: false, kind: null, reason: '关键词命中但概率未命中' };
  }

  // 4. 随机插话
  const p = session.randomProb;
  return roll(p)
    ? { hit: true, kind: 'random', reason: `随机插话（${(p * 100).toFixed(0)}%）` }
    : { hit: false, kind: null, reason: '未命中任何触发' };
}

/** 防刷屏：同一会话相同内容在窗口内只处理一次 */
export class Deduper {
  private seen = new Map<string, number>();
  check(sessionKey: string, text: string, windowMs: number): boolean {
    const now = Date.now();
    // 顺手清理过期项，避免无限增长
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (now - t > windowMs) this.seen.delete(k);
    }
    const key = sessionKey + '\u0000' + text.trim().slice(0, 120);
    const last = this.seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.seen.set(key, now);
    return true;
  }
}

/** 会话冷却：同一会话两次回复之间至少隔一段时间 */
export class Cooldown {
  private last = new Map<string, number>();
  ready(sessionKey: string, cooldownMs: number): boolean {
    const now = Date.now();
    const prev = this.last.get(sessionKey) ?? 0;
    if (now - prev < cooldownMs) return false;
    this.last.set(sessionKey, now);
    return true;
  }
  mark(sessionKey: string): void { this.last.set(sessionKey, Date.now()); }
}
