/**
 * 生成应用图标（无第三方依赖，手写 PNG 编码）
 * 运行：node make-icons.mjs
 * 产出：assets/tray.png (32x32) / assets/icon.png (256x256)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** 画一个红色圆 + 白色播放三角 */
function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3; // 超采样抗锯齿
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.47;

  const tri = [
    [0.355 * size, 0.265 * size],
    [0.355 * size, 0.735 * size],
    [0.755 * size, 0.5 * size],
  ];
  const [A, B, C] = tri;

  const inTri = (px, py) => {
    const d1 = (px - B[0]) * (A[1] - B[1]) - (A[0] - B[0]) * (py - B[1]);
    const d2 = (px - C[0]) * (B[1] - C[1]) - (B[0] - C[0]) * (py - C[1]);
    const d3 = (px - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (py - A[1]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0, gs = 0, bs = 0, as = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (Math.hypot(px - cx, py - cy) > R) continue;
          if (inTri(px, py)) {
            rs += 255; gs += 255; bs += 255; as += 255;
          } else {
            // 品牌红 #FF2D55，带一点纵向渐变让图标更有质感
            const k = 0.88 + 0.12 * (1 - y / size);
            rs += 255 * k; gs += 45 * k; bs += 85 * k; as += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(rs / n);
      buf[i + 1] = Math.round(gs / n);
      buf[i + 2] = Math.round(bs / n);
      buf[i + 3] = Math.round(as / n);
    }
  }
  return buf;
}

const outDir = path.join(ROOT, 'assets');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, size] of [['tray.png', 32], ['icon.png', 256]]) {
  const png = encodePng(size, render(size));
  const p = path.join(outDir, name);
  fs.writeFileSync(p, png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
console.log('图标已生成到 assets/');
