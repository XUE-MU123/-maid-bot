// DRAW 2.0 指令引擎：一行一条图元，全部用中心坐标 cx,cy。
// 比原版 Java 多了：颜色透明度统一、圆角自动收敛、文字换行、失败不炸整张图。
import { loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  font, measure, newCanvas, parseColor, roundRectPath, wrapText,
} from './kit.ts';
import { drawChart } from './charts.ts';

const FILL_STYLES = new Set(['F', 'S']);

/** 带文字/文字的图元：放在最后一层画，永远不会被框盖住 */
const TEXT_CMDS = new Set(['T', 'TB', 'TAG', 'PROGRESS', 'BUBBLE', 'STAMP']);

interface Tok {
  raw: string;
  /** 去掉引号后的内容，用于文字参数 */
  text: string;
  quoted: boolean;
}

/** 空格分词，但引号里的空格不切 */
function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = line;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const ch = s[i];
    if (ch === '"' || ch === '“' || ch === '”') {
      const close = ch === '"' ? '"' : '”';
      i++;
      let buf = '';
      while (i < s.length && s[i] !== close && s[i] !== '"') { buf += s[i]; i++; }
      i++;
      out.push({ raw: buf, text: buf, quoted: true });
      continue;
    }
    let buf = '';
    while (i < s.length && !/\s/.test(s[i])) { buf += s[i]; i++; }
    // 只有真引号里的才算「文字」；颜色/数字都不是
    out.push({ raw: buf, text: buf, quoted: false });
  }
  return out;
}

interface Pair { x: number; y: number }

function parsePair(t: Tok | undefined): Pair | null {
  if (!t) return null;
  const m = t.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function isColorTok(t: Tok | undefined): boolean {
  if (!t || t.raw === '') return false;
  const v = t.raw;
  return /^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/i.test(v) || /^[a-zA-Z]{3,20}$/.test(v);
}

function num(t: Tok | undefined): number | null {
  if (!t) return null;
  const n = Number(t.raw);
  return Number.isFinite(n) ? n : null;
}

function pairList(toks: Tok[]): Pair[] {
  const out: Pair[] = [];
  for (const t of toks) {
    const p = parsePair(t);
    if (p) out.push(p);
  }
  return out;
}

export interface DrawAssets {
  /** qq://123456 → 头像地址 */
  avatar?: (qq: string) => Promise<Image | null>;
  /** 贴图地址/本地路径 → 图片 */
  image?: (src: string) => Promise<Image | null>;
}

export interface DrawResult {
  png: Buffer;
  width: number;
  height: number;
  /** 没能画出来的图元（便于日志） */
  failed: string[];
}

/** 把 draw 代码块画成 PNG */
export async function renderDraw(code: string, assets: DrawAssets = {}): Promise<DrawResult> {
  const rawLines = String(code ?? '').split('\n').map((l) => l.trim());
  const lines = rawLines.filter((l) => l && !l.startsWith('//') && !l.startsWith('#!') && !l.startsWith('```'));
  if (!lines.length) throw new Error('绘图指令为空');

  let W = 2400;
  let H = 2400;
  let bg1 = '#FFFFFF';
  let bg2 = '';
  let bgDir = 'V';
  let idx = 0;

  if (lines[0].startsWith('@')) {
    const toks = tokenize(lines[0].slice(1));
    const size = toks[0]?.raw.match(/^(\d+)[xX*×](\d+)$/);
    if (size) { W = parseInt(size[1], 10); H = parseInt(size[2], 10); }
    if (toks[1] && isColorTok(toks[1])) bg1 = parseColor(toks[1].raw, '#FFFFFF');
    if (toks[2] && isColorTok(toks[2])) bg2 = parseColor(toks[2].raw, bg1);
    if (toks[3] && /^[VHDR]$/i.test(toks[3].raw)) bgDir = toks[3].raw.toUpperCase();
    idx = 1;
  }
  // 尺寸交给模型自己定，这里只做安全兜底：
  // 太小看不清、太大 QQ 会裁且上传慢。超限时整体等比缩放，坐标空间不变，
  // 所以模型按 @宽x高 算的坐标不会跑出画布，也不会被拉歪。
  const MAX_SIDE = 4096;
  const MIN_SIDE = 200;
  const longest = Math.max(W, H);
  const shortest = Math.min(W, H);
  let fit = 1;
  if (longest > MAX_SIDE) fit = MAX_SIDE / longest;
  else if (shortest < MIN_SIDE) fit = MIN_SIDE / shortest;
  const cw = Math.max(MIN_SIDE, Math.round(W * fit));
  const ch = Math.max(MIN_SIDE, Math.round(H * fit));

  const { canvas, ctx } = newCanvas(cw, ch);

  // 背景（按画布尺寸铺满）
  if (bg2) {
    const g = bgDir === 'H' ? ctx.createLinearGradient(0, 0, cw, 0)
      : bgDir === 'D' ? ctx.createLinearGradient(0, 0, cw, ch)
        : bgDir === 'R' ? ctx.createRadialGradient(cw / 2, ch / 2, 10, cw / 2, ch / 2, Math.max(cw, ch) / 1.4)
          : ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, bg1);
    g.addColorStop(1, bg2);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg1;
  }
  ctx.fillRect(0, 0, cw, ch);

  // 等比缩过的图：把坐标系缩放回模型给的那套，图元坐标照旧
  if (fit !== 1) ctx.scale(fit, fit);

  const failed: string[] = [];

  // 分两层画：先铺形状/图片，再压文字。
  // 模型经常把文字写在框前面，单层顺序画的话字就被框盖住了。
  const shapeLines: string[] = [];
  const textLines: string[] = [];
  for (let i = idx; i < lines.length; i++) {
    const cmd = tokenize(lines[i])[0]?.raw.toUpperCase() ?? '';
    (TEXT_CMDS.has(cmd) ? textLines : shapeLines).push(lines[i]);
  }
  for (const line of [...shapeLines, ...textLines]) {
    try {
      await drawElement(ctx, line, W, H, assets);
    } catch (err) {
      failed.push(`${line} → ${String((err as Error)?.message ?? err)}`);
    }
  }

  return { png: canvas.toBuffer('image/png'), width: cw, height: ch, failed };
}

