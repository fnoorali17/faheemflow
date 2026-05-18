// Pure Node.js PNG icon generator — no external dependencies
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── PNG encoder ──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const tBuf = Buffer.from(type);
  const len  = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const cBuf = Buffer.alloc(4); cBuf.writeUInt32BE(crc32(Buffer.concat([tBuf, data])));
  return Buffer.concat([len, tBuf, data, cBuf]);
}
function encodePNG(pixels, w, h) {
  // Build filter-0 rows
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      row.writeUInt8(pixels[si],     x * 4);
      row.writeUInt8(pixels[si + 1], x * 4 + 1);
      row.writeUInt8(pixels[si + 2], x * 4 + 2);
      row.writeUInt8(pixels[si + 3], x * 4 + 3);
    }
    rows.push(Buffer.concat([Buffer.from([0]), row]));
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ── Canvas helpers ────────────────────────────────────────────
function makeCanvas(w, h) {
  const px = new Uint8Array(w * h * 4);
  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    const af = a / 255;
    px[i]     = Math.round(px[i]     * (1 - af) + r * af);
    px[i + 1] = Math.round(px[i + 1] * (1 - af) + g * af);
    px[i + 2] = Math.round(px[i + 2] * (1 - af) + b * af);
    px[i + 3] = 255;
  }
  function fill(r, g, b) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(x, y, r, g, b);
  }
  function drawLine(x0, y0, x1, y1, r, g, b, a = 255, thick = 1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    const half = Math.floor(thick / 2);
    while (true) {
      for (let tx = -half; tx <= half; tx++)
        for (let ty = -half; ty <= half; ty++)
          setPixel(x0 + tx, y0 + ty, r, g, b, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 <  dx) { err += dx; y0 += sy; }
    }
  }
  function drawHex(cx, cy, rad, r, g, b, a = 255, thick = 2) {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const ang = (Math.PI / 3) * i - Math.PI / 6;
      return [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
    });
    for (let i = 0; i < 6; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % 6];
      drawLine(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), r, g, b, a, thick);
    }
  }
  function fillCircle(cx, cy, rad, r, g, b, a = 255) {
    for (let y = cy - rad; y <= cy + rad; y++)
      for (let x = cx - rad; x <= cx + rad; x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2) setPixel(x, y, r, g, b, a);
  }
  return { px, fill, drawLine, drawHex, fillCircle };
}

// ── Icon drawing ─────────────────────────────────────────────
function generateIcon(size) {
  const { px, fill, drawLine, drawHex, fillCircle } = makeCanvas(size, size);
  const cx = Math.round(size / 2), cy = Math.round(size / 2);
  const outerR = Math.round(size * 0.389);  // ~70 at 180px
  const innerR = Math.round(size * 0.289);  // ~52 at 180px
  const dotR   = Math.max(1, Math.round(size * 0.044)); // ~8 at 180px
  const thick  = Math.max(1, Math.round(size * 0.017)); // ~3 at 180px
  const [gr, gg, gb] = [196, 146, 42];      // #c4922a

  fill(26, 23, 20); // #1a1714 background

  drawHex(cx, cy, outerR, gr, gg, gb, 255, thick);
  drawHex(cx, cy, innerR, gr, gg, gb, 128, thick);
  fillCircle(cx, cy, dotR, gr, gg, gb);

  // Cardinal lines between inner and outer hex (N/S/E/W)
  drawLine(cx, cy - outerR, cx, cy - innerR, gr, gg, gb, 255, thick);
  drawLine(cx, cy + innerR, cx, cy + outerR, gr, gg, gb, 255, thick);
  drawLine(cx - outerR, cy, cx - innerR, cy, gr, gg, gb, 255, thick);
  drawLine(cx + innerR, cy, cx + outerR, cy, gr, gg, gb, 255, thick);

  return encodePNG(px, size, size);
}

// ── Generate files ────────────────────────────────────────────
const root = path.join(__dirname, '..');
fs.writeFileSync(path.join(root, 'public', 'apple-touch-icon.png'), generateIcon(180));
console.log('Generated public/apple-touch-icon.png (180×180)');
fs.writeFileSync(path.join(root, 'public', 'favicon.png'), generateIcon(32));
console.log('Generated public/favicon.png (32×32)');
