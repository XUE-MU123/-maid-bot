// 小工具：不依赖任何模块，谁都能用。
export function sleep(ms: number): Promise<void> {
  // 不要 unref：等待本身要撑住事件循环，否则主流程会被提前退出
  return new Promise((r) => { setTimeout(r, ms); });
}

export function todayStr(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 粗估 token：中文按 1 字≈0.7 token，英文按 4 字符≈1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 0.7 + other / 4) + 4;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function randInt(min: number, max: number): number {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return a + Math.floor(Math.random() * (b - a + 1));
}

/** 长文切段：优先在句末标点切，不让一条消息太长 */
export function splitText(text: string, maxLen: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const out: string[] = [];
  let rest = t;
  const breaks = ['\n\n', '\n', '。', '！', '？', '；', '…', '. ', '! ', '? ', '，', ','];
  while (rest.length > maxLen) {
    let cut = -1;
    for (const b of breaks) {
      const idx = rest.lastIndexOf(b, maxLen);
      if (idx > maxLen * 0.4 && idx > cut) cut = idx + b.length;
    }
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '****' + key.slice(-4);
}

export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