async function drawElement(
  ctx: SKRSContext2D, line: string, W: number, H: number, assets: DrawAssets,
): Promise<void> {
  const toks = tokenize(line);
  if (!toks.length) return;
  const cmd = toks[0].raw.toUpperCase();
  const rest = toks.slice(1);

  switch (cmd) {
    case 'BG': return drawBg(ctx, rest, W, H);
    case 'R': return drawRect(ctx, rest, 0);
    case 'RR': return drawRect(ctx, rest, 1);
    case 'C': return drawCircle(ctx, rest);
    case 'RING': return drawRing(ctx, rest);
    case 'E': return drawEllipse(ctx, rest);
    case 'REGPOLY': return drawRegPoly(ctx, rest);
    case 'DIAMOND': return drawDiamond(ctx, rest);
    case 'P': return drawPolygon(ctx, rest);
    case 'LG': return drawLinearGradientBox(ctx, rest);
    case 'RG': return drawRadialGradientCircle(ctx, rest);
    case 'L': return drawLine(ctx, rest, false);
    case 'AR': return drawLine(ctx, rest, true);
    case 'Q': return drawQuad(ctx, rest);
    case 'B': return drawCubic(ctx, rest);
    case 'A': return drawArc(ctx, rest);
    case 'W': return drawWave(ctx, rest);
    case 'D': return drawSvgPath(ctx, rest);
    case 'HEART': return drawHeart(ctx, rest);
    case 'STAR': return drawStar(ctx, rest);
    case 'SPARKLE': return drawSparkle(ctx, rest);
    case 'CLOUD': return drawCloud(ctx, rest);
    case 'T': return drawText(ctx, rest);
    case 'TB': return drawTextBox(ctx, rest);
    case 'TAG': return drawTag(ctx, rest);
    case 'PROGRESS': return drawProgress(ctx, rest);
    case 'BUBBLE': return drawBubble(ctx, rest);
    case 'STAMP': return drawStamp(ctx, rest);
    case 'AVATAR': return drawAvatar(ctx, rest, assets);
    case 'I': return drawImageEl(ctx, rest, assets);
    default:
      if (drawChart(ctx, cmd, rest)) return;
      throw new Error(`未知图元 ${cmd}`);
  }
}

// ---------- 背景与基础形状 ----------

function drawBg(ctx: SKRSContext2D, rest: Tok[], W: number, H: number): void {
  const c1 = parseColor(rest[0]?.raw, '#FFFFFF');
  const c2 = rest[1] && isColorTok(rest[1]) ? parseColor(rest[1].raw, c1) : '';
  const dir = rest.find((t) => /^[VHDR]$/i.test(t.raw))?.raw.toUpperCase() ?? 'V';
  if (!c2) { ctx.fillStyle = c1; ctx.fillRect(0, 0, W, H); return; }
  const g = dir === 'H' ? ctx.createLinearGradient(0, 0, W, 0)
    : dir === 'D' ? ctx.createLinearGradient(0, 0, W, H)
      : dir === 'R' ? ctx.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) / 1.4)
        : ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** 找「填充/描边」标记 + 颜色 + 线宽 */
