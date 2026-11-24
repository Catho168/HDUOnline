/**
 * 生成扩展图标（16/32/48/128 PNG）。
 *
 * 为什么用脚本生成而非二进制资源：图标是纯几何图形，脚本可版本化、
 * 可复现，且避免把二进制文件塞进仓库。运行：`node scripts/make-icons.mjs`
 *
 * 设计：圆角方形底（品牌蓝 #2b6cff 渐变）+ 白色"学士帽"符号（菱形帽体 + 帽穗），
 * 与"课堂/学习"语义一致，小尺寸下仍可辨识。
 */

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(root, 'public', 'icon');
const SIZES = [16, 32, 48, 128];

// ───────────────────────── PNG 编码 ─────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ───────────────────────── 绘制 ─────────────────────────

const SAMPLES = 4; // 每像素 4×4 超采样，得到平滑边缘

/** 圆角方形覆盖率（含超采样） */
function roundedSquareCoverage(px, py, size) {
  const radius = size * 0.22;
  // 距离圆角矩形中心的"外部距离"
  const cx = Math.min(Math.max(px, radius), size - radius);
  const cy = Math.min(Math.max(py, radius), size - radius);
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist <= radius ? 1 : 0;
}

/** 学士帽符号覆盖率：菱形帽体 + 帽穗 */
function capCoverage(px, py, size) {
  const cx = size / 2;
  const cy = size * 0.47;
  const halfW = size * 0.30;
  const halfH = size * 0.16;
  // 菱形：|dx|/halfW + |dy|/halfH <= 1
  const dx = Math.abs(px - cx) / halfW;
  const dy = Math.abs(py - cy) / halfH;
  if (dx + dy <= 1) return 1;

  // 帽下的书本横条
  const barTop = cy + halfH * 0.55;
  const barBottom = barTop + size * 0.13;
  const barLeft = cx - size * 0.19;
  const barRight = cx + size * 0.19;
  if (py >= barTop && py <= barBottom && px >= barLeft && px <= barRight) return 1;

  // 帽穗（右侧垂线 + 末端点）
  const tasselX = cx + halfW * 0.86;
  const tasselTop = cy;
  const tasselBottom = cy + size * 0.34;
  if (py >= tasselTop && py <= tasselBottom && Math.abs(px - tasselX) <= size * 0.028) return 1;
  const dotR = size * 0.052;
  const ddx = px - tasselX;
  const ddy = py - tasselBottom;
  if (ddx * ddx + ddy * ddy <= dotR * dotR) return 1;
  return 0;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgAlpha = 0;
      let fgAlpha = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = x + (sx + 0.5) / SAMPLES;
          const py = y + (sy + 0.5) / SAMPLES;
          bgAlpha += roundedSquareCoverage(px, py, size);
          fgAlpha += capCoverage(px, py, size);
        }
      }
      const total = SAMPLES * SAMPLES;
      const bg = bgAlpha / total;
      const fg = Math.min(fgAlpha / total, bg);

      // 底色：竖向渐变（#3d7bff → #1c4fd6）
      const t = y / Math.max(1, size - 1);
      const r = Math.round(0x3d + (0x1c - 0x3d) * t);
      const g = Math.round(0x7b + (0x4f - 0x7b) * t);
      const b = Math.round(0xff + (0xd6 - 0xff) * t);

      // 叠加白色符号
      const outR = Math.round(r * (1 - fg) + 255 * fg);
      const outG = Math.round(g * (1 - fg) + 255 * fg);
      const outB = Math.round(b * (1 - fg) + 255 * fg);

      const offset = (y * size + x) * 4;
      rgba[offset] = outR;
      rgba[offset + 1] = outG;
      rgba[offset + 2] = outB;
      rgba[offset + 3] = Math.round(bg * 255);
    }
  }
  return encodePng(size, size, rgba);
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  for (const size of SIZES) {
    const png = drawIcon(size);
    await writeFile(join(outputDir, `${size}.png`), png);
  }
  process.stdout.write(`[make-icons] 已生成 ${SIZES.length} 个图标 → public/icon/\n`);
}

main().catch((err) => {
  process.stderr.write(`[make-icons] 失败：${err?.message ?? err}\n`);
  process.exitCode = 1;
});
