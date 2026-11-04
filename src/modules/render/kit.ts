// 画板基础层：字体、颜色、圆角、阴影、文字测量与换行。
// 目标是把 Java 那份安卓 Canvas 代码里的常用画法搬过来，且比它更稳。
import { GlobalFonts, createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';

let fontReady = false;

/** 服务器上现成的中文字体；找不到就退回系统默认，不让画图整个失败 */
const FONT_CANDIDATES = [
  // 思源黑体系列（现代黑体，字形比安卓 Droid 精致很多）
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'SourceHanSans'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'SourceHanSansBold'],
  // 思源宋体（衬线，想要“文雅”风格时用）
  ['/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', 'SourceHanSerif'],
  ['/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc', 'SourceHanSerifBold'],
  ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', 'Droid'],
  // 彩色 emoji：㊗️ 🍉 这种字符没有它就会画成方块
  ['/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', 'NotoEmoji'],
  ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 'Noto'],
  ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 'WQY'],
];

export function ensureFonts(): void {
  if (fontReady) return;
  fontReady = true;
  for (const [path, alias] of FONT_CANDIDATES) {
    try {
      if (existsSync(path)) GlobalFonts.registerFromPath(path, alias);
    } catch {
      /* 这个字体装不上就试下一个 */
    }
  }
}

/** 统一字体栈：先中文字体，再兜底 */
// 老大选的思源宋体：衬线字，庄重、有书卷气
export const FONT_STACK = 'SourceHanSerif, SourceHanSans, Noto, Droid, WQY, serif';
/** 表格/绘图可选的字体族 */
export const FONT_FAMILIES = {
  sans: 'SourceHanSans, Noto, Droid, WQY, sans-serif',
  serif: 'SourceHanSerif, SourceHanSans, Noto, Droid, serif',
} as const;
export type FontFamily = keyof typeof FONT_FAMILIES;
/** emoji 专用字体：只在遇到 emoji 字符时局部使用，不进主栈 */
export const EMOJI_FONT = 'NotoEmoji';

export function font(size: number, bold = false): string {
  return `${bold ? 'bold ' : ''}${Math.max(1, Math.round(size))}px ${FONT_STACK}`;
}

// ---------- 颜色 ----------

const NAMED: Record<string, string> = {
  white: '#FFFFFF', black: '#000000', red: '#FF3B30', green: '#34C759',
  blue: '#0A84FF', yellow: '#FFCC00', orange: '#FF9500', purple: '#AF52DE',
  pink: '#FF2D55', gray: '#8E8E93', grey: '#8E8E93', cyan: '#32ADE6',
  teal: '#30B0C7', brown: '#A2845E', gold: '#FFD700', silver: '#C0C0C0',
};

/**
 * 解析 #RRGGBB / #AARRGGBB / rgb() / rgba() / 色名。
 * 返回 CSS 颜色字符串；透明度用 rgba 表达（Canvas 不认 #AARRGGBB）。
 */