function styleOf(rest: Tok[]): { fill: boolean; stroke: boolean; color: string; lineWidth: number; strokeColor: string | null; shadow: boolean } {
  let fill = true;
  let stroke = false;
  const colors: string[] = [];
  let lineWidth = 0;
  let shadow = false;
  for (const t of rest) {
    const up = t.raw.toUpperCase();
    if (FILL_STYLES.has(up)) { if (up === 'F') fill = true; else { stroke = true; fill = false; } continue; }
    if (up === 'SHADOW') { shadow = true; continue; }
    if (isColorTok(t)) { colors.push(parseColor(t.raw)); continue; }
    const n = Number(t.raw);
    if (Number.isFinite(n) && n > 0) lineWidth = n;
  }
  return {
    fill, stroke,
    color: colors[0] ?? '#000000',
    lineWidth,
    strokeColor: colors[1] ?? null,
    shadow,
  };
}

function applyShadow(ctx: SKRSContext2D, on: boolean): void {
  if (on) {
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 10;
  }
}

function clearShadow(ctx: SKRSContext2D): void {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawRect(ctx: SKRSContext2D, rest: Tok[], rounded: number): void {
  const c = parsePair(rest[0]);
  if (!c) throw new Error('R 缺少中心坐标');
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!size) throw new Error('R 缺少宽高');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const radiusTok = rest.find((t) => /^(r|R)?\d+(\.\d+)?$/.test(t.raw) && Number(t.raw) > 0);
  const radius = rounded ? Math.max(12, radiusTok ? Number(radiusTok.raw) : Math.min(w, h) * 0.16) : 0;
  const st = styleOf(rest);

  applyShadow(ctx, st.shadow);
  roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, radius);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  clearShadow(ctx);
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawCircle(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = num(rest[1]);
  if (!c || r === null) throw new Error('C 参数不全');
  const st = styleOf(rest.slice(2));
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.abs(r), 0, Math.PI * 2);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawRing(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const rr = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !rr) throw new Error('RING 参数不全');
  const rOut = Math.abs(parseFloat(rr[1]));
  const rIn = Math.abs(parseFloat(rr[2]));
  // 内外半径写一样 = 厚度 0 的空环，屏幕上什么都看不到。
  // 这种错很难自己发现，所以直接报出来，别让它悄悄画成空白。
  if (rOut <= rIn) throw new Error(`RING 内半径(${rIn})必须小于外半径(${rOut})，否则是个空环`);
  const st = styleOf(rest.slice(2));
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.abs(rOut), 0, Math.PI * 2);
  ctx.arc(c.x, c.y, Math.abs(rIn), 0, Math.PI * 2, true);
  ctx.fillStyle = st.color;
  ctx.fill('evenodd');
}

function drawEllipse(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const rr = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !rr) throw new Error('E 参数不全');
  const rx = parseFloat(rr[1]);
  const ry = parseFloat(rr[2]);
  const st = styleOf(rest.slice(2));
  const rot = rest.slice(2).find((t) => Number.isFinite(Number(t.raw)) && Number(t.raw) > 0 && Math.abs(Number(t.raw)) > 1);
  ctx.save();
  ctx.translate(c.x, c.y);
  if (rot) ctx.rotate((Number(rot.raw) * Math.PI) / 180);
  ctx.beginPath();
  ctx.ellipse(0, 0, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
  ctx.restore();
}

