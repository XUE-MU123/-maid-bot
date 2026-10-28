// Markdown 表格 → PNG。比原版多做了三件事：
// 1) 长单元格自动折行（原版不折，列会被撑得很宽）
// 2) 圆角外框 + 斑马纹 + 渐变表头，看着不像 Excel 截图
// 3) 生成结果按内容缓存，同样的表不重复画
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { drawMixedText, font, measure, newCanvas, roundRectPath, wrapText } from './kit.ts';
import { drawLaceEdge, drawWaveBand, drawWhaleTail, scatterDecor } from './decor.ts';

/** 三种视觉风格：business 商务分割线 / zebra 斑马纹 / card 卡片分行 */
export type TableVariant = 'business' | 'zebra' | 'card' | 'magazine';

/** 三套整体配色：cyber 暗夜赛博 / candy 马卡龙 / magazine 杂志极简 */
export type TablePresetName = 'cyber' | 'candy' | 'magazine' | 'yuzu-deep' | 'yuzu-lace' | 'yuzu-bubble';

export interface TablePreset {
  pageBg: string;
  cardBg: string;
  headerFrom: string;
  headerTo: string;
  headerText: string;
  rowBg: string;
  altBg: string;
  text: string;
  divider: string;
  dividerWidth: number;
  cardBorder: string;
  radius: number;
  shadow: boolean;
  variant: TableVariant;
  /** 列之间要不要竖分隔线 */
  columnLines?: boolean;
  /** 柚子风装饰：气泡星星 / 鲸鱼尾巴 / 底部波浪 / 蕾丝花边 */
  decor?: {
    stars?: number;
    bubbles?: number;
    whale?: boolean;
    wave?: boolean;
    lace?: boolean;
    accent: string;
  };
}

export const TABLE_PRESETS: Record<TablePresetName, TablePreset> = {
  // 暗夜赛博：深底 + 紫蓝渐变表头，适合游戏群、战力面板
  cyber: {
    pageBg: '#0B1120',
    cardBg: '#111827',
    headerFrom: '#4F46E5',
    headerTo: '#7C3AED',
    headerText: '#F8FAFC',
    rowBg: '#111827',
    altBg: '#151C2C',
    text: '#E2E8F0',
    divider: 'rgba(148,163,184,0.22)',
    dividerWidth: 1.5,
    cardBorder: 'rgba(148,163,184,0.18)',
    radius: 26,
    shadow: true,
    variant: 'business',
  },
  // 马卡龙：淡粉底 + 橙粉渐变表头，适合日常聊天
  candy: {
    pageBg: '#FDF2F8',
    cardBg: '#FFFFFF',
    headerFrom: '#F472B6',
    headerTo: '#FB923C',
    headerText: '#FFFFFF',
    rowBg: '#FFFFFF',
    altBg: '#FFF1F7',
    text: '#3F3D56',
    divider: '#FBCFE8',
    dividerWidth: 2,
    cardBorder: '#FBCFE8',
    radius: 26,
    shadow: true,
    variant: 'zebra',
  },
  // 杂志极简：白底黑字，表头不上色只压粗线，高级感
  magazine: {
    pageBg: '#FFFFFF',
    cardBg: '#FFFFFF',
    headerFrom: '#FFFFFF',
    headerTo: '#FFFFFF',
    headerText: '#111111',
    rowBg: '#FFFFFF',
    altBg: '#FFFFFF',
    text: '#1A1A1A',
    divider: '#E5E5E5',
    dividerWidth: 1,
    cardBorder: '#111111',
    radius: 6,
    shadow: false,
    variant: 'magazine',
  },
  // 柚子 · 深海星空：她的发色（湛蓝）+ 星空眼瞳 + 鲸鱼尾巴
  'yuzu-deep': {
    pageBg: '#08182E',
    cardBg: '#0D2140',
    headerFrom: '#1D4ED8',
    headerTo: '#7C3AED',
    headerText: '#E0F2FE',
    rowBg: '#0D2140',
    altBg: '#112A4E',
    text: '#DBEAFE',
    divider: 'rgba(56,189,248,0.28)',
    dividerWidth: 1.5,
    cardBorder: 'rgba(56,189,248,0.35)',
    radius: 30,
    shadow: true,
    variant: 'business',
    columnLines: true,
    decor: { stars: 26, bubbles: 12, whale: true, wave: true, accent: '#38BDF8' },
  },
  // 柚子 · 蓝白蕾丝：女仆裙的白 + 袖口的淡蓝
  'yuzu-lace': {
    pageBg: '#F5FAFF',
    cardBg: '#FFFFFF',
    headerFrom: '#60A5FA',
    headerTo: '#A78BFA',
    headerText: '#FFFFFF',
    rowBg: '#FFFFFF',
    altBg: '#F0F7FF',
    text: '#1E3A5F',
    divider: '#BFDBFE',
    dividerWidth: 2,
    cardBorder: '#BFDBFE',
    radius: 26,
    shadow: true,
    variant: 'zebra',
    decor: { stars: 0, bubbles: 0, whale: true, wave: false, lace: true, accent: '#3B82F6' },
  },
  // 柚子 · 星海气泡：深紫蓝 + 满屏气泡，最梦幻
  'yuzu-bubble': {
    pageBg: '#0F0B2E',
    cardBg: '#171141',
    headerFrom: '#6D28D9',
    headerTo: '#0EA5E9',
    headerText: '#F0F9FF',
    rowBg: '#171141',
    altBg: '#1D1552',
    text: '#E0E7FF',
    divider: 'rgba(167,139,250,0.26)',
    dividerWidth: 1.5,
    cardBorder: 'rgba(167,139,250,0.32)',
    radius: 34,
    shadow: true,
    variant: 'zebra',
    decor: { stars: 18, bubbles: 26, whale: true, wave: true, accent: '#A78BFA' },
  },
};

