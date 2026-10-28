import { writeFileSync } from 'node:fs';
import { renderDraw, loadImageCached } from '../src/modules/render/draw.ts';

// 用 DRAW 指令画一张"战力面板"卡片（比原版演示更花一点）
const code = `
@2400x2400 #0F172A #1E293B D
C 1200,1200 1050 F #1E293B
RING 1200,1200 1040,980 F #334155
RR 1200,400 1600,220 40 F #6366F1 0 #818CF8 SHADOW
T 1200,400 "示例角色 · 战力面板" #FFFFFF 92 C B
C 1200,900 240 F #F472B6
C 1200,900 240 S #FDA4AF 12
T 1200,900 "例" #FFFFFF 180 C B
STAR 1420,690 60 F #FDE047
SPARKLE 980,690 70 F #FDE047
TAG 1200,1230 420,110 "特等贵客·至高主权" #F59E0B #1F2937 46 #FBBF24
PROGRESS 1200,1420 1400,80 92,100 #22C55E "好感度 92 / 100"
BAR 1200,1620 1400,260 "攻击:95,防御:80,智力:90,水群:99" #60A5FA
HEART 900,1960 70 F #EF4444
HEART 1200,1960 70 F #EF4444
HEART 1500,1960 70 F #F87171
T 1200,2120 "老大专属 · 不许外传" #94A3B8 56 C
`;

const t0 = Date.now();
const r = await renderDraw(code, { image: loadImageCached });
console.log('耗时', Date.now() - t0, 'ms ｜尺寸', r.width + 'x' + r.height, '｜', r.png.length, '字节');
if (r.failed.length) console.log('失败图元:', r.failed);
writeFileSync('cache/draw-demo.png', r.png);
console.log('缓存命中测试（第二次应该一样快）');
