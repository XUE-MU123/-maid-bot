// 标签协议：模型在回复正文里写 [禁言 123 60] 这类中文标签，这里负责解析、执行、并把标签从正文里摘干净。
// 设计原则：不认识的方括号原样保留（比如 [图片] [at:123]），宁可多留字，不可误删用户的文本。
import { makeLogger } from '../core/logger.ts';
import { DEFAULT_BAN_SEC, MAX_BAN_SEC, hasAdmin, humanError, protectedTarget } from './tools.ts';
import type { ToolContext } from './context.ts';

const log = makeLogger('tags');

export interface TagAction {
  kind: 'ban' | 'unban' | 'whole_ban' | 'whole_unban' | 'kick' | 'kick_black' | 'recall';
  userId?: string;
  seconds?: number;
  enable?: boolean;
  msgId?: string;
}

export interface ParsedTags {
  /** 摘掉标签后的干净正文 */
  text: string;
  actions: TagAction[];
  /** 对当前说话人打分；null 表示没打分 */
  favorDelta: number | null;
  favorReason: string;
  /** [设置好感 QQ 30] */
  favorSet: { qq: string; score: number } | null;
  /** [增加好感 QQ 3] / [减少好感 QQ 2] */
  favorAdd: { qq: string; delta: number } | null;
  mentions: string[];
  replyTo: string | null;
  images: string[];
}

const clampInt = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(n)));
/** 单条好感标签的粗夹取范围，真正的每日上限与档位由 favor 模块负责 */
const TAG_FAVOR_MIN = -100;
const TAG_FAVOR_MAX = 100;

/** 全角数字/符号转半角，顺便把全角空格压成普通空格，方便模型乱写 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＋/g, '+')
    .replace(/[－−]/g, '-')
    .replace(/[＝]/g, '=')
    .replace(/[\u3000\u00A0\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const isQq = (s: string): boolean => /^\d{1,15}$/.test(s);

/** 单条标签的实际含义；null 表示不认识，保留原文 */
function interpretTag(rawContent: string): {
  action?: TagAction;
  favorDelta?: { delta: number; reason: string };
  favorSet?: { qq: string; score: number };
  favorAdd?: { qq: string; delta: number };
  mention?: string;
  replyTo?: string;
  image?: string;
} | null {
  const s = toHalfWidth(rawContent);
  if (!s) return null;

  // 群管类
  const ban = /^禁言\s*(\d{1,15})(?:\s+(\d{1,10}))?$/.exec(s);
  if (ban) {
    const sec = ban[2] ? Number(ban[2]) : DEFAULT_BAN_SEC;
    return { action: { kind: 'ban', userId: ban[1], seconds: clampInt(sec, 0, MAX_BAN_SEC) } };
  }
  const unban = /^(?:解禁|解除禁言)\s*(\d{1,15})$/.exec(s);
  if (unban) return { action: { kind: 'unban', userId: unban[1] } };
  const kickBlack = /^(?:踢黑|踢出拉黑|拉黑踢出)\s*(\d{1,15})$/.exec(s);
  if (kickBlack) return { action: { kind: 'kick_black', userId: kickBlack[1] } };
  const kick = /^(?:踢出|踢)\s*(\d{1,15})$/.exec(s);
  if (kick) return { action: { kind: 'kick', userId: kick[1] } };
  const recall = /^(?:撤回|删除消息)\s*(\d{1,20})$/.exec(s);
  if (recall) return { action: { kind: 'recall', msgId: recall[1] } };
  if (/^(?:全员禁言|全体禁言|开启全员禁言)$/.test(s)) return { action: { kind: 'whole_ban', enable: true } };
  if (/^(?:全员解禁|全体解禁|解除全员禁言)$/.test(s)) return { action: { kind: 'whole_unban', enable: false } };

  // 消息增强
  const mention = /^atUin\s*=\s*(\d{1,15})$/i.exec(s);
  if (mention) return { mention: mention[1] };
  const reply = /^(?:引用|reply)\s*=\s*(\d{1,20})$/i.exec(s);
  if (reply) return { replyTo: reply[1] };
  const pic = /^(?:pic|img|图片?)\s*=\s*(\S+)$/i.exec(s);
  if (pic) return { image: pic[1] };

  // 好感度：给自己打分（分和理由之间用空格隔开）
  const grade = /^好感\s*([+-]?)\s*(\d{1,3})(?:\s+(.+))?$/.exec(s);
  if (grade) {
    const sign = grade[1] === '-' ? -1 : 1;
    const delta = clampInt(sign * Number(grade[2]), TAG_FAVOR_MIN, TAG_FAVOR_MAX);
    return { favorDelta: { delta, reason: (grade[3] ?? '').slice(0, 60) } };
  }
  // 好感度：指定某人
  const add = /^(?:增加好感|加好感|提升好感)\s*(\d{1,15})\s*([+-]?\d{1,3})$/.exec(s);
  if (add) return { favorAdd: { qq: add[1], delta: Number(add[2]) } };
  const sub = /^(?:减少好感|扣好感|降低好感)\s*(\d{1,15})\s*([+-]?\d{1,3})$/.exec(s);
  if (sub) return { favorAdd: { qq: sub[1], delta: -Math.abs(Number(sub[2])) } };
  const set = /^(?:设置好感|好感设为)\s*(\d{1,15})\s*([+-]?\d{1,5})$/.exec(s);
  if (set) return { favorSet: { qq: set[1], score: Number(set[2]) } };

  return null;
}

