import { writeFileSync } from 'node:fs';
import { parseMarkdownTable, renderTable } from '../src/modules/render/table.ts';

const md = `
| 群友 | 好感度 | 等级 | 最近活跃 | 备注说明 |
|---|---|---|---|---|
| 乱花渐欲（老大） | 999（锁定） | 特等贵客·至高主权 | 21:15 | 无敌的至高存在，说话要毕恭毕敬 |
| 猫娘麦麦 | 86 | 亲密知己 | 21:02 | 会撒娇，喜欢被叫麦麦 |
| 恶魔鲸鱼娘 | 42 | 熟络朋友 | 20:58 | 嘴上凶，其实很好说话 |
| 纠纠 | 17 | 初识客套 | 20:42 | 爱发猫图 |
`;

const data = parseMarkdownTable(md);
if (!data) { console.error('解析失败'); process.exit(1); }
console.log('解析:', data.head.length, '列 x', data.rows.length, '行');
const t0 = Date.now();
const r = renderTable(data);
console.log('渲染耗时:', Date.now() - t0, 'ms ｜尺寸:', r.width + 'x' + r.height, '｜', r.png.length, '字节');
writeFileSync('cache/table-demo.png', r.png);