function polygonPoints(cx: number, cy: number, r: number, sides: number, rotateDeg = -90): Pair[] {
  const pts: Pair[] = [];
  const base = (rotateDeg * Math.PI) / 180;
  for (let i = 0; i < sides; i++) {
    const a = base + (i * Math.PI * 2) / sides;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function fillPoly(ctx: SKRSContext2D, pts: Pair[], close = true): void {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}

function drawRegPoly(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = num(rest[1]);
  const sides = num(rest[2]);
  if (!c || r === null || sides === null) throw new Error('REGPOLY 参数不全');
  const rotTok = rest[3] && Number.isFinite(Number(rest[3].raw)) ? Number(rest[3].raw) : -90;
  const st = styleOf(rest.slice(3));
  fillPoly(ctx, polygonPoints(c.x, c.y, Math.abs(r), Math.round(sides), rotTok));
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawDiamond(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !size) throw new Error('DIAMOND 参数不全');
  const w = parseFloat(size[1]) / 2;
  const h = parseFloat(size[2]) / 2;
  const st = styleOf(rest.slice(2));
  fillPoly(ctx, [
    { x: c.x, y: c.y - h }, { x: c.x + w, y: c.y },
    { x: c.x, y: c.y + h }, { x: c.x - w, y: c.y },
  ]);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawPolygon(ctx: SKRSContext2D, rest: Tok[]): void {
  const pairs: Pair[] = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const p = parsePair(rest[i]);
    if (!p) break;
    pairs.push(p);
  }
  if (pairs.length < 2) throw new Error('P 至少需要两个点');
  const st = styleOf(rest.slice(i));
  fillPoly(ctx, pairs);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawLinearGradientBox(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const colors = rest.filter((t) => isColorTok(t)).map((t) => parseColor(t.raw));
  if (!c || !size || colors.length < 2) throw new Error('LG 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const radiusTok = rest.find((t) => /^\d+(\.\d+)?$/.test(t.raw) && Number(t.raw) > 0);
  const radius = radiusTok ? Number(radiusTok.raw) : Math.min(w, h) * 0.12;
  const dir = rest.find((t) => /^[VHD]$/i.test(t.raw))?.raw.toUpperCase() ?? 'V';
  const g = dir === 'H' ? ctx.createLinearGradient(c.x - w / 2, c.y, c.x + w / 2, c.y)
    : dir === 'D' ? ctx.createLinearGradient(c.x - w / 2, c.y - h / 2, c.x + w / 2, c.y + h / 2)
      : ctx.createLinearGradient(c.x, c.y - h / 2, c.x, c.y + h / 2);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, radius);
  ctx.fillStyle = g;
  ctx.fill();
}

function drawRadialGradientCircle(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = num(rest[1]);
  const colors = rest.filter((t) => isColorTok(t)).map((t) => parseColor(t.raw));
  if (!c || r === null || colors.length < 2) throw new Error('RG 参数不全');
  const g = ctx.createRadialGradient(c.x, c.y, 1, c.x, c.y, Math.abs(r));
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.abs(r), 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
}

// ---------- 线条与曲线 ----------

function drawLine(ctx: SKRSContext2D, rest: Tok[], arrow: boolean): void {
  const p1 = parsePair(rest[0]);
  const p2 = parsePair(rest[1]);
  if (!p1 || !p2) throw new Error('L/AR 需要两个点');
  const st = styleOf(rest.slice(2));
  const dash = rest.some((t) => t.raw.toUpperCase() === 'DASH');
  const both = rest.some((t) => t.raw.toUpperCase() === 'BOTH');
  const color = st.color === '#000000' && st.strokeColor ? st.strokeColor : st.color;
  const lw = st.lineWidth || 6;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  if (dash) ctx.setLineDash([lw * 3, lw * 2]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();

  if (arrow) {
    drawArrowHead(ctx, p1, p2, color, lw);
    if (both) drawArrowHead(ctx, p2, p1, color, lw);
  }
}

function drawArrowHead(ctx: SKRSContext2D, from: Pair, to: Pair, color: string, lw: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = Math.max(18, lw * 4.5);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - Math.cos(angle - 0.42) * len, to.y - Math.sin(angle - 0.42) * len);
  ctx.lineTo(to.x - Math.cos(angle + 0.42) * len, to.y - Math.sin(angle + 0.42) * len);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawQuad(ctx: SKRSContext2D, rest: Tok[]): void {
  const p1 = parsePair(rest[0]);
  const cp = parsePair(rest[1]);
  const p2 = parsePair(rest[2]);
  if (!p1 || !cp || !p2) throw new Error('Q 需要 起点/控制点/终点');
  const st = styleOf(rest.slice(3));
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.quadraticCurveTo(cp.x, cp.y, p2.x, p2.y);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  ctx.lineWidth = st.lineWidth || 6;
  ctx.strokeStyle = st.strokeColor ?? st.color;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawCubic(ctx: SKRSContext2D, rest: Tok[]): void {
  const p1 = parsePair(rest[0]);
  const c1 = parsePair(rest[1]);
  const c2 = parsePair(rest[2]);
  const p2 = parsePair(rest[3]);
  if (!p1 || !c1 || !c2 || !p2) throw new Error('B 需要 4 个点');
  const st = styleOf(rest.slice(4));
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  ctx.lineWidth = st.lineWidth || 6;
  ctx.strokeStyle = st.strokeColor ?? st.color;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function drawArc(ctx: SKRSContext2D, rest: Tok[]): void {
  const p1 = parsePair(rest[0]);
  const p2 = parsePair(rest[1]);
  const rr = rest[2]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!p1 || !p2 || !rr) throw new Error('A 参数不全（要 起点x,y 弧心x,y 半径,角度）');
  const r = parseFloat(rr[1]);
  const deg = parseFloat(rr[2]);
  if (!r) throw new Error('A 半径不能是 0');
  // 半径给的和「起点到弧心的实际距离」差太多，弧就会错位（最常见的就是把终点当成弧心）
  const real = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  if (real > 0 && Math.abs(real - Math.abs(r)) > Math.max(8, Math.abs(r) * 0.2)) {
    throw new Error(`A 半径(${Math.abs(r)})和起点到弧心的距离(${real.toFixed(1)})对不上，` +
      '第二对坐标要填弧心，不是终点');
  }
  const st = styleOf(rest.slice(3));
  const start = Math.atan2(p1.y - p2.y, p1.x - p2.x);
  ctx.beginPath();
  ctx.arc(p2.x, p2.y, Math.abs(r), start, start + (deg * Math.PI) / 180);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  ctx.lineWidth = st.lineWidth || 6;
  ctx.strokeStyle = st.strokeColor ?? st.color;
  ctx.stroke();
}

function drawWave(ctx: SKRSContext2D, rest: Tok[]): void {
  const p1 = parsePair(rest[0]);
  const p2 = parsePair(rest[1]);
  const rr = rest[2]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!p1 || !p2 || !rr) throw new Error('W 参数不全');
  const amp = parseFloat(rr[1]);
  const waveLen = Math.max(20, parseFloat(rr[2]));
  const st = styleOf(rest.slice(3));
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(24, Math.round(dist / 6));
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const off = Math.sin((t * dist * Math.PI * 2) / waveLen) * amp;
    const x = p1.x + dx * t + nx * off;
    const y = p1.y + dy * t + ny * off;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineWidth = st.lineWidth || 6;
  ctx.strokeStyle = st.strokeColor ?? st.color;
  ctx.lineCap = 'round';
  ctx.stroke();
}

/** 简易 SVG path：支持 M/L/H/V/C/S/Q/T/A/Z 的常见写法 */
function drawSvgPath(ctx: SKRSContext2D, rest: Tok[]): void {
  const dTok = rest.find((t) => t.quoted) ?? rest[0];
  const d = String(dTok?.text ?? dTok?.raw ?? '');
  if (!d) throw new Error('D 缺少路径');
  const st = styleOf(rest.filter((t) => t !== dTok));
  ctx.beginPath();
  buildSvgPath(ctx, d);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  ctx.lineWidth = st.lineWidth || 6;
  ctx.strokeStyle = st.strokeColor ?? st.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

export function buildSvgPath(ctx: SKRSContext2D, d: string): void {
  const parts = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d+(?:\.\d+)?/g) ?? [];
  let i = 0;
  let cx = 0; let cy = 0;
  let sx = 0; let sy = 0;
  let cmd = '';
  const next = (): number => parseFloat(parts[i++] ?? '0');
  while (i < parts.length) {
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(parts[i])) cmd = parts[i++];
    switch (cmd) {
      case 'M': cx = next(); cy = next(); sx = cx; sy = cy; ctx.moveTo(cx, cy); break;
      case 'm': cx += next(); cy += next(); sx = cx; sy = cy; ctx.moveTo(cx, cy); break;
      case 'L': cx = next(); cy = next(); ctx.lineTo(cx, cy); break;
      case 'l': cx += next(); cy += next(); ctx.lineTo(cx, cy); break;
      case 'H': cx = next(); ctx.lineTo(cx, cy); break;
      case 'h': cx += next(); ctx.lineTo(cx, cy); break;
      case 'V': cy = next(); ctx.lineTo(cx, cy); break;
      case 'v': cy += next(); ctx.lineTo(cx, cy); break;
      case 'C': {
        const x1 = next(); const y1 = next(); const x2 = next(); const y2 = next();
        cx = next(); cy = next();
        ctx.bezierCurveTo(x1, y1, x2, y2, cx, cy);
        break;
      }
      case 'c': {
        const x1 = cx + next(); const y1 = cy + next(); const x2 = cx + next(); const y2 = cy + next();
        cx += next(); cy += next();
        ctx.bezierCurveTo(x1, y1, x2, y2, cx, cy);
        break;
      }
      case 'Q': {
        const x1 = next(); const y1 = next();
        cx = next(); cy = next();
        ctx.quadraticCurveTo(x1, y1, cx, cy);
        break;
      }
      case 'q': {
        const x1 = cx + next(); const y1 = cy + next();
        cx += next(); cy += next();
        ctx.quadraticCurveTo(x1, y1, cx, cy);
        break;
      }
      case 'A': {
        const rx = next(); const ry = next(); const rot = next();
        const large = next(); const sweep = next();
        const x = next(); const y = next();
        void large; void sweep; void rot;
        ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        cx = x; cy = y;
        break;
      }
      case 'Z': case 'z':
        ctx.closePath(); cx = sx; cy = sy; break;
      default:
        i++;
        break;
    }
  }
}

// ---------- 装饰 ----------

function drawHeart(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = num(rest[1]);
  if (!c || size === null) throw new Error('HEART 参数不全');
  const st = styleOf(rest.slice(2));
  const s = Math.abs(size);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y + s * 0.35);
  ctx.bezierCurveTo(c.x - s * 1.1, c.y - s * 0.35, c.x - s * 0.45, c.y - s * 1.0, c.x, c.y - s * 0.35);
  ctx.bezierCurveTo(c.x + s * 0.45, c.y - s * 1.0, c.x + s * 1.1, c.y - s * 0.35, c.x, c.y + s * 0.35);
  ctx.closePath();
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawStar(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const outR = num(rest[1]);
  if (!c || outR === null) throw new Error('STAR 参数不全');
  let innerR = Math.abs(outR) * 0.45;
  let points = 5;
  const rr = rest[2]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (rr) { innerR = parseFloat(rr[1]) || innerR; points = Math.round(parseFloat(rr[2]) || 5); }
  else if (rest[2] && Number.isFinite(Number(rest[2].raw))) {
    const v = Number(rest[2].raw);
    if (v > 2 && v <= 20) points = Math.round(v); else innerR = v;
  }
  const st = styleOf(rest.slice(2));
  const pts: Pair[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 === 0 ? Math.abs(outR) : innerR;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  fillPoly(ctx, pts);
  if (st.fill) { ctx.fillStyle = st.color; ctx.fill(); }
  if (st.lineWidth > 0 || st.stroke) {
    ctx.lineWidth = st.lineWidth || 4;
    ctx.strokeStyle = st.strokeColor ?? st.color;
    ctx.stroke();
  }
}

function drawSparkle(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = num(rest[1]);
  if (!c || size === null) throw new Error('SPARKLE 参数不全');
  const st = styleOf(rest.slice(2));
  const s = Math.abs(size);
  const w = s * 0.22;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y - s);
  ctx.quadraticCurveTo(c.x + w, c.y - w, c.x + s, c.y);
  ctx.quadraticCurveTo(c.x + w, c.y + w, c.x, c.y + s);
  ctx.quadraticCurveTo(c.x - w, c.y + w, c.x - s, c.y);
  ctx.quadraticCurveTo(c.x - w, c.y - w, c.x, c.y - s);
  ctx.closePath();
  ctx.fillStyle = st.color;
  ctx.fill();
}

function drawCloud(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !size) throw new Error('CLOUD 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const st = styleOf(rest.slice(2));
  ctx.beginPath();
  ctx.ellipse(c.x - w * 0.25, c.y + h * 0.08, w * 0.26, h * 0.3, 0, 0, Math.PI * 2);
  ctx.ellipse(c.x + w * 0.02, c.y - h * 0.1, w * 0.3, h * 0.36, 0, 0, Math.PI * 2);
  ctx.ellipse(c.x + w * 0.28, c.y + h * 0.06, w * 0.24, h * 0.28, 0, 0, Math.PI * 2);
  ctx.fillStyle = st.color;
  ctx.fill();
}

// ---------- 文字与组件 ----------

function drawText(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const textTok = rest.find((t) => t.quoted && !/^#[0-9a-fA-F]/.test(t.text));
  if (!c || !textTok) throw new Error('T 参数不全');
  const after = rest.slice(rest.indexOf(textTok) + 1);
  const color = after.find((t) => isColorTok(t))?.raw;
  const sizeTok = after.find((t) => /^\d+(\.\d+)?$/.test(t.raw));
  const size = sizeTok ? Number(sizeTok.raw) : 48;
  const alignTok = after.find((t) => /^[CLR]$/i.test(t.raw))?.raw.toUpperCase() ?? 'C';
  const bold = after.some((t) => t.raw.toUpperCase() === 'B');
  const colors = after.filter((t) => isColorTok(t)).map((t) => parseColor(t.raw));

  ctx.font = font(size, bold);
  ctx.textAlign = alignTok === 'C' ? 'center' : alignTok === 'R' ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  if (colors[1]) {
    ctx.lineWidth = Math.max(2, size * 0.12);
    ctx.strokeStyle = colors[1];
    ctx.lineJoin = 'round';
    ctx.strokeText(textTok.text, c.x, c.y);
  }
  ctx.fillStyle = colors[0] ?? '#000000';
  ctx.fillText(textTok.text, c.x, c.y);
  ctx.textAlign = 'left';
}

function drawTextBox(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const width = num(rest[1]);
  const textTok = rest.find((t) => t.quoted);
  if (!c || width === null || !textTok) throw new Error('TB 参数不全');
  const after = rest.slice(rest.indexOf(textTok) + 1);
  const color = after.find((t) => isColorTok(t))?.raw ?? '#000000';
  const size = Number(after.find((t) => /^\d+(\.\d+)?$/.test(t.raw))?.raw ?? 40);
  const align = after.find((t) => /^[CLR]$/i.test(t.raw))?.raw.toUpperCase() ?? 'C';
  const f = font(size);
  const lines = wrapText(ctx, textTok.text, Math.abs(width), f);
  const lineH = size * 1.45;
  const totalH = lines.length * lineH;
  let y = c.y - totalH / 2 + lineH / 2;
  ctx.font = f;
  ctx.fillStyle = parseColor(color);
  ctx.textAlign = align === 'C' ? 'center' : align === 'R' ? 'right' : 'left';
  for (const line of lines) {
    const x = align === 'C' ? c.x : align === 'R' ? c.x + Math.abs(width) / 2 : c.x - Math.abs(width) / 2;
    ctx.fillText(line, x, y);
    y += lineH;
  }
  ctx.textAlign = 'left';
}

function drawTag(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const textTok = rest.find((t) => t.quoted);
  if (!c || !size || !textTok) throw new Error('TAG 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const after = rest.slice(rest.indexOf(textTok) + 1);
  const colors = after.filter((t) => isColorTok(t)).map((t) => parseColor(t.raw));
  const sizeTok = after.find((t) => /^\d+(\.\d+)?$/.test(t.raw));
  const fontSize = sizeTok ? Number(sizeTok.raw) : Math.round(h * 0.46);
  roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, h / 2);
  ctx.fillStyle = colors[0] ?? '#1565C0';
  ctx.fill();
  if (colors[2]) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = colors[2];
    ctx.stroke();
  }
  ctx.font = font(fontSize, true);
  ctx.fillStyle = colors[1] ?? '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(textTok.text, c.x, c.y + 1);
  ctx.textAlign = 'left';
}

function drawProgress(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const vals = rest[2]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !size || !vals) throw new Error('PROGRESS 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const cur = parseFloat(vals[1]);
  const max = Math.max(1, parseFloat(vals[2]));
  const rest2 = rest.slice(3);
  const color = rest2.find((t) => isColorTok(t))?.raw;
  const label = rest2.find((t) => t.quoted)?.text ?? '';
  const ratio = Math.max(0, Math.min(1, cur / max));

  roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, h / 2);
  ctx.fillStyle = '#E5E7EB';
  ctx.fill();
  if (ratio > 0) {
    ctx.save();
    roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, h / 2);
    ctx.clip();
    ctx.fillStyle = parseColor(color, '#22C55E');
    ctx.fillRect(c.x - w / 2, c.y - h / 2, w * ratio, h);
    ctx.restore();
  }
  if (label) {
    ctx.font = font(Math.round(h * 0.62), true);
    ctx.fillStyle = '#111827';
    ctx.textAlign = 'center';
    ctx.fillText(label, c.x, c.y + 1);
    ctx.textAlign = 'left';
  }
}

function drawBubble(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const tail = parsePair(rest[2]);
  const textTok = rest.find((t, i) => i > 2 && t.quoted);
  if (!c || !size || !textTok) throw new Error('BUBBLE 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const after = rest.slice(rest.indexOf(textTok) + 1);
  const colors = after.filter((t) => isColorTok(t)).map((t) => parseColor(t.raw));
  const fontSize = Number(after.find((t) => /^\d+(\.\d+)?$/.test(t.raw))?.raw ?? Math.round(h * 0.34));

  const x = c.x - w / 2;
  const y = c.y - h / 2;
  const r = Math.min(40, h * 0.3);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  if (tail) {
    const tx = tail.x;
    const ty = tail.y;
    ctx.lineTo(tx + 22, y + h - 6);
    ctx.lineTo(tx, ty);
    ctx.lineTo(tx - 22, y + h - 6);
  }
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = colors[0] ?? '#FFFFFF';
  ctx.fill();
  if (colors[2]) { ctx.lineWidth = 4; ctx.strokeStyle = colors[2]; ctx.stroke(); }

  const f = font(fontSize);
  const lines = wrapText(ctx, textTok.text, w - 48, f);
  const lineH = fontSize * 1.4;
  let ty = c.y - ((lines.length - 1) * lineH) / 2;
  ctx.font = f;
  ctx.fillStyle = colors[1] ?? '#111827';
  ctx.textAlign = 'center';
  for (const line of lines) {
    ctx.fillText(line, c.x, ty);
    ty += lineH;
  }
  ctx.textAlign = 'left';
}

function drawStamp(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = num(rest[1]);
  const textTok = rest.find((t) => t.quoted);
  if (!c || r === null || !textTok) throw new Error('STAMP 参数不全');
  const after = rest.slice(rest.indexOf(textTok) + 1);
  const color = parseColor(after.find((t) => isColorTok(t))?.raw ?? '#DC2626');
  const rotateTok = after.find((t) => /^-?\d+(\.\d+)?$/.test(t.raw));
  const rot = rotateTok ? Number(rotateTok.raw) : -12;

  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.beginPath();
  ctx.arc(0, 0, Math.abs(r), 0, Math.PI * 2);
  ctx.lineWidth = Math.max(4, Math.abs(r) * 0.08);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = font(Math.abs(r) * 0.5, true);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(textTok.text, 0, 0);
  ctx.restore();
  ctx.textAlign = 'left';
}

async function drawAvatar(ctx: SKRSContext2D, rest: Tok[], assets: DrawAssets): Promise<void> {
  const c = parsePair(rest[0]);
  const r = num(rest[1]);
  const qq = rest[2]?.raw.match(/^\d{4,12}$/)?.[0];
  if (!c || r === null || !qq) throw new Error('AVATAR 参数不全');
  const after = rest.slice(3);
  const borderColor = after.find((t) => isColorTok(t))?.raw;
  const borderW = Number(after.find((t) => /^\d+(\.\d+)?$/.test(t.raw))?.raw ?? 0);
  const img = assets.avatar ? await assets.avatar(qq) : null;
  const R = Math.abs(r);

  ctx.save();
  ctx.beginPath();
  ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, c.x - R, c.y - R, R * 2, R * 2);
  } else {
    ctx.fillStyle = '#CBD5E1';
    ctx.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    ctx.fillStyle = '#64748B';
    ctx.font = font(R * 0.8, true);
    ctx.textAlign = 'center';
    ctx.fillText(qq.slice(-2), c.x, c.y);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  if (borderColor) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, R + Math.max(2, borderW) / 2, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, borderW);
    ctx.strokeStyle = parseColor(borderColor);
    ctx.stroke();
  }
}

