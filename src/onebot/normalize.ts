// OneBot v11 消息解析：把 SnowLuma 推来的事件洗成统一的 NormalizedMessage。
// 三大模块只认 NormalizedMessage，不直接碰 OneBot 原始结构。
import type { OneBotEvent, NormalizedMessage, Segment } from '../core/types.ts';

function segList(message: unknown): Segment[] {
  if (Array.isArray(message)) return message as Segment[];
  return [];
}

function segText(message: unknown | null | undefined): string {
  if (typeof message === 'string') return message;
  if (!message) return '';
  const segs = segList(message);
  let out = '';
  for (const s of segs) {
    const d = s?.data ?? {};
    switch (s?.type) {
      case 'text': out += String(d.text ?? ''); break;
      case 'at': out += `[at:${String(d.qq ?? '')}]`; break;
      case 'reply': out += `[reply:${String(d.id ?? '')}]`; break;
      case 'image': out += `[img:${String(d.url ?? d.file ?? '')}]`; break;
      case 'face': out += `[face:${String(d.id ?? '')}]`; break;
      case 'record': out += '[voice]'; break;
      case 'json': out += '[card]'; break;
      default: break;
    }
  }
  return out;
}

export function isSelfMessage(ev: OneBotEvent, selfIds: string[]): boolean {
  const uid = String(ev.user_id ?? '');
  return selfIds.includes(uid);
}

/** 群名片 > 昵称 > QQ 号；空白字符（含零宽空格）一律当没有 */
function pickName(card?: string, nickname?: string, fallback = ''): string {
  for (const v of [card, nickname]) {
    const t = String(v ?? '').replace(/[\u200b-\u200f\u2060\ufeff\s]/g, '').trim();
    if (t) return t;
  }
  return fallback || '某人';
}

export function normalize(ev: OneBotEvent, selfIds: string[]): NormalizedMessage | null {
  if (ev.post_type !== 'message') return null;
  if (ev.message_type !== 'group' && ev.message_type !== 'private') return null;

  const segs = segList(ev.message);
  const rawText = typeof ev.message === 'string'
    ? ev.message
    : segText(ev.message);
  let text = rawText;

  // 拆出 @ 与回复
  const atOthers: string[] = [];
  let atSelf = false;
  let replyTo: string | null = null;
  const images: string[] = [];
  const imageFiles: string[] = [];

  /** @ 段在正文里的占位：@全体 直接写名字，@自己 不写（触发信息里已经有了） */
  const atMark = (id: string): string => {
    if (!id) return '';
    if (id === 'all') return '@全体成员';
    if (selfIds.includes(id)) return '';
    return `[at:${id}]`;
  };

  const pushAt = (id: string): void => {
    if (!id) return;
    if (selfIds.includes(id)) atSelf = true;
    else atOthers.push(id);
  };

  if (Array.isArray(ev.message)) {
    // 一趟走完：按原顺序拼正文（文本照抄，@ 留下 [at:qq] 占位），顺手收集 @/回复/图片
    const parts: string[] = [];
    for (const s of segs) {
      const d = (s?.data ?? {}) as Record<string, unknown>;
      if (s?.type === 'text') { parts.push(String(d.text ?? '')); continue; }
      if (s?.type === 'at') { const id = String(d.qq ?? ''); pushAt(id); parts.push(atMark(id)); continue; }
      if (s?.type === 'reply') { replyTo = String(d.id ?? ''); continue; }
      if (s?.type === 'image') {
        const url = String(d.url ?? d.file ?? '');
        if (url) {
          images.push(url);
          imageFiles.push(String(d.file ?? ''));
        }
        continue;
      }
      if (s?.type === 'face') parts.push('[表情]');
      else if (s?.type === 'record') parts.push('[语音]');
    }
    text = parts.join('').trim();
  } else {
    // 字符串形式：解析 [CQ:at,...] [CQ:reply,...] [CQ:image,...]
    const cqRe = /\[CQ:(\w+)(?:,([^\]]*))?\]/g;
    let m: RegExpExecArray | null;
    while ((m = cqRe.exec(String(ev.message ?? ''))) !== null) {
      const [, type, dataStr] = m;
      const d: Record<string, string> = {};
      if (dataStr) {
        for (const kv of dataStr.split(',')) {
          const i = kv.indexOf('=');
          if (i > 0) d[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
        }
      }
      if (type === 'at') pushAt(String(d.qq ?? ''));
      else if (type === 'reply') replyTo = String(d.id ?? '');
      else if (type === 'image' && (d.url || d.file)) {
        images.push(String(d.url ?? d.file));
        imageFiles.push(String(d.file ?? ''));
      }
    }
    text = String(ev.message ?? '').replace(cqRe, (whole: string, type: string, dataStr?: string) => {
      if (type !== 'at') return '';
      const qq = String(dataStr ?? '')
        .split(',')
        .map((kv) => kv.trim())
        .find((kv) => kv.startsWith('qq='));
      return atMark(qq ? qq.slice(3) : '');
    }).trim();
  }

  const sender = ev.sender ?? ev.message_sender ?? {};
  const senderId = String(ev.user_id ?? sender.user_id ?? '');
  const groupId = String(ev.group_id ?? '');
  const type = ev.message_type;
  const targetId = type === 'group' ? groupId : senderId;
  if (!senderId || !targetId) return null;

  const sessionKey = type === 'group' ? `g:${groupId}` : `p:${senderId}`;
  const sessionName = type === 'group' ? `群 ${groupId}` : `好友 ${senderId}`;

  return {
    sessionKey, type, targetId, sessionName,
    senderId,
    senderName: pickName(sender.card, sender.nickname, senderId),
    senderRole: String(sender.role ?? 'member'),
    // 群头衔不保证在消息事件里带，没有就空串，后面再问一次协议端补上
    senderTitle: String(sender.title ?? ''),
    messageId: String(ev.message_id ?? ''),
    text,
    images,
    imageFiles,
    atSelf,
    atOthers,
    replyTo,
    quotedText: null,
    raw: ev,
    time: Number(ev.time ?? Math.floor(Date.now() / 1000)),
  };
}
