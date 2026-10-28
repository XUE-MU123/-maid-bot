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

/** 把 mermaid 代码压成 mermaid.ink 认识的 pako 链接 */
export function mermaidUrl(code: string, theme = 'default'): string {
  const payload = JSON.stringify({ code: `%%{init: {'theme':'${theme}'}}%%\n${code}`, mermaid: { theme } });
  const b64 = deflateSync(Buffer.from(payload, 'utf8'), { level: 9 })
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `https://mermaid.ink/img/pako:${b64}`;
}

export async function renderMermaid(code: string, opts: MermaidOpts = {}): Promise<Buffer | null> {
  const clean = String(code ?? '').trim();
  if (!clean) return null;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const key = createHash('sha1').update(clean + (opts.theme ?? '')).digest('hex').slice(0, 16);
    const file = join(CACHE_DIR, `mermaid-${key}.png`);
    if (existsSync(file)) {
      log.debug(`mermaid 命中缓存 ${key}`);
      return readFileSafe(file);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25000);
    timer.unref?.();
    try {
      const res = await fetch(mermaidUrl(clean, opts.theme), { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 200) throw new Error('返回的图太小');
      writeFileSync(file, buf);
      log.info(`mermaid 渲染完成（${buf.length} 字节）`);
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
