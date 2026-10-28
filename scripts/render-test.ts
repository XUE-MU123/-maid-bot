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

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
