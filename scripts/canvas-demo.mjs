import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';

// 注册服务器上现成的中文字体
const ok = GlobalFonts.registerFromPath('/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf', 'Droid');
console.log('中文字体注册:', ok);

const W = 1200, H = 900;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// 1) 渐变背景
const bg = ctx.createLinearGradient(0, 0, W, H);
bg.addColorStop(0, '#1b1030');
bg.addColorStop(1, '#2d1b4e');
ctx.fillStyle = bg;
ctx.fillRect(0, 0, W, H);

// 2) 圆角矩形卡片（带阴影）
ctx.save();
ctx.shadowColor = 'rgba(0,0,0,0.5)';
ctx.shadowBlur = 30;
ctx.shadowOffsetY = 10;
ctx.fillStyle = '#ffffff';
ctx.beginPath();
ctx.roundRect(80, 80, W - 160, H - 160, 40);
ctx.fill();
ctx.restore();

// 3) 圆 + 描边
ctx.beginPath();
ctx.arc(280, 320, 110, 0, Math.PI * 2);
ctx.fillStyle = '#ff4d6d';
ctx.fill();
ctx.lineWidth = 10;
ctx.strokeStyle = '#ffd166';
ctx.stroke();

// 4) 直线 + 箭头
ctx.beginPath();
ctx.moveTo(430, 320);
ctx.lineTo(700, 320);
ctx.lineWidth = 8;
ctx.strokeStyle = '#3B82F6';
ctx.stroke();
ctx.beginPath();
ctx.moveTo(700, 320);
ctx.lineTo(670, 300);
ctx.lineTo(670, 340);
ctx.closePath();
ctx.fillStyle = '#3B82F6';
ctx.fill();

// 5) 中文文字
ctx.fillStyle = '#1b1030';
ctx.font = 'bold 64px Droid';
ctx.fillText('柚子画板测试 · Canvas OK', 200, 560);

ctx.font = '40px Droid';
ctx.fillStyle = '#6b7280';
ctx.fillText('中文正常、圆角、渐变、阴影、描边、箭头全通过', 200, 640);

// 6) 导出 PNG
const png = canvas.toBuffer('image/png');
writeFileSync('/root/QQBOT/maid-bot/cache/canvas-demo.png', png);
console.log('PNG 已生成:', png.length, '字节');
