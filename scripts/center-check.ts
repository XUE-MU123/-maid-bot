// 用像素统计验证文字是否真的在格子中间
import { parseMarkdownTable, renderTable } from '/root/QQBOT/maid-bot/src/modules/render/table.ts';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const data = parseMarkdownTable('| 名字 | 分数 |\n|---|---|\n| 张三 | 88 |')!;
const r = renderTable(data);
const img = await loadImage(r.png);
const c = createCanvas(img.width, img.height);
const ctx = c.getContext('2d');
ctx.drawImage(img, 0, 0);
const px = ctx.getImageData(0, 0, img.width, img.height).data;

// 分析「张三」所在格子：第二行（数据行），第一列
const theme = { padding: 56, headH: 108, rowH: 110, fontSize: 40 };
const x0 = 56 + 10, x1 = 56 + 200;       // 第一列大致范围
const y0 = theme.padding + theme.headH;   // 数据行顶部
const y1 = y0 + theme.rowH;

let top = -1, bottom = -1;
for (let y = y0; y < y1; y++) {
  let has = false;
  for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const r0 = px[i], g0 = px[i + 1], b0 = px[i + 2];
    // 文字是浅色（>150），底是深蓝（<60）
    if (r0 > 150 && g0 > 150 && b0 > 150) { has = true; break; }
  }
  if (has) { if (top === -1) top = y; bottom = y; }
}
const padTop = top - y0;
const padBottom = y1 - bottom;
console.log(`格子 y: ${y0}~${y1} (高 ${theme.rowH})`);
console.log(`文字墨迹 y: ${top}~${bottom}`);
console.log(`上方留白 ${padTop}px，下方留白 ${padBottom}px，差 ${Math.abs(padTop - padBottom)}px`);
console.log(Math.abs(padTop - padBottom) <= 6 ? '✅ 居中' : (padTop < padBottom ? '⬆️ 偏上' : '⬇️ 偏下'));
