// 出图模块回归：表格、DRAW、图表、代码块剥离
import { parseMarkdownTable, renderTable } from '../src/modules/render/table.ts';
import { renderDraw } from '../src/modules/render/draw.ts';
import { renderReplyImages } from '../src/modules/render/index.ts';
import { mermaidUrl } from '../src/modules/render/mermaid.ts';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, extra = ''): void => {
  if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + ' ' + extra); }
};

// 1) 表格解析
const md = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
const t = parseMarkdownTable(md);
check('表格解析出 2 列 2 行', !!t && t.head.length === 2 && t.rows.length === 2);
check('不是表格的文本返回 null', parseMarkdownTable('随便一句话') === null);
const tr = renderTable(t!);
check('表格出图成功', tr.png.length > 5000, String(tr.png.length));

// 2) DRAW 基础图元
const drawRes = await renderDraw('@1200x800 #FFFFFF\nR 600,400 400,200 F #FF0000\nC 300,400 80 F #00FF00\nT 600,650 "测试文字" #333333 48 C');
check('DRAW 出图成功', drawRes.png.length > 5000, String(drawRes.png.length));
check('DRAW 无失败图元', drawRes.failed.length === 0, JSON.stringify(drawRes.failed));

// 3) 图表
const chartRes = await renderDraw('@1600x1200 #FFFFFF\nRADAR 800,600 300 "攻击:90,防御:80,智力:95" #3B82F6\nPIE 800,600 200 "A:40:#EF4444,B:60:#3B82F6"');
check('图表出图成功', chartRes.png.length > 5000, String(chartRes.png.length));
check('图表无失败', chartRes.failed.length === 0, JSON.stringify(chartRes.failed));

// 4) 代码块剥离
const reply = '看图\n```draw\n@800x800 #FFF\nC 400,400 200 F #F00\n```\n结束';
const r = await renderReplyImages(reply, { mermaid: false });
check('draw 代码块被摘除', !r.text.includes('```draw') && !r.text.includes('C 400,400'));
check('生成了 1 张图', r.images.length === 1, String(r.images.length));

// 5) mermaid 链接格式
const u = mermaidUrl('flowchart LR\n A-->B');
check('mermaid 链接格式正确', u.startsWith('https://mermaid.ink/img/pako:'), u.slice(0, 40));

// 6) 画布尺寸：模型自己定比例，超上限等比缩，不裁内容
const wide = await renderDraw('@2400x1600 #FFFFFF\nC 1200,800 400 F #4A90D9');
check('横图按指定尺寸出', wide.width === 2400 && wide.height === 1600, `${wide.width}x${wide.height}`);
const tall = await renderDraw('@1600x2400 #FFFFFF\nC 800,1200 400 F #4A90D9');
check('竖图按指定尺寸出', tall.width === 1600 && tall.height === 2400, `${tall.width}x${tall.height}`);
const huge = await renderDraw('@6000x3000 #FFFFFF\nC 3000,1500 400 F #4A90D9');
check('超上限等比缩到 4096，比例不变',
  huge.width === 4096 && huge.height === 2048, `${huge.width}x${huge.height}`);

// 7) 弧线语法：第二对坐标是弧心（嘴巴画歪就是这里写错）
const arcOk = await renderDraw('@600x600 #FFF\nA 420,300 300,300 120,180 S #C06080 10');
check('弧线按「起点+弧心」画成功', arcOk.failed.length === 0, JSON.stringify(arcOk.failed));
const arcBad = await renderDraw('@600x600 #FFF\nA 180,300 420,300 120,180 S #C06080 10');
check('把终点当弧心会被拦下并报错', arcBad.failed.length === 1, JSON.stringify(arcBad.failed));

// 8) 圆环：内外半径不能相同，否则是厚度 0 的空环
const ringOk = await renderDraw('@600x600 #FFF\nRING 300,300 250,180 F #6C5CE7');
check('圆环正常出图', ringOk.failed.length === 0, JSON.stringify(ringOk.failed));
const ringBad = await renderDraw('@600x600 #FFF\nRING 300,300 610,610 F #FFD166');
check('内外半径相同会被拦下并报错', ringBad.failed.length === 1, JSON.stringify(ringBad.failed));

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
