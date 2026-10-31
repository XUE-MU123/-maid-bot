// Mermaid 图表：走 mermaid.ink 在线渲染（和原版一样），但加了缓存和超时。
// 注意：图表内容会发给第三方，涉及敏感信息时请把开关关掉。
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../../core/logger.ts';

const log = makeLogger('render');

const CACHE_DIR = join(process.cwd(), 'cache');

export interface MermaidOpts {
  theme?: string;
  timeoutMs?: number;
}

/**
 * 按长边决定出图宽度。
 * 踩过的坑：2026-10-29 一开始把宽度写死成 900，流程图没问题，
 * 但甘特图原本是 1904×196 的超宽图，被硬压成 900×93，字全糊。
 * 所以先量原图长宽比，再决定：
 *   - 普通图：长边拉到 1800
 *   - 超宽图（长宽比 ≥ 5，比如甘特图/长时间线）：长边拉到 2600，给放大看留余地
 * 只放大不缩小，永远不比原图小。
 */
export function pickWidth(w0: number, h0: number): number {
  const long = Math.max(w0, h0);
  const aspect = w0 / Math.max(h0, 1);
  const wantLong = aspect >= 5 ? 2600 : 1800;
  const scale = Math.max(1, wantLong / long);
  return Math.min(3000, Math.round(w0 * scale));
}

/** 从 JPEG/PNG 字节里读出真实宽高，读不出来返回 null */
function measure(buf: Buffer): { w: number; h: number } | null {
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // JPEG：扫段找 SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** 把 mermaid 代码压成 mermaid.ink 认识的 pako 链接；width 传 0 表示要原图尺寸 */
export function mermaidUrl(code: string, theme = 'default', width = 0): string {
  const payload = JSON.stringify({ code: `%%{init: {'theme':'${theme}'}}%%\n${code}`, mermaid: { theme } });
  const b64 = deflateSync(Buffer.from(payload, 'utf8'), { level: 9 })
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  // width 让对面**重新渲染**（不是把像素拉大），白底避免 QQ 深色主题下看不清
  const q = width > 0 ? `?width=${width}&bgColor=white` : '?bgColor=white';
  return `https://mermaid.ink/img/pako:${b64}${q}`;
}

export async function renderMermaid(code: string, opts: MermaidOpts = {}): Promise<Buffer | null> {
  const clean = String(code ?? '').trim();
  if (!clean) return null;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    // 缓存键带 v3：尺子算法改过就必须作废旧图，否则一直吃老的糊图
    const key = createHash('sha1')
      .update(`v3|${clean}|${opts.theme ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    const file = join(CACHE_DIR, `mermaid-${key}.png`);
    if (existsSync(file)) {
      log.debug(`mermaid 命中缓存 ${key}`);
      return readFileSafe(file);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25000);
    timer.unref?.();
    try {
      const get = async (width: number): Promise<Buffer> => {
        const res = await fetch(mermaidUrl(clean, opts.theme, width), { signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200) throw new Error('返回的图太小');
        return buf;
      };

      // 第一步：拿原图尺寸（这一步不能带 width，否则量到的是被我改过的尺寸）
      const natural = await get(0);
      const size = measure(natural);
      if (!size) {
        writeFileSync(file, natural);
        log.warn('mermaid 量不出原图尺寸，直接用原图');
        return natural;
      }

      const width = pickWidth(size.w, size.h);
      let buf = natural;
      // 原图已经够宽就不要再请求一次，省一个来回
      if (width > size.w) buf = await get(width);

      writeFileSync(file, buf);
      const out = measure(buf);
      log.info(
        `mermaid 渲染完成：原图 ${size.w}x${size.h} → ${out ? `${out.w}x${out.h}` : '?'}（${buf.length} 字节）`,
      );
      return buf;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.warn(`mermaid 渲染失败：${String((err as Error)?.message ?? err)}`);
    return null;
  }
}

function readFileSafe(p: string): Buffer | null {
  try { return readFileSync(p); } catch { return null; }
}