/** 解析正文里的全部标签，返回干净正文 + 结构化动作 */
export function parseTags(text: string): ParsedTags {
  const out: ParsedTags = {
    text: '',
    actions: [],
    favorDelta: null,
    favorReason: '',
    favorSet: null,
    favorAdd: null,
    mentions: [],
    replyTo: null,
    images: [],
  };
  const src = typeof text === 'string' ? text : '';
  if (!src) return out;

  // 逐个方括号扫描；只吃「认得的」标签，其余原样保留
  const re = /\[([^\[\]]{1,200})\]/g;
  let last = 0;
  let kept = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const hit = interpretTag(m[1]);
    if (!hit) continue;
    kept += src.slice(last, m.index);
    last = m.index + m[0].length;
    if (hit.action) out.actions.push(hit.action);
    else if (hit.mention) out.mentions.push(hit.mention);
    else if (hit.replyTo) out.replyTo = hit.replyTo;
    else if (hit.image) out.images.push(hit.image);
    else if (hit.favorDelta) {
      // 多个好感标签累加，理由用「；」拼接
      out.favorDelta = clampInt((out.favorDelta ?? 0) + hit.favorDelta.delta, TAG_FAVOR_MIN, TAG_FAVOR_MAX);
      if (hit.favorDelta.reason) {
        out.favorReason = out.favorReason ? `${out.favorReason}；${hit.favorDelta.reason}` : hit.favorDelta.reason;
      }
    } else if (hit.favorAdd) {
      // 同一个人的加减分合并，换人就以最后一个为准
      if (out.favorAdd && out.favorAdd.qq === hit.favorAdd.qq) out.favorAdd.delta += hit.favorAdd.delta;
      else out.favorAdd = { ...hit.favorAdd };
    } else if (hit.favorSet) {
      out.favorSet = { ...hit.favorSet };
    }
  }
  kept += src.slice(last);

  // 标签摘掉后收拾一下空白，别留一堆空行和双空格
  out.text = kept
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();

  return out;
}

/** 动作的中文说法，用于结果文案 */
const KIND_LABEL: Record<TagAction['kind'], string> = {
  ban: '禁言',
  unban: '解禁',
  whole_ban: '全员禁言',
  whole_unban: '全员解禁',
  kick: '踢人',
  kick_black: '踢人拉黑',
  recall: '撤回',
};

/**
 * 执行解析出来的群管动作，返回一句句中文结果（失败也返回文字，不抛错）。
 * 权限规则与 tools.ts 保持一致：必须群聊，且老大或群管理员。
 */
