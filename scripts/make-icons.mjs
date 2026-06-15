// make-icons.mjs — render shelf's icon at 16/48/128 with zero dependencies.
// Pure Node: draw coloured book spines into an RGBA buffer, encode a PNG by hand
// (zlib is built in). Run: `node scripts/make-icons.mjs`.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");

// Design in a 128×128 space (matches icon.svg).
const LEATHER = [122, 74, 36];
const SHELF = [63, 37, 16];
const SPINES = [
  { x: 28, y: 34, w: 14, h: 58, c: [59, 130, 246] }, // blue
  { x: 44, y: 42, w: 13, h: 50, c: [239, 68, 68] },  // red
  { x: 59, y: 30, w: 14, h: 62, c: [34, 197, 94] },  // green
  { x: 75, y: 40, w: 12, h: 52, c: [234, 179, 8] },  // yellow
  { x: 88, y: 36, w: 13, h: 56, c: [168, 85, 247] }, // purple
];
const SHELF_RECT = { x: 22, y: 92, w: 84, h: 9 };

function render(size) {
  const s = size / 128;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  };
  const rect = (rx, ry, rw, rh, color) => {
    const x0 = Math.round(rx * s), y0 = Math.round(ry * s);
    const x1 = Math.round((rx + rw) * s), y1 = Math.round((ry + rh) * s);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, color);
  };

  rect(0, 0, 128, 128, LEATHER);                                   // binding
  for (const sp of SPINES) rect(sp.x, sp.y, sp.w, sp.h, sp.c);     // spines
  rect(SHELF_RECT.x, SHELF_RECT.y, SHELF_RECT.w, SHELF_RECT.h, SHELF); // shelf
  return buf;
}

// --- minimal PNG encoder ---------------------------------------------------

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // raw scanlines, each prefixed with filter byte 0 (none)
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync(ICONS_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePng(size, render(size));
  writeFileSync(join(ICONS_DIR, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png (${png.length} bytes)`);
}
