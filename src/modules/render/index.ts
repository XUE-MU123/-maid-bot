// 渲染总入口：把回复里的代码块/表格变成图片。
// 比原版多做的：统一缓存、最多 3 张防刷屏、单张失败不影响其他、全程有超时。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../../core/logger.ts';
import { renderDraw, loadImageCached, type DrawAssets } from './draw.ts';
import { parseMarkdownTable, renderTable } from './table.ts';
import { renderSvg, expandQqImages } from './svg.ts';
import { renderMermaid } from './mermaid.ts';

const log = makeLogger('render');
const CACHE_DIR = join(process.cwd(), 'cache');

export interface RenderOptions {
  /** 最多出几张图，防止一条消息刷屏 */
  maxImages?: number;
  /** 表格转图片 */
  tables?: boolean;
  /** SVG */
  svg?: boolean;
  /** Mermaid（走外网，注意隐私） */
  mermaid?: boolean;
  /** 单张渲染超时 */
  timeoutMs?: number;
  /** 表格配色预设 */
  tablePreset?: string;
  /** qq://头像 → 真实地址 */
  avatarOf?: (qq: string) => string;
  drawAssets?: DrawAssets;
}

export interface RenderedReply {
  text: string;
  images: string[];
  notes: string[];
}

/** 按文件头判断真实格式（mermaid.ink 有时给 JPEG），扩展名必须和内容一致 */
function saveImage(buf: Buffer, prefix: string): string {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
  const ext = isJpeg ? 'jpg' : 'png';
  const file = join(CACHE_DIR, `${prefix}-${key}.${ext}`);
  if (!existsSync(file)) writeFileSync(file, buf);
  return file;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超过 ${ms}ms`)), ms);
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 默认头像地址 */
const defaultAvatar = (qq: string): string => `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;

/**
 * 把回复里的代码块/表格渲染成图片，并从正文里摘掉。
 * 返回的 images 是本地文件路径，交给发送层。
 */
export async function renderReplyImages(reply: string, opts: RenderOptions = {}): Promise<RenderedReply> {
  const maxImages = Math.max(0, Math.min(3, opts.maxImages ?? 3));
  const timeoutMs = opts.timeoutMs ?? 12000;
  const images: string[] = [];
  const notes: string[] = [];
  let text = String(reply ?? '');

  const tryRender = async (label: string, fn: () => Promise<Buffer | null>): Promise<Buffer | null> => {
    if (images.length >= maxImages) {
      notes.push(`${label}：超出单条最多 ${maxImages} 张，已跳过`);
      return null;
    }
    try {
      const buf = await withTimeout(fn(), timeoutMs, label);
      return buf;
    } catch (err) {
      notes.push(`${label}失败：${String((err as Error)?.message ?? err)}`);
      log.warn(`${label}渲染失败：${String((err as Error)?.message ?? err)}`);
      return null;
    }
  };

  // 1) ```draw 代码块
  const drawRe = /```draw\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = drawRe.exec(text)) !== null) {
    const code = m[1];
    const buf = await tryRender('绘图', async () => {
      const r = await renderDraw(code, opts.drawAssets ?? { image: loadImageCached });
      if (r.failed.length) log.warn(`绘图部分图元失败：${r.failed.slice(0, 3).join(' | ')}`);
      return r.png;
    });
    if (buf) images.push(saveImage(buf, 'draw'));
  }
  text = text.replace(drawRe, '');

  // 2) ```svg 代码块
  if (opts.svg !== false) {
    const svgRe = /```svg\s*\n([\s\S]*?)```/gi;
    while ((m = svgRe.exec(text)) !== null) {
      const code = m[1];
      const buf = await tryRender('SVG', async () => {
        const svgText = expandQqImages(code, opts.avatarOf ?? defaultAvatar);
        return renderSvg(svgText, { expandPathImage: true }).png;
      });
      if (buf) images.push(saveImage(buf, 'svg'));
    }
    text = text.replace(svgRe, '');
  }

  // 3) ```mermaid 代码块
  if (opts.mermaid) {
    const mmRe = /```mermaid\s*\n([\s\S]*?)```/gi;
    while ((m = mmRe.exec(text)) !== null) {
      const code = m[1];
      const buf = await tryRender('Mermaid', async () => renderMermaid(code, { timeoutMs }));
      if (buf) images.push(saveImage(buf, 'mermaid'));
    }
    text = text.replace(mmRe, '');
  }

  // 4) Markdown 表格
  if (opts.tables !== false) {
    const tableRe = /(^\|.*\|[ \t]*\n\|[ \t:|-]+\|[ \t]*\n(?:\|.*\|[ \t]*\n?)+)/gm;
    while ((m = tableRe.exec(text)) !== null) {
      const block = m[1];
      const buf = await tryRender('表格', async () => {
        const data = parseMarkdownTable(block);
        if (!data) return null;
        return renderTable(data, { preset: (opts.tablePreset as never) ?? 'yuzu-deep' }).png;
      });
      if (buf) images.push(saveImage(buf, 'table'));
      text = text.replace(block, '');
    }
  }

  // 清掉空出来的连续空行和残留代码围栏
  text = text
    .replace(/```[a-zA-Z]*\s*\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, images, notes };
}

/** 面板/日志用：一句话说明这次渲染了什么 */
export function renderSummary(r: RenderedReply): string {
  const parts: string[] = [];
  if (r.images.length) parts.push(`出图 ${r.images.length} 张`);
  if (r.notes.length) parts.push(...r.notes);
  return parts.join('；');
}
