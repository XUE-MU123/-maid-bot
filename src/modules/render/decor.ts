// 柚子的小装饰：鲸鱼尾巴、气泡、星星、波浪。
// 全部用纯 canvas 画，不依赖 emoji 字体，深色浅色底都能用。
import type { SKRSContext2D } from '@napi-rs/canvas';

/**
 * 鲸鱼尾巴：两片饱满的叶子 + 中间凹口 + 尾柄，带一点渐变立体感。
 * 这是柚子的标志物，画得圆润一点才像鲸鱼，不是剪刀。
 */
export function drawWhaleTail(
  ctx: SKRSContext2D, cx: number, cy: number, size: number,
  color: string, alpha = 1,
): void {
  const w = size * 0.95;
  const h = size;
  ctx.save();
  ctx.globalAlpha = alpha;

  const grad = ctx.createLinearGradient(cx, cy - h * 1.1, cx, cy + size * 0.15);
  grad.addColorStop(0, color);
  grad.addColorStop(1, shade(color, -0.35));
  ctx.fillStyle = grad;

  // 叶片主体
  ctx.beginPath();
  ctx.moveTo(cx, cy + size * 0.12);
  // 左叶外缘
  ctx.bezierCurveTo(cx - w * 0.34, cy + size * 0.02, cx - w * 0.92, cy - h * 0.28, cx - w * 1.02, cy - h * 0.82);
  // 左叶尖回到中间凹口
  ctx.bezierCurveTo(cx - w * 0.72, cy - h * 1.04, cx - w * 0.34, cy - h * 0.74, cx, cy - h * 0.40);
  // 右叶
  ctx.bezierCurveTo(cx + w * 0.34, cy - h * 0.74, cx + w * 0.72, cy - h * 1.04, cx + w * 1.02, cy - h * 0.82);
  ctx.bezierCurveTo(cx + w * 0.92, cy - h * 0.28, cx + w * 0.34, cy + size * 0.02, cx, cy + size * 0.12);
  ctx.closePath();
  ctx.fill();

  // 尾柄（短短一截，让它看起来连着身体）
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.10, cy + size * 0.06);
  ctx.quadraticCurveTo(cx, cy + size * 0.30, cx + size * 0.10, cy + size * 0.06);
  ctx.quadraticCurveTo(cx, cy + size * 0.16, cx - size * 0.10, cy + size * 0.06);
  ctx.closePath();
  ctx.fill();

  // 叶片上的一道高光，立体一点
  ctx.globalAlpha = alpha * 0.35;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(1, size * 0.05);
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.18, cy - h * 0.30);
  ctx.quadraticCurveTo(cx - w * 0.55, cy - h * 0.55, cx - w * 0.78, cy - h * 0.80);
  ctx.stroke();
  ctx.restore();
}