export interface TableTheme {
  preset?: TablePresetName;
  variant?: TableVariant;
  /** 行间分割线颜色 */
  divider: string;
  /** 行间分割线粗细 */
  dividerWidth: number;
  headerFrom: string;
  headerTo: string;
  headerText: string;
  rowBg: string;
  altBg: string;
  border: string;
  text: string;
  /** 画布内边距 */
  padding: number;
  /** 字号 */
  fontSize: number;
  /** 行内边距 */
  cellPadX: number;
  cellPadY: number;
  /** 单元格最大宽度（超过就折行） */
  maxCellWidth: number;
  /** 最小列宽 */
  minColWidth: number;
  /** 最大画布宽度，超过按比例缩 */
  maxWidth: number;
  /** 画布底色 */
  pageBg: string;
  /** 卡片底色 */
  cardBg: string;
  /** 卡片圆角 */
  cardRadius: number;
  /** 卡片投影 */
  cardShadow: boolean;
  /** 是否画列之间的竖线 */
  columnLines: boolean;
}

export const DEFAULT_TABLE_THEME: TableTheme = {
  variant: 'business',
  divider: '#CBD5E1',
  dividerWidth: 2,
  headerFrom: '#1E293B',
  headerTo: '#334155',
  headerText: '#F8FAFC',
  rowBg: '#FFFFFF',
  altBg: '#F8FAFC',
  border: '#E2E8F0',
  text: '#1E293B',
  padding: 56,
  fontSize: 40,
  cellPadX: 34,
  cellPadY: 26,
  maxCellWidth: 520,
  minColWidth: 130,
  maxWidth: 2400,
  pageBg: '#EEF2F7',
  cardBg: '#FFFFFF',
  cardRadius: 28,
  cardShadow: true,
  columnLines: false,
};

export interface TableResult {
  png: Buffer;
  width: number;
  height: number;
}

/** 把 markdown 表格文本解析成二维数组；不是表格返回 null */
export function parseMarkdownTable(text: string): { head: string[]; rows: string[][]; aligns: string[] } | null {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|'));
  if (lines.length < 2) return null;

  const splitRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  };

  const head = splitRow(lines[0]);
  // 第二行必须是 |---|:--:|---:| 这种分隔行
  const sepLine = lines[1];
  if (!/^\|?[\s:|-]+\|?$/.test(sepLine) || !/[-]/.test(sepLine)) return null;
  const aligns = splitRow(sepLine).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    return 'left';
  });

  const cols = Math.max(head.length, aligns.length);
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row: string[] = [];
    for (let c = 0; c < cols; c++) row.push(cells[c] ?? '');
    rows.push(row);
  }
  // 补齐表头
  while (head.length < cols) head.push('');
  if (!rows.length) return null;
  return { head: head.slice(0, cols), rows, aligns: aligns.slice(0, cols) };
}

