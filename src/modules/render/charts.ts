// 数据图表：雷达图 / 饼图 / 柱状图 / 折线图 / 坐标系。
// 全部画在 DRAW 引擎的同一块画布上，配色沿用传入的主色。
import type { SKRSContext2D } from '@napi-rs/canvas';
import { font, parseColor, roundRectPath, wrapText } from './kit.ts';

interface Tok {
  raw: string;
  text: string;
  quoted: boolean;
}

function parsePair(t: Tok | undefined): { x: number; y: number } | null {
  if (!t) return null;
  const m = t.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

function isColorTok(t: Tok | undefined): boolean {
  if (!t || !t.raw) return false;
  return /^#[0-9a-fA-F]{3,8}$/.test(t.raw) || /^rgba?\(/i.test(t.raw) || /^[a-zA-Z]{3,20}$/.test(t.raw);
}

/** "攻击:95,防御:80" → [{label,value}] */
function parseItems(src: string): Array<{ label: string; value: number; color?: string }> {
  return String(src ?? '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const parts = s.split(':');
      const label = (parts[0] ?? '').trim();
      const value = parseFloat(parts[1] ?? '0');
      const color = (parts[2] ?? '').trim() || undefined;
      return { label, value: Number.isFinite(value) ? value : 0, color };
    })
    .filter((it) => it.label);
}

const PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#06B6D4', '#F472B6', '#84CC16'];

/** 图表统一入口：返回 true 表示这条指令被处理了 */
export function drawChart(ctx: SKRSContext2D, cmd: string, rest: Tok[]): boolean {
  switch (cmd) {
    case 'RADAR': drawRadar(ctx, rest); return true;
    case 'PIE': drawPie(ctx, rest); return true;
    case 'BAR': drawBar(ctx, rest); return true;
    case 'LINECHART': drawLineChart(ctx, rest); return true;
    case 'GRID': drawGrid(ctx, rest); return true;
    default: return false;
  }
}

