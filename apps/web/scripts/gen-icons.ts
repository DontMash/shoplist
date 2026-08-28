import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generates all PNG icons for the PWA without any dependencies.
 * Design: rounded green square with a white checkmark.
 * Run: pnpm icons
 */

const OUT = path.join(__dirname, '..', 'public', 'icons');

const GREEN = [22, 163, 74];    // #16a34a
const GREEN_DARK = [21, 128, 61]; // #15803d

// ------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(size, pixelFn) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- geometry

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1));
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}

// ------------------------------------------------------------- icon drawing

/**
 * Draws the icon with 3x3 supersampling.
 * maskable=true renders a full-bleed background with the glyph shrunk
 * into the safe zone (80%).
 */
function drawIcon(size, { maskable = false } = {}) {
  const SS = 3;
  const s = maskable ? 0.72 : 1; // glyph scale (safe zone)
  const lw = 0.105 / s;          // stroke width in transformed space

  return png(size, (px, py) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const nx = (px + (sx + 0.5) / SS) / size;
        const ny = (py + (sy + 0.5) / SS) / size;

        let cr = 0, cg = 0, cb = 0, ca = 0;
        const isBg = maskable || inRoundedRect(nx, ny, 0.02, 0.02, 0.98, 0.98, 0.22);
        if (isBg) {
          const t = clamp01((ny - 0.02) / 0.96);
          cr = GREEN[0] + (GREEN_DARK[0] - GREEN[0]) * t;
          cg = GREEN[1] + (GREEN_DARK[1] - GREEN[1]) * t;
          cb = GREEN[2] + (GREEN_DARK[2] - GREEN[2]) * t;
          ca = 255;

          // white checkmark, scaled around the center for maskable icons
          const x = 0.5 + (nx - 0.5) / s;
          const y = 0.5 + (ny - 0.5) / s;
          const d = Math.min(
            distToSeg(x, y, 0.24, 0.53, 0.43, 0.72),
            distToSeg(x, y, 0.43, 0.72, 0.78, 0.30),
          );
          if (d <= lw / 2) { cr = 255; cg = 255; cb = 255; }
        }
        r += cr; g += cg; b += cb; a += ca;
      }
    }
    const n = SS * SS;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
  });
}

// ------------------------------------------------------------- main

fs.mkdirSync(OUT, { recursive: true });

const targets: Array<[string, number, boolean]> = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false],
];

for (const [name, size, maskable] of targets) {
  const buf = drawIcon(size, { maskable });
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`wrote public/icons/${name} (${buf.length} bytes)`);
}
