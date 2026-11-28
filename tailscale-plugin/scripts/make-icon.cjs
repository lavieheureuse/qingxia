'use strict';

// 纯 Node.js（仅用内置 zlib）生成 256x256 正方形 PNG 插件图标，零 Python/Pillow 依赖。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
const TOP_COLOR = [61, 110, 82];
const BOTTOM_COLOR = [31, 61, 44];
const DOT_COLOR = [246, 249, 242];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function roundedRectAlpha(x, y, size, radius) {
  const cx = Math.max(radius, Math.min(size - 1 - radius, x));
  const cy = Math.max(radius, Math.min(size - 1 - radius, y));
  const dist = Math.hypot(x - cx, y - cy);
  if (dist <= radius - 0.5) return 1;
  if (dist >= radius + 0.5) return 0;
  return radius + 0.5 - dist;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function generatePngBuffer(size = SIZE) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const cornerRadius = size * 0.22;

  // 3x3 Tailscale 风格网格节点，突出中心直连十字与外围低透明度节点
  const coords = [0.27, 0.5, 0.73].map((r) => r * size);
  const dots = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const isLit = row === 1 || (row === 0 && col === 1) || (row === 2 && col === 1);
      dots.push({
        x: coords[col],
        y: coords[row],
        r: size * (row === 1 && col === 1 ? 0.068 : 0.056),
        alpha: isLit ? 1 : 0.34,
      });
    }
  }

  // P2P 网格连线（连接中心十字）
  const lines = [
    [coords[0], coords[1], coords[2], coords[1]],
    [coords[1], coords[0], coords[1], coords[2]],
  ];

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter None
    const t = y / (size - 1);
    const bgR = Math.round(TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * t);
    const bgG = Math.round(TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t);
    const bgB = Math.round(TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t);

    for (let x = 0; x < size; x += 1) {
      const bgAlpha = roundedRectAlpha(x, y, size, cornerRadius);
      let fgAlpha = 0;

      for (const [x1, y1, x2, y2] of lines) {
        const d = distToSegment(x, y, x1, y1, x2, y2);
        const lineHalf = size * 0.017;
        if (d < lineHalf + 0.8) {
          fgAlpha = Math.max(fgAlpha, Math.min(1, lineHalf + 0.8 - d) * 0.48);
        }
      }

      for (const dot of dots) {
        const d = Math.hypot(x - dot.x, y - dot.y);
        if (d < dot.r + 0.8) {
          const cov = Math.max(0, Math.min(1, dot.r + 0.8 - d));
          fgAlpha = Math.max(fgAlpha, cov * dot.alpha);
        }
      }

      const r = Math.round(bgR * (1 - fgAlpha) + DOT_COLOR[0] * fgAlpha);
      const g = Math.round(bgG * (1 - fgAlpha) + DOT_COLOR[1] * fgAlpha);
      const b = Math.round(bgB * (1 - fgAlpha) + DOT_COLOR[2] * fgAlpha);
      const a = Math.round(bgAlpha * 255);

      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

if (require.main === module) {
  const out = path.resolve(__dirname, '..', 'logo.png');
  const buf = generatePngBuffer(SIZE);
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out} (${SIZE}x${SIZE}, ${buf.length} bytes)`);
}

module.exports = { generatePngBuffer };