export function parseColor(input: unknown, fallback = '#000000'): string {
  if (input === null || input === undefined) return fallback;
  let s = String(input).trim();
  if (!s) return fallback;
  const lower = s.toLowerCase();
  if (NAMED[lower]) return NAMED[lower];

  if (s.startsWith('#')) {
    s = s.slice(1);
    if (s.length === 8) {
      // #AARRGGBB（安卓习惯）→ rgba()
      const a = parseInt(s.slice(0, 2), 16);
      const r = parseInt(s.slice(2, 4), 16);
      const g = parseInt(s.slice(4, 6), 16);
      const b = parseInt(s.slice(6, 8), 16);
      return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
    }
    if (s.length === 6) return `#${s}`;
    if (s.length === 3) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
    return fallback;
  }

  if (/^rgba?\(/i.test(s)) return s;
  return lower in NAMED ? NAMED[lower] : fallback;
}

// ---------- 画布 ----------

export function newCanvas(width: number, height: number): { canvas: Canvas; ctx: SKRSContext2D } {
  ensureFonts();
  // 上限放到 8192：好感排行榜这种几十行的表，4096 会把底部切掉
  const w = Math.max(16, Math.min(8192, Math.round(width)));
  const h = Math.max(16, Math.min(8192, Math.round(height)));
  const canvas = createCanvas(w, h) as Canvas;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'middle';
  return { canvas, ctx };
}

/** 圆角矩形路径（iOS 那种圆角，Canvas 自带 roundRect 但它兼容性看版本，这里自己画） */
export function roundRectPath(
  ctx: SKRSContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export interface ShadowOpts {
  color?: string;
  blur?: number;
  offsetX?: number;
  offsetY?: number;
}

export function withShadow(ctx: SKRSContext2D, opts: ShadowOpts | undefined, draw: () => void): void {
  if (!opts) { draw(); return; }
  ctx.save();
  ctx.shadowColor = opts.color ?? 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = opts.blur ?? 24;
  ctx.shadowOffsetX = opts.offsetX ?? 0;
  ctx.shadowOffsetY = opts.offsetY ?? 8;
  draw();
  ctx.restore();
}

// ---------- 文字 ----------

export function measure(ctx: SKRSContext2D, text: string, f: string): number {
  ctx.font = f;
  return ctx.measureText(text).width;
}

/**
 * 按像素宽度折行（中英文混排都能断）。
 * 优先在空格/标点处断，实在不行才硬切。
 */
export function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, f: string): string[] {
  ctx.font = f;
  // 容差：正好装满时不要折行（否则 10 位 QQ 号会被劈成两行）
  const limit = maxWidth + 2;
  const out: string[] = [];
  const paragraphs = String(text ?? '').split('\n');
  for (const para of paragraphs) {
    if (!para) { out.push(''); continue; }
    if (ctx.measureText(para).width <= limit) { out.push(para); continue; }
    // 闭合标点不能出现在行首（），。！？：；】」』 这些），要跟着上一行走
    const NO_LINE_START = /^[）】」』，。、；：！？,.;:!?%）]$/;
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (ctx.measureText(next).width > limit && line) {
        if (NO_LINE_START.test(ch)) {
          // 宁可让这一行超一点点，也不让标点孤零零掉到下一行
          out.push(next);
          line = '';
          continue;
        }
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/** 居中画一行字 */
export function drawTextCentered(
  ctx: SKRSContext2D, text: string, cx: number, cy: number,
  f: string, color: string, outline?: { color: string; width: number },
): void {
  ctx.font = f;
  ctx.textAlign = 'center';
  if (outline && outline.width > 0) {
    ctx.lineWidth = outline.width;
    ctx.strokeStyle = outline.color;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, cx, cy);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  ctx.textAlign = 'left';
}

/** 画一段带描边的路径 */
export function strokePath(
  ctx: SKRSContext2D, build: () => void,
  color: string, width: number, dash?: boolean,
): void {
  ctx.save();
  ctx.beginPath();
  build();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, width);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (dash) ctx.setLineDash([width * 3, width * 2]);
  ctx.stroke();
  ctx.restore();
}

/** 判断一个字符是不是需要 emoji 字体来画 */
const EMOJI_RE = /\p{Extended_Pictographic}|[\u2600-\u27BF]|[0-9]\uFE0F?\u20E3/gu;

export function hasEmoji(text: string): boolean {
  EMOJI_RE.lastIndex = 0;
  const r = EMOJI_RE.test(text);
  EMOJI_RE.lastIndex = 0;
  return r;
}

/**
 * 中英数和 emoji 混排：emoji 用彩色字体单独画，其余用普通字体。
 * 这样数字不会变成全角宽度的 emoji 数字。
 */
export function drawMixedText(
  ctx: SKRSContext2D, text: string, x: number, y: number,
  f: string, emojiSize: number, color: string,
  align: 'left' | 'center' | 'right' = 'left',
): void {
  const parts: Array<{ s: string; emoji: boolean }> = [];
  EMOJI_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOJI_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ s: text.slice(last, m.index), emoji: false });
    parts.push({ s: m[0], emoji: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ s: text.slice(last), emoji: false });

  // 先量总宽（emoji 按 emojiSize 算）
  let total = 0;
  const widths: number[] = [];
  for (const p of parts) {
    ctx.font = p.emoji ? `${emojiSize}px ${EMOJI_FONT}` : f;
    const w = ctx.measureText(p.s).width;
    widths.push(w);
    total += w;
  }
  let cursor = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    ctx.font = p.emoji ? `${emojiSize}px ${EMOJI_FONT}` : f;
    ctx.fillStyle = p.emoji ? color : color;
    ctx.fillText(p.s, cursor, y);
    cursor += widths[i];
  }
}