function drawRadar(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = Number(rest[1]?.raw);
  const dataTok = rest.find((t) => t.quoted);
  if (!c || !Number.isFinite(r) || !dataTok) throw new Error('RADAR 参数不全');
  const items = parseItems(dataTok.text);
  if (items.length < 3) throw new Error('RADAR 至少 3 项');
  const mainColor = parseColor(rest.find((t) => t !== rest[0] && t !== rest[1] && t !== dataTok && isColorTok(t))?.raw, '#3B82F6');
  const title = rest.filter((t) => t.quoted)[1]?.text ?? '';

  const n = items.length;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const rings = 4;

  // 网格
  for (let ring = 1; ring <= rings; ring++) {
    const rr = (r * ring) / rings;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const x = c.x + Math.cos(a) * rr;
      const y = c.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // 轴线 + 标签
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
    ctx.strokeStyle = 'rgba(148,163,184,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const lx = c.x + Math.cos(a) * (r + 70);
    const ly = c.y + Math.sin(a) * (r + 70);
    ctx.font = font(40, true);
    ctx.fillStyle = '#E2E8F0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(items[i].label, lx, ly);
  }
  // 数据多边形
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const a = -Math.PI / 2 + (idx * Math.PI * 2) / n;
    const rr = (items[idx].value / maxVal) * r;
    const x = c.x + Math.cos(a) * rr;
    const y = c.y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = hexAlpha(mainColor, 0.32);
  ctx.fill();
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 5;
  ctx.stroke();
  // 顶点
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
    const rr = (items[i].value / maxVal) * r;
    ctx.beginPath();
    ctx.arc(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (title) {
    ctx.font = font(52, true);
    ctx.fillStyle = '#F8FAFC';
    ctx.textAlign = 'center';
    ctx.fillText(title, c.x, c.y - r - 130);
  }
  ctx.textAlign = 'left';
}

function drawPie(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const r = Number(rest[1]?.raw);
  const dataTok = rest.find((t) => t.quoted);
  if (!c || !Number.isFinite(r) || !dataTok) throw new Error('PIE 参数不全');
  const items = parseItems(dataTok.text);
  if (!items.length) throw new Error('PIE 没有数据');
  const donut = rest.some((t) => t.raw.toUpperCase() === 'DONUT');
  const total = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;

  let start = -Math.PI / 2;
  items.forEach((item, i) => {
    const angle = (Math.abs(item.value) / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.arc(c.x, c.y, r, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = item.color ? parseColor(item.color) : PALETTE[i % PALETTE.length];
    ctx.fill();
    start += angle;
  });

  if (donut) {
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = '#0F172A';
    ctx.fill();
  }

  // 图例
  const legendX = c.x + r + 90;
  let ly = c.y - (items.length * 62) / 2;
  items.forEach((item, i) => {
    ctx.beginPath();
    ctx.arc(legendX + 16, ly + 20, 14, 0, Math.PI * 2);
    ctx.fillStyle = item.color ? parseColor(item.color) : PALETTE[i % PALETTE.length];
    ctx.fill();
    ctx.font = font(38);
    ctx.fillStyle = '#E2E8F0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const pct = ((Math.abs(item.value) / total) * 100).toFixed(1);
    ctx.fillText(`${item.label}  ${pct}%`, legendX + 44, ly + 20);
    ly += 62;
  });
  ctx.textAlign = 'left';
}

function drawBar(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const dataTok = rest.find((t) => t.quoted);
  if (!c || !size || !dataTok) throw new Error('BAR 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const items = parseItems(dataTok.text);
  if (!items.length) throw new Error('BAR 没有数据');
  const mainColor = parseColor(rest.filter((t) => isColorTok(t) && t !== rest[0] && t !== rest[1])[0]?.raw, '#3B82F6');
  const title = rest.filter((t) => t.quoted)[1]?.text ?? '';

  const left = c.x - w / 2;
  const top = c.y - h / 2;
  const axisY = top + h - 70;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const barW = Math.min(120, (w - 120) / items.length * 0.55);
  const gap = (w - 120) / items.length;

  // 基线
  ctx.beginPath();
  ctx.moveTo(left + 40, axisY);
  ctx.lineTo(left + w - 20, axisY);
  ctx.strokeStyle = 'rgba(148,163,184,0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();

  items.forEach((item, i) => {
    const bh = (item.value / maxVal) * (h - 140);
    const bx = left + 60 + gap * i + (gap - barW) / 2;
    const by = axisY - bh;

    const grad = ctx.createLinearGradient(0, by, 0, axisY);
    grad.addColorStop(0, mainColor);
    grad.addColorStop(1, hexAlpha(mainColor, 0.55));
    roundRectPath(ctx, bx, by, barW, Math.max(4, bh), 12);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.font = font(34, true);
    ctx.fillStyle = '#E2E8F0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(item.value), bx + barW / 2, by - 30);
    ctx.font = font(32);
    ctx.fillText(item.label, bx + barW / 2, axisY + 36);
  });

  if (title) {
    ctx.font = font(48, true);
    ctx.fillStyle = '#F8FAFC';
    ctx.fillText(title, c.x, top - 40);
  }
  ctx.textAlign = 'left';
}

function drawLineChart(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  const dataTok = rest.find((t) => t.quoted);
  if (!c || !size || !dataTok) throw new Error('LINECHART 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const items = parseItems(dataTok.text);
  if (items.length < 2) throw new Error('LINECHART 至少 2 个点');
  const mainColor = parseColor(rest.filter((t) => isColorTok(t) && t !== rest[0] && t !== rest[1])[0]?.raw, '#22D3EE');
  const title = rest.filter((t) => t.quoted)[1]?.text ?? '';

  const left = c.x - w / 2 + 60;
  const right = c.x + w / 2 - 40;
  const top = c.y - h / 2 + 40;
  const bottom = c.y + h / 2 - 80;
  const maxVal = Math.max(...items.map((i) => i.value), 1);
  const stepX = (right - left) / (items.length - 1);

  // 横向网格
  for (let g = 0; g <= 4; g++) {
    const y = top + ((bottom - top) * g) / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const pts = items.map((item, i) => ({
    x: left + stepX * i,
    y: bottom - (item.value / maxVal) * (bottom - top),
  }));

  // 面积
  ctx.beginPath();
  ctx.moveTo(pts[0].x, bottom);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, bottom);
  ctx.closePath();
  const area = ctx.createLinearGradient(0, top, 0, bottom);
  area.addColorStop(0, hexAlpha(mainColor, 0.45));
  area.addColorStop(1, hexAlpha(mainColor, 0.02));
  ctx.fillStyle = area;
  ctx.fill();

  // 折线
  ctx.beginPath();
  pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#0F172A';
    ctx.fill();
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.font = font(30);
    ctx.fillStyle = '#CBD5E1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(items[i].label, p.x, bottom + 40);
    ctx.font = font(30, true);
    ctx.fillText(String(items[i].value), p.x, p.y - 36);
  });

  if (title) {
    ctx.font = font(48, true);
    ctx.fillStyle = '#F8FAFC';
    ctx.fillText(title, c.x, top - 60);
  }
  ctx.textAlign = 'left';
}

function drawGrid(ctx: SKRSContext2D, rest: Tok[]): void {
  const c = parsePair(rest[0]);
  const size = rest[1]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!c || !size) throw new Error('GRID 参数不全');
  const w = parseFloat(size[1]);
  const h = parseFloat(size[2]);
  const rangeTok = rest[2]?.raw.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?$/);
  const xMin = rangeTok ? parseFloat(rangeTok[1]) : -10;
  const xMax = rangeTok ? parseFloat(rangeTok[2]) : 10;
  const yMin = rangeTok?.[3] ? parseFloat(rangeTok[3]) : -10;
  const yMax = rangeTok?.[4] ? parseFloat(rangeTok[4]) : 10;

  const left = c.x - w / 2;
  const top = c.y - h / 2;
  const right = c.x + w / 2;
  const bottom = c.y + h / 2;
  const x0 = left + ((0 - xMin) / (xMax - xMin)) * w;
  const y0 = bottom - ((0 - yMin) / (yMax - yMin)) * h;

  // 网格线
  const cells = 8;
  for (let i = 0; i <= cells; i++) {
    const x = left + (w * i) / cells;
    const y = top + (h * i) / cells;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.strokeStyle = 'rgba(148,163,184,0.16)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  // 坐标轴
  ctx.beginPath();
  ctx.moveTo(left, y0);
  ctx.lineTo(right, y0);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x0, top);
  ctx.lineTo(x0, bottom);
  ctx.stroke();

  // 刻度
  ctx.font = font(28);
  ctx.fillStyle = '#94A3B8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= cells; i += 2) {
    const xv = xMin + ((xMax - xMin) * i) / cells;
    ctx.fillText(String(Math.round(xv * 10) / 10), left + (w * i) / cells, y0 + 10);
  }
  ctx.textAlign = 'right';
  for (let i = 0; i <= cells; i += 2) {
    const yv = yMax - ((yMax - yMin) * i) / cells;
    ctx.fillText(String(Math.round(yv * 10) / 10), x0 - 12, top + (h * i) / cells - 14);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
}

/** 把 #RRGGBB 之类的颜色转成带透明度的 rgba；解析不了就退回半透明灰 */
export function hexAlpha(color: string, alpha: number): string {
  const m = color.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `rgba(148,163,184,${alpha})`;
}

/** 给图表标题用的换行（复用于外部） */
export function chartTitleLines(ctx: SKRSContext2D, text: string, width: number, f: string): string[] {
  return wrapText(ctx, text, width, f);
}