export async function executeTagActions(actions: TagAction[], ctx: ToolContext): Promise<string[]> {
  const results: string[] = [];
  if (!actions || actions.length === 0) return results;

  const isGroup = ctx.msg.type === 'group' && !!ctx.msg.targetId;
  const admin = hasAdmin(ctx);

  for (const act of actions) {
    const label = KIND_LABEL[act.kind] ?? '操作';
    try {
      // 撤回私聊也能用；禁言/踢人/全员禁言属于群管动作，必须群聊 + 管理员
      if (act.kind !== 'recall') {
        if (!isGroup) {
          results.push(`${label}失败：只能在群聊里做。`);
          continue;
        }
        if (!admin) {
          results.push(`${label}失败：这个操作需要管理员身份`);
          continue;
        }
      } else if (isGroup && !admin) {
        results.push(`${label}失败：这个操作需要管理员身份`);
        continue;
      }

      switch (act.kind) {
        case 'ban': {
          const target = act.userId ?? ctx.msg.senderId;
          if (!target || !isQq(target)) {
            results.push(`${label}失败：QQ 号 ${target ?? '（空）'} 看起来不对。`);
            break;
          }
          const blocked = protectedTarget(ctx, target);
          if (blocked) {
            results.push(`${label}失败：${blocked}`);
            break;
          }
          const sec = clampInt(act.seconds ?? DEFAULT_BAN_SEC, 0, MAX_BAN_SEC);
          await ctx.client.setGroupBan(ctx.msg.targetId, target, sec);
          ctx.note(`标签禁言 ${target} ${sec}s`);
          results.push(sec === 0 ? `已解除 ${target} 的禁言。` : `已禁言 ${target}，${sec} 秒。`);
          break;
        }
        case 'unban': {
          const target = act.userId ?? '';
          if (!target || !isQq(target)) {
            results.push(`${label}失败：QQ 号 ${target || '（空）'} 看起来不对。`);
            break;
          }
          await ctx.client.setGroupBan(ctx.msg.targetId, target, 0);
          ctx.note(`标签解禁 ${target}`);
          results.push(`已解除 ${target} 的禁言。`);
          break;
        }
        case 'whole_ban':
        case 'whole_unban': {
          const enable = act.kind === 'whole_ban' ? true : false;
          await ctx.client.setGroupWholeBan(ctx.msg.targetId, enable);
          ctx.note(`标签全员禁言 ${enable ? '开' : '关'}`);
          results.push(enable ? '已开启全员禁言。' : '已解除全员禁言。');
          break;
        }
        case 'kick':
        case 'kick_black': {
          const target = act.userId ?? '';
          if (!target || !isQq(target)) {
            results.push(`${label}失败：QQ 号 ${target || '（空）'} 看起来不对。`);
            break;
          }
          const blocked = protectedTarget(ctx, target);
          if (blocked) {
            results.push(`${label}失败：${blocked}`);
            break;
          }
          const black = act.kind === 'kick_black';
          await ctx.client.kickGroupMember(ctx.msg.targetId, target, black);
          ctx.note(`标签踢出 ${target}${black ? '（拉黑）' : ''}`);
          results.push(`已把 ${target} 请出群聊${black ? '，并拒绝再次加群' : ''}。`);
          break;
        }
        case 'recall': {
          const mid = act.msgId ?? ctx.msg.messageId;
          if (!mid) {
            results.push(`${label}失败：没有消息 ID。`);
            break;
          }
          await ctx.client.deleteMsg(mid);
          ctx.note(`标签撤回 ${mid}`);
          results.push(`已撤回消息 ${mid}。`);
          break;
        }
        default:
          results.push(`${label}失败：不认识的动作。`);
      }
    } catch (err) {
      log.warn(`标签动作 ${act.kind} 失败：${String(err)}`);
      results.push(`${label}失败：${humanError(err)}`);
    }
  }
  return results;
}