async function drawImageEl(ctx: SKRSContext2D, rest: Tok[], assets: DrawAssets): Promise<void> {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const srcTok = rest[2];
  if (!c || !size || !srcTok) throw new Error('I 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const img = assets.image ? await assets.image(srcTok.raw) : null;
  if (!img) throw new Error('贴图加载失败');
  ctx.save();
  const mode = rest.find((t) => /^(CIRCLE|ROUND)/i.test(t.raw))?.raw.toUpperCase();
  if (mode === 'CIRCLE') {
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.min(w, h) / 2, 0, Math.PI * 2);
    ctx.clip();
  } else if (mode?.startsWith('ROUND')) {
    const rr = Number(mode.split(':')[1] ?? 24);
    roundRectPath(ctx, c.x - w / 2, c.y - h / 2, w, h, rr);
    ctx.clip();
  }
  ctx.drawImage(img, c.x - w / 2, c.y - h / 2, w, h);
  ctx.restore();
}

// ---------- 图片加载（给 pipeline 用） ----------

const imgCache = new Map<string, { img: Image | null; at: number }>();

export async function loadImageCached(src: string): Promise<Image | null> {
  const hit = imgCache.get(src);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.img;
  let img: Image | null = null;
  try {
    if (/^https?:\/\//.test(src)) {
      img = await loadImage(src);
    } else if (/^qq:\/\//.test(src)) {
      const qq = src.replace('qq://', '').trim();
      img = await loadImage(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`);
    } else if (existsSync(src)) {
      img = await loadImage(await readFile(src));
    }
  } catch {
    img = null;
  }
  if (imgCache.size > 200) imgCache.clear();
  imgCache.set(src, { img, at: Date.now() });
  return img;
}
