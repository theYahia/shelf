// make-demo.mjs — render shelf's before/after self-demo as an animated APNG,
// with zero dependencies (built-in zlib). Run: `node scripts/make-demo.mjs`.
// GitHub renders APNG inline in the README, so the repo demonstrates itself.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "demo.png");

const W = 460;
const H = 130;

const PAPER = [244, 236, 224];
const SHELF = [122, 74, 36];
const GREY_A = [201, 188, 166];
const GREY_B = [188, 175, 151];
const GROUPS = [
  [59, 130, 246], // blue
  [239, 68, 68],  // red
  [34, 197, 94],  // green
  [234, 179, 8],  // yellow
];
const lighten = ([r, g, b], t) => [
  Math.round(r + (255 - r) * t),
  Math.round(g + (255 - g) * t),
  Math.round(b + (255 - b) * t),
];

function frameBuffer() {
  const buf = Buffer.alloc(W * H * 4);
  // paper background
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = PAPER[0]; buf[i * 4 + 1] = PAPER[1]; buf[i * 4 + 2] = PAPER[2]; buf[i * 4 + 3] = 255;
  }
  return buf;
}
function rect(buf, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= H) continue;
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || x >= W) continue;
      const i = (y * W + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
}

// --- the three frames ------------------------------------------------------

// 0: BEFORE — one screaming row of identical grey tabs.
function frameBefore() {
  const buf = frameBuffer();
  for (let i = 0; i < 12; i++) {
    rect(buf, 18 + i * 36, 30, 30, 70, i % 2 ? GREY_A : GREY_B);
  }
  return buf;
}

// 1: AFTER — four coloured shelves, each a header bar + a few tabs, with gaps.
function frameAfter() {
  const buf = frameBuffer();
  const perGroup = 3;
  for (let g = 0; g < 4; g++) {
    const color = GROUPS[g];
    const gx = 18 + g * 112;
    rect(buf, gx, 26, 96, 8, color);          // coloured shelf header (the spine)
    for (let t = 0; t < perGroup; t++) {
      rect(buf, gx + t * 34, 38, 30, 62, lighten(color, 0.62)); // tabs under it
    }
  }
  return buf;
}

// 2: AFTER, hushed — the shelves collapsed to slim coloured plaques.
function frameCollapsed() {
  const buf = frameBuffer();
  for (let g = 0; g < 4; g++) {
    rect(buf, 18 + g * 112, 56, 96, 16, GROUPS[g]); // just the spines, stacked tidy
  }
  rect(buf, 18, 80, 408, 4, [...SHELF]); // the shelf line under them
  return buf;
}

// --- minimal APNG encoder --------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function zlibFrame(rgba) {
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return deflateSync(raw, { level: 9 });
}

function encodeApng(frames, delaysCs) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0); // num_frames
  actl.writeUInt32BE(0, 4);             // num_plays = infinite

  const parts = [sig, chunk("IHDR", ihdr), chunk("acTL", actl)];
  let seq = 0;

  frames.forEach((rgba, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);        // sequence_number
    fctl.writeUInt32BE(W, 4);
    fctl.writeUInt32BE(H, 8);
    fctl.writeUInt32BE(0, 12);           // x_offset
    fctl.writeUInt32BE(0, 16);           // y_offset
    fctl.writeUInt16BE(delaysCs[i], 20); // delay_num (centiseconds)
    fctl.writeUInt16BE(100, 22);         // delay_den
    fctl[24] = 0;                        // dispose_op = NONE
    fctl[25] = 0;                        // blend_op = SOURCE
    parts.push(chunk("fcTL", fctl));

    const data = zlibFrame(rgba);
    if (i === 0) {
      parts.push(chunk("IDAT", data));   // first frame is the default image
    } else {
      const fdat = Buffer.alloc(4 + data.length);
      fdat.writeUInt32BE(seq++, 0);
      data.copy(fdat, 4);
      parts.push(chunk("fdAT", fdat));
    }
  });

  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const frames = [frameBefore(), frameAfter(), frameCollapsed()];
const delays = [140, 200, 150]; // centiseconds: 1.4s before, 2.0s after, 1.5s hushed
mkdirSync(dirname(OUT), { recursive: true });
const apng = encodeApng(frames, delays);
writeFileSync(OUT, apng);
console.log(`wrote assets/demo.png — animated APNG, ${frames.length} frames, ${apng.length} bytes`);