/** 颜色变亮/变暗：amt>0 变亮，<0 变暗 */
function shade(hex: string, amt: number): string {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amt)));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amt)));
  const b = Math.max(0, Math.min(255, (num & 0xff) + Math.round(255 * amt)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** 圆气泡：半透明圆 + 左上高光，像水里的泡泡 */
export function drawBubble(
  ctx: SKRSContext2D, cx: number, cy: number, r: number,
  color: string, alpha = 0.22,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = Math.min(1, alpha * 2.2);
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(cx - r * 0.32, cy - r * 0.34, Math.max(1.2, r * 0.22), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 四角星（柚子的星空眼瞳） */
export function drawSpark(ctx: SKRSContext2D, cx: number, cy: number, r: number, color: string, alpha = 0.9): void {
  const w = r * 0.22;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + w, cy - w, cx + r, cy);
  ctx.quadraticCurveTo(cx + w, cy + w, cx, cy + r);
  ctx.quadraticCurveTo(cx - w, cy + w, cx - r, cy);
  ctx.quadraticCurveTo(cx - w, cy - w, cx, cy - r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 底部波浪带（海面感） */
export function drawWaveBand(
  ctx: SKRSContext2D, width: number, y: number, height: number,
  color: string, alpha = 0.18,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, y);
  const steps = 8;
  const seg = width / steps;
  for (let i = 0; i < steps; i++) {
    const x0 = i * seg;
    ctx.quadraticCurveTo(x0 + seg * 0.25, y - height * 0.9, x0 + seg * 0.5, y);
    ctx.quadraticCurveTo(x0 + seg * 0.75, y + height * 0.9, x0 + seg, y);
  }
  ctx.lineTo(width, y + height * 3);
  ctx.lineTo(0, y + height * 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 蕾丝花边：一排小半圆，模拟女仆裙边 */
export function drawLaceEdge(
  ctx: SKRSContext2D, x0: number, x1: number, y: number,
  count: number, color: string, alpha = 0.85,
): void {
  const step = (x1 - x0) / count;
  const r = step / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, r * 0.18);
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const cx = x0 + step * i + r;
    ctx.moveTo(cx - r, y);
    ctx.arc(cx, y, r, Math.PI, 0, false);
  }
  ctx.stroke();
  ctx.restore();
}

/** 随机散点（星星 + 气泡），用固定种子保证每次画一样 */
export function scatterDecor(
  ctx: SKRSContext2D, width: number, height: number,
  opts: { stars?: number; bubbles?: number; starColor: string; bubbleColor: string; seed?: number },
): void {
  let seed = opts.seed ?? 20261028;
  const rnd = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const stars = opts.stars ?? 22;
  for (let i = 0; i < stars; i++) {
    const x = rnd() * width;
    const y = rnd() * height;
    const r = 2 + rnd() * 5;
    drawSpark(ctx, x, y, r, opts.starColor, 0.15 + rnd() * 0.5);
  }
  const bubbles = opts.bubbles ?? 10;
  for (let i = 0; i < bubbles; i++) {
    const x = rnd() * width;
    const y = rnd() * height;
    const r = 6 + rnd() * 18;
    drawBubble(ctx, x, y, r, opts.bubbleColor, 0.08 + rnd() * 0.12);
  }
}

/**
 * 整只小鲸鱼：水滴身体 + 尾巴 + 眼睛 + 鳍 + 喷水花。
 * 头朝右，size 大约等于身长的 0.5 倍，方便嵌在角落。
 */
export function drawWhale(
  ctx: SKRSContext2D, cx: number, cy: number, size: number,
  color: string, alpha = 1,
): void {
  const s = size;
  ctx.save();
  ctx.globalAlpha = alpha;

  const bodyGrad = ctx.createLinearGradient(cx, cy - s * 0.55, cx, cy + s * 0.45);
  bodyGrad.addColorStop(0, shade(color, 0.18));
  bodyGrad.addColorStop(1, shade(color, -0.22));

  // 尾巴（画在身体下层，左后侧）
  const tailX = cx - s * 0.50;
  const tailY = cy + s * 0.02;
  ctx.save();
  ctx.translate(tailX, tailY);
  ctx.rotate(-0.45);
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-s * 0.18, -s * 0.05, -s * 0.42, -s * 0.22, -s * 0.50, -s * 0.42);
  ctx.bezierCurveTo(-s * 0.30, -s * 0.40, -s * 0.12, -s * 0.24, 0, -s * 0.10);
  ctx.bezierCurveTo(s * 0.12, -s * 0.24, s * 0.30, -s * 0.40, s * 0.50, -s * 0.42);
  ctx.bezierCurveTo(s * 0.42, -s * 0.22, s * 0.18, -s * 0.05, 0, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 身体：圆头 + 收窄的尾根
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.62, cy + s * 0.02);
  ctx.bezierCurveTo(cx - s * 0.30, cy - s * 0.52, cx + s * 0.42, cy - s * 0.62, cx + s * 0.62, cy - s * 0.02);
  ctx.bezierCurveTo(cx + s * 0.72, cy + s * 0.34, cx + s * 0.20, cy + s * 0.52, cx - s * 0.10, cy + s * 0.34);
  ctx.bezierCurveTo(cx - s * 0.34, cy + s * 0.20, cx - s * 0.52, cy + s * 0.14, cx - s * 0.62, cy + s * 0.02);
  ctx.closePath();
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 肚子浅色
  ctx.save();
  ctx.globalAlpha = alpha * 0.55;
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.42, cy + s * 0.18);
  ctx.bezierCurveTo(cx - s * 0.05, cy + s * 0.50, cx + s * 0.38, cy + s * 0.34, cx + s * 0.48, cy + s * 0.06);
  ctx.bezierCurveTo(cx + s * 0.20, cy + s * 0.30, cx - s * 0.15, cy + s * 0.34, cx - s * 0.42, cy + s * 0.18);
  ctx.closePath();
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();

  // 小鳍
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.02, cy + s * 0.30);
  ctx.quadraticCurveTo(cx - s * 0.16, cy + s * 0.52, cx - s * 0.30, cy + s * 0.30);
  ctx.quadraticCurveTo(cx - s * 0.12, cy + s * 0.26, cx + s * 0.02, cy + s * 0.30);
  ctx.closePath();
  ctx.fillStyle = shade(color, -0.15);
  ctx.fill();

  // 眼睛
  const eyeX = cx + s * 0.34;
  const eyeY = cy - s * 0.10;
  ctx.beginPath();
  ctx.arc(eyeX, eyeY, s * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(eyeX + s * 0.015, eyeY + s * 0.01, s * 0.055, 0, Math.PI * 2);
  ctx.fillStyle = '#0B1120';
  ctx.fill();
  // 眼睛高光
  ctx.beginPath();
  ctx.arc(eyeX - s * 0.01, eyeY - s * 0.02, s * 0.018, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();

  // 腮红（可爱一点）
  ctx.save();
  ctx.globalAlpha = alpha * 0.35;
  ctx.beginPath();
  ctx.ellipse(eyeX + s * 0.02, eyeY + s * 0.20, s * 0.055, s * 0.035, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#FB7185';
  ctx.fill();
  ctx.restore();

  // 喷水花
  ctx.save();
  ctx.globalAlpha = alpha * 0.85;
  ctx.strokeStyle = shade(color, 0.35);
  ctx.lineWidth = Math.max(1.5, s * 0.035);
  ctx.lineCap = 'round';
  // 头顶喷出的水珠
  const drops: Array<[number, number, number]> = [
    [0.30, -0.60, 0.055], [0.22, -0.74, 0.042], [0.38, -0.76, 0.036],
    [0.30, -0.90, 0.028], [0.16, -0.62, 0.026],
  ];
  ctx.fillStyle = shade(color, 0.42);
  for (const [dx, dy, r] of drops) {
    ctx.beginPath();
    ctx.arc(cx + s * dx, cy + s * dy, s * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.restore();
}
