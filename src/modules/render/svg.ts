// SVG 渲染：用 resvg（Rust 实现），支持渐变/滤镜/文字，比手写解析可靠得多。
// 顺便处理 <image href="qq://QQ号"> 这种头像占位（原版的自定义语法）。
import { Resvg } from '@resvg/resvg-js';
import { existsSync, readFileSync } from 'node:fs';

export interface SvgResult {
  png: Buffer;
  width: number;
  height: number;
}

/** 把 svg 里的 qq:// 头像换成真实地址，这样 resvg 能拉到 */
export function expandQqImages(svg: string, avatarOf: (qq: string) => string): string {
  return svg.replace(/qq:\/\/(\d{4,12})/g, (_m, qq: string) => avatarOf(String(qq)));
}

/** 读取本地文件为 data URI（给 <image href="本地路径"> 用） */
function toDataUri(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const buf = readFileSync(path);
    const ext = path.toLowerCase().endsWith('.jpg') || path.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
    return `data:image/${ext};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function renderSvg(svgText: string, opts: { maxSize?: number; expandPathImage?: boolean } = {}): SvgResult {
  let svg = String(svgText ?? '').trim();
  const start = svg.indexOf('<svg');
  const end = svg.lastIndexOf('</svg>');
  if (start < 0 || end < 0) throw new Error('不是完整的 SVG');
  svg = svg.slice(start, end + 6);

  if (opts.expandPathImage) {
    svg = svg.replace(/href="([^"]+\.(?:png|jpe?g))"/gi, (m, p: string) => {
      const uri = toDataUri(p);
      return uri ? `href="${uri}"` : m;
    });
  }

  const max = opts.maxSize ?? 2400;
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: max },
    font: {
      fontDirs: ['/usr/share/fonts'],
      loadSystemFonts: true,
      defaultFontFamily: 'Droid Sans Fallback',
    },
    background: '#FFFFFF',
  });
  const rendered = resvg.render();
  return { png: Buffer.from(rendered.asPng()), width: rendered.width, height: rendered.height };
}