export function renderTable(
  data: { head: string[]; rows: string[][]; aligns?: string[] },
  opts: Partial<TableTheme> = {},
): TableResult {
  // 默认走老大选定的「柚子·深海星空」
  const preset = TABLE_PRESETS[opts.preset ?? 'yuzu-deep'] ?? null;
  const theme = preset
    ? {
        ...DEFAULT_TABLE_THEME,
        ...opts,
        pageBg: preset.pageBg,
        cardBg: preset.cardBg,
        cardRadius: preset.radius,
        cardShadow: preset.shadow,
        headerFrom: preset.headerFrom,
        headerTo: preset.headerTo,
        headerText: preset.headerText,
        rowBg: preset.rowBg,
        altBg: preset.altBg,
        text: preset.text,
        border: preset.cardBorder,
        divider: preset.divider,
        dividerWidth: preset.dividerWidth,
        variant: preset.variant,
        columnLines: preset.columnLines ?? false,
      }
    : { ...DEFAULT_TABLE_THEME, ...opts };
  const cols = data.head.length;
  const bodyFont = font(theme.fontSize);
  const headFont = font(theme.fontSize, true);

  // 先用临时画布量字，算列宽和每格要折成几行
  const { ctx: probe } = newCanvas(10, 10);
  const wrapCache = new Map<string, string[]>();
  const cellLines = (text: string, col: number): string[] => {
    const key = col + '\u0001' + text;
    const hit = wrapCache.get(key);
    if (hit) return hit;
    const lines = text === '' ? [''] : wrapText(probe, text, theme.maxCellWidth, bodyFont);
    wrapCache.set(key, lines);
    return lines;
  };

  const colWidths = new Array(cols).fill(theme.minColWidth);
  const measureRow = (cells: string[], isHead: boolean): void => {
    const f = isHead ? headFont : bodyFont;
    for (let c = 0; c < cols; c++) {
      const text = cells[c] ?? '';
      const lines = isHead ? [text] : cellLines(text, c);
      for (const line of lines) {
        // +10 是给字宽误差留的余量，避免数字/英文刚好卡满被折行
        const w = measure(probe, line, f) + theme.cellPadX * 2 + 10;
        if (w > colWidths[c]) colWidths[c] = w;
      }
    }
  };
  measureRow(data.head, true);
  for (const row of data.rows) measureRow(row, false);

  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  // 太宽就整体按比例缩字号
  let scale = 1;
  const canvasCap = theme.maxWidth - theme.padding * 2;
  if (tableWidth > canvasCap) scale = Math.max(0.45, canvasCap / tableWidth);

  let fontSize = Math.max(16, Math.round(theme.fontSize * scale));
  let padX = Math.round(theme.cellPadX * scale);
  let padY = Math.round(theme.cellPadY * scale);

  // 行数太多时自动缩字号/行距：36 行的排行榜也不会长得让 QQ 把底部裁掉
  const MAX_TABLE_HEIGHT = 2600;
  const estimateHeight = (fs: number, py: number): number => {
    const headLine = Math.round(fs * 1.4);
    const head = headLine + py * 2;
    let body = 0;
    for (const row of data.rows) {
      let maxLines = 1;
      for (let c = 0; c < cols; c++) {
        const lines = wrapText(probe, row[c] ?? '', Math.round(theme.maxCellWidth * scale), font(fs));
        if (lines.length > maxLines) maxLines = lines.length;
      }
      body += maxLines * Math.round(fs * 1.45) + py * 2;
    }
    return head + body + theme.padding * 2;
  };
  let est = estimateHeight(fontSize, padY);
  if (est > MAX_TABLE_HEIGHT) {
    const k = Math.max(0.5, MAX_TABLE_HEIGHT / est);
    fontSize = Math.max(15, Math.round(fontSize * k));
    padY = Math.max(6, Math.round(padY * k));
    padX = Math.max(10, Math.round(padX * k));
    est = estimateHeight(fontSize, padY);
  }

  const bFont = font(fontSize);
  const hFont = font(fontSize, true);
  const widths = colWidths.map((w) => Math.round(w * scale));
  const totalW = widths.reduce((a, b) => a + b, 0);

  // 算行高
  const headLine = Math.round(fontSize * 1.4);
  const headH = headLine + padY * 2;
  const rowHeights = data.rows.map((row) => {
    let maxLines = 1;
    for (let c = 0; c < cols; c++) {
      const lines = wrapText(probe, row[c] ?? '', Math.round(theme.maxCellWidth * scale), bFont);
      if (lines.length > maxLines) maxLines = lines.length;
    }
    return maxLines * Math.round(fontSize * 1.45) + padY * 2;
  });
  const bodyH = rowHeights.reduce((a, b) => a + b, 0);
  let width = totalW + theme.padding * 2;
  let height = headH + bodyH + theme.padding * 2;

  const { canvas, ctx } = newCanvas(width, Math.max(height, 160));

  // 画布底色 + 柚子风散点（星星/气泡）
  const decor = preset?.decor;
  ctx.fillStyle = theme.pageBg;
  ctx.fillRect(0, 0, width, height);
  if (decor && (decor.stars || decor.bubbles)) {
    scatterDecor(ctx, width, height, {
      stars: decor.stars ?? 0,
      bubbles: decor.bubbles ?? 0,
      starColor: decor.accent,
      bubbleColor: decor.accent,
    });
  }
  const cardX = 16;
  const cardY = 16;
  const cardW = width - 32;
  const cardH = Math.max(height - 32, 120);
  ctx.save();
  if (theme.cardShadow) {
    ctx.shadowColor = 'rgba(15,23,42,0.16)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 12;
  }
  ctx.fillStyle = theme.cardBg;
  roundRectPath(ctx, cardX, cardY, cardW, cardH, theme.cardRadius);
  ctx.fill();
  ctx.restore();


  let y = theme.padding;
  const isMagazine = theme.variant === 'magazine';
  if (isMagazine) {
    // 杂志风：表头不上色，只压一条粗黑线
    ctx.fillStyle = theme.cardBg;
    ctx.fillRect(theme.padding, y, totalW, headH);
    ctx.beginPath();
    ctx.moveTo(theme.padding, y + headH);
    ctx.lineTo(theme.padding + totalW, y + headH);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 4;
    ctx.stroke();
  } else {
    // 其余：渐变表头，顶部两角跟随卡片圆角
    const grad = ctx.createLinearGradient(theme.padding, y, theme.padding + totalW, y);
    grad.addColorStop(0, theme.headerFrom);
    grad.addColorStop(1, theme.headerTo);
    ctx.save();
    roundRectPath(ctx, theme.padding, y, totalW, headH + 30, 20);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(theme.padding, y, totalW, headH + 30);
    ctx.restore();
  }

  drawCells(ctx, data.head, widths, theme.padding, y, headH, padX, padY, fontSize, hFont, theme.headerText, data.aligns, true);
  y += headH;
  // 女仆裙边式的蕾丝花边
  if (decor?.lace) {
    drawLaceEdge(ctx, theme.padding + 6, theme.padding + totalW - 6, y - 2, Math.max(6, Math.floor(totalW / 34)), '#93C5FD', 0.9);
  }

  // 表体：三种风格各画各的
  const variant = theme.variant ?? 'business';
  for (let r = 0; r < data.rows.length; r++) {
    const h = rowHeights[r];
    const isLast = r === data.rows.length - 1;

    if (variant === 'card') {
      // 卡片式：每行独立浅色圆角块，中间留缝
      const gap = 10;
      ctx.fillStyle = r % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
      roundRectPath(ctx, theme.padding + 8, y + gap / 2, totalW - 16, h - gap, 14);
      ctx.fill();
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = variant === 'zebra' && r % 2 === 1 ? theme.altBg : theme.rowBg;
      ctx.fillRect(theme.padding, y, totalW, h);
    }

    drawCells(ctx, data.rows[r], widths, theme.padding, y, h, padX, padY, fontSize, bFont, theme.text, data.aligns, false);

    if (variant !== 'card' && !isLast) {
      ctx.beginPath();
      ctx.moveTo(theme.padding, y + h);
      ctx.lineTo(theme.padding + totalW, y + h);
      ctx.strokeStyle = theme.divider;
      ctx.lineWidth = theme.dividerWidth;
      ctx.stroke();
    }
    y += h;
  }

  // 列分隔竖线：贯穿表头和表体，让每一列边界清清楚楚
  if (theme.columnLines && cols > 1) {
    let lx = theme.padding;
    for (let c = 0; c < cols - 1; c++) {
      lx += widths[c];
      ctx.beginPath();
      ctx.moveTo(lx, theme.padding);
      ctx.lineTo(lx, theme.padding + headH + bodyH);
      ctx.strokeStyle = theme.divider;
      ctx.lineWidth = theme.dividerWidth;
      ctx.stroke();
    }
  }

  // 外框圆角（卡片风格不加外框，本身就有行卡片）
  if (variant !== 'card' && !isMagazine) {
    ctx.save();
    roundRectPath(ctx, theme.padding, theme.padding, totalW, headH + bodyH, 18);
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // 柚子的小鲸鱼尾巴：当落款画在表格右下角
  if (decor?.whale) {
    drawWhaleTail(ctx, width - theme.padding - 34, height - theme.padding - 2, 34, decor.accent, 0.9);
  }
  // 底部海浪
  if (decor?.wave) drawWaveBand(ctx, width, height - 34, 22, decor.accent, 0.3);

  return { png: canvas.toBuffer('image/png'), width, height };
}

function drawCells(
  ctx: SKRSContext2D,
  cells: string[],
  widths: number[],
  offsetX: number,
  y: number,
  rowH: number,
  padX: number,
  padY: number,
  fontSize: number,
  f: string,
  color: string,
  _aligns: string[] | undefined,
  isHead: boolean,
): void {
  ctx.font = f;
  ctx.fillStyle = color;
  // 用 middle 基线：把「字形中线」对到格子中线，才不会看着偏上
  ctx.textBaseline = 'middle';
  let x = offsetX;
  for (let c = 0; c < cells.length; c++) {
    const text = cells[c] ?? '';
    const maxW = widths[c] - padX * 2;
    const lines = text === '' ? [''] : wrapText(ctx, text, maxW, f);
    const lineH = Math.round(fontSize * (isHead ? 1.4 : 1.45));
    const centerY = y + rowH / 2;
    // 多行时整体以格子中心为轴上下均分，单行就是正中
    // 用真实字形墨迹算偏移：不同字体（黑体/宋体）的上下高度不一样，
    // 固定补丁永远差几个像素，直接量 ascent/descent 才准
    ctx.font = f;
    const m0 = ctx.measureText(lines[0] ?? '');
    const asc = m0.actualBoundingBoxAscent || fontSize * 0.8;
    const desc = m0.actualBoundingBoxDescent || fontSize * 0.2;
    let ty = centerY - ((lines.length - 1) * lineH) / 2 + (asc - desc) / 2;
    const tx = x + widths[c] / 2;
    for (const line of lines) {
      drawMixedText(ctx, line, tx, ty, f, fontSize * 1.05, color, 'center');
      ty += lineH;
    }
    x += widths[c];
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
}

/** 表格渲染缓存：同样的表只画一次 */
const cacheDir = join(process.cwd(), 'cache');
export function renderTableCached(
  data: { head: string[]; rows: string[][]; aligns?: string[] },
  opts: Partial<TableTheme> = {},
): string | null {
  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const key = createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 16);
    const file = join(cacheDir, `table-${key}.png`);
    if (existsSync(file)) return file;
    const { png } = renderTable(data, opts);
    writeFileSync(file, png);
    return file;
  } catch {
    return null;
  }
}
