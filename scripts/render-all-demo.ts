import { writeFileSync } from 'node:fs';
import { renderReplyImages } from '../src/modules/render/index.ts';

const reply = `这是我的战绩，你看：\n\n\`\`\`draw\n@2400x2400 #FFF7ED #FFEDD5 V\nRR 1200,300 1700,240 50 F #FB923C\nT 1200,300 "本周摸鱼报告" #FFFFFF 90 C B\nC 500,760 150 F #FDBA74\nT 500,760 "🐟" #FFFFFF 120 C\nT 1200,760 "摸鱼 18 小时" #7C2D12 80 C B\nT 700,1020 "被老大抓到 3 次" #9A3412 60 C\nPROGRESS 1200,1250 1500,90 72,100 #F97316 "摸鱼进度 72%"\n\`\`\`\n\n再给你看个表：\n\n| 时间 | 在干嘛 | 被抓到 |\n|---|---|---|\n| 上午 | 假装写代码 | 1 次 |\n| 下午 | 群里水群 | 2 次 |\n| 晚上 | 认真干活 | 0 次 |\n\n还有个流程图：\n\n\`\`\`mermaid\nflowchart LR\n  A[开始摸鱼] --> B{老大在吗}\n  B -->|在| C[假装干活]\n  B -->|不在| A\n\`\`\`\n`;

const t0 = Date.now();
const r = await renderReplyImages(reply, { mermaid: true });
console.log('总耗时', Date.now() - t0, 'ms');
console.log('出图', r.images.length, '张:', r.images.map((p) => p.split('/').pop()).join(', '));
console.log('提示:', r.notes.join(' | ') || '（无）');
console.log('正文剩余:', JSON.stringify(r.text).slice(0, 200));
