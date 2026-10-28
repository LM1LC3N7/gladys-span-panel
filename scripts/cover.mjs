// Generates cover.png (800x534) for gladys-span-panel: plain Node, no dependency.
// (The drawing helpers of gladys-openems, approved.)
// A smart electrical panel with two columns of circuit breakers (most of
// them closed, one open), the sun and a battery feeding it, the house it
// powers and local network waves, on a navy-to-teal gradient (no brand
// logo). Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [30 + 20 * t, 60 + 110 * t, 110 + 60 * t]);
  }
}
const white = [255, 255, 255];
const dark = [30, 36, 60];
const orange = [250, 170, 60];
const green = [40, 140, 90];
const glass = [190, 215, 240];
const red = [230, 80, 70];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
// An arc of a ring, between two angles (radians, 0 = right, clockwise on screen).
const arc = (cx, cy, r, width, from, to, color) => {
  for (let y = Math.floor(cy - r - width); y <= cy + r + width; y += 1) {
    for (let x = Math.floor(cx - r - width); x <= cx + r + width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      if (angle < from || angle > to) continue;
      const a = Math.max(
        0,
        Math.min(1, width / 2 - Math.abs(Math.hypot(x - cx, y - cy) - r) + 0.5),
      );
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Rounded rectangle, anti-aliased corners.
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};
// Soft halo.
disc(400, 270, 250, white, 0.07);

// The sun and its rays.
disc(120, 105, 38, orange);
for (let k = 0; k < 8; k += 1) {
  const a = (k * Math.PI) / 4;
  line(
    120 + 52 * Math.cos(a),
    105 + 52 * Math.sin(a),
    120 + 70 * Math.cos(a),
    105 + 70 * Math.sin(a),
    6,
    orange,
  );
}

// A battery.
box(80, 300, 180, 440, 14, white);
box(110, 286, 150, 302, 4, white);
for (let i = 0; i < 3; i += 1) box(95, 410 - i * 38, 165, 438 - i * 38, 6, green);

// The panel: a tall cabinet, two columns of breakers, a status light.
box(300, 70, 500, 470, 18, white);
box(318, 88, 482, 452, 10, dark);
for (let row = 0; row < 8; row += 1) {
  for (const col of [0, 1]) {
    const x = 334 + col * 78;
    const y = 104 + row * 42;
    const open = row === 5 && col === 1;
    box(x, y, x + 58, y + 30, 6, glass);
    box(open ? x + 6 : x + 30, y + 6, open ? x + 28 : x + 52, y + 24, 4, open ? red : green);
  }
}
disc(400, 440, 6, green);

// The house.
for (let y = 200; y < 290; y += 1) {
  const half = ((y - 200) / 90) * 100;
  for (let x = Math.floor(660 - half); x <= 660 + half; x += 1) set(x, y, white);
}
box(578, 288, 742, 440, 6, white);
box(638, 360, 682, 440, 6, dark);
box(596, 308, 628, 340, 4, glass);
box(692, 308, 724, 340, 4, glass);

// Power flows: sun and battery -> panel -> house.
line(160, 150, 300, 200, 7, orange);
line(180, 370, 300, 370, 7, orange);
line(500, 330, 578, 330, 7, orange);
disc(240, 370, 8, white);
disc(540, 330, 8, white);

// Local network waves above the panel (no cloud).
for (const r of [20, 38, 56]) {
  arc(400, 52, r, 8, -2.4, -0.74, white);
}
disc(400, 52, 6, white);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
