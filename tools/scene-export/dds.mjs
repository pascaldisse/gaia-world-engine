// dds.mjs — DDS (top mip) -> RGBA8 -> PNG. Zero deps. DXT1/3/5 (BC1/2/3) + uncompressed 32bpp/24bpp masks.
import { deflateSync } from 'node:zlib';

const fourcc = (b, o) => b.toString('latin1', o, o + 4);

function rgb565(c) { return [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0]; }

function decodeColorBlock(b, o, out, w, h, bx, by, mode, alphaBytes) {
  const c0 = b.readUInt16LE(o), c1 = b.readUInt16LE(o + 2), bits = b.readUInt32LE(o + 4);
  const p0 = rgb565(c0), p1 = rgb565(c1), pal = [p0, p1];
  const four = mode !== 'bc1' || c0 > c1;
  if (four) { pal.push(p0.map((v, i) => (2 * v + p1[i]) / 3 | 0), p0.map((v, i) => (v + 2 * p1[i]) / 3 | 0)); }
  else { pal.push(p0.map((v, i) => (v + p1[i]) / 2 | 0), [0, 0, 0]); }
  for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
    const x = bx * 4 + px, y = by * 4 + py; if (x >= w || y >= h) continue;
    const idx = (bits >> (2 * (py * 4 + px))) & 3, d = (y * w + x) * 4, c = pal[idx];
    out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2];
    out[d + 3] = mode === 'bc1' ? (!four && idx === 3 ? 0 : 255) : alphaBytes(px, py);
  }
}

export function decodeDds(buf) {
  if (buf.toString('latin1', 0, 4) !== 'DDS ') throw new Error('not DDS');
  const h = buf.readUInt32LE(12), w = buf.readUInt32LE(16), pfFlags = buf.readUInt32LE(80), cc = fourcc(buf, 84);
  const out = Buffer.alloc(w * h * 4);
  let off = 128, kind;
  if (pfFlags & 4) { // FOURCC
    kind = cc;
    if (cc === 'DX10') throw new Error('DDS DX10 header unsupported');
    const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
    if (cc === 'DXT1') { for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, off += 8) decodeColorBlock(buf, off, out, w, h, bx, by, 'bc1'); }
    else if (cc === 'DXT3') { for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, off += 16) {
      const a = off; decodeColorBlock(buf, off + 8, out, w, h, bx, by, 'bc2', (px, py) => { const v = (buf[a + py * 2 + (px >> 1)] >> ((px & 1) * 4)) & 15; return v * 17; }); } }
    else if (cc === 'DXT5') { for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++, off += 16) {
      const a0 = buf[off], a1 = buf[off + 1], t = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) t.push(((7 - i) * a0 + i * a1) / 7 | 0); else { for (let i = 1; i < 5; i++) t.push(((5 - i) * a0 + i * a1) / 5 | 0); t.push(0, 255); }
      let lo = buf.readUInt32LE(off + 2), hi = buf.readUInt16LE(off + 6); const bits = BigInt(lo) | (BigInt(hi) << 32n);
      decodeColorBlock(buf, off + 8, out, w, h, bx, by, 'bc3', (px, py) => t[Number((bits >> BigInt(3 * (py * 4 + px))) & 7n)]); } }
    else throw new Error('DDS fourcc unsupported: ' + cc);
  } else if (pfFlags & 0x40) { // RGB masks
    const bpp = buf.readUInt32LE(88), rm = buf.readUInt32LE(92), gm = buf.readUInt32LE(96), bm = buf.readUInt32LE(100), am = buf.readUInt32LE(104), by = bpp >> 3;
    kind = `RGB${bpp}`;
    const sh = (m) => m ? 31 - Math.clz32(m & -m) : 0, mx = (m) => m ? m / (1 << sh(m)) : 1;
    for (let i = 0; i < w * h; i++, off += by) {
      const v = by === 4 ? buf.readUInt32LE(off) : by === 3 ? buf[off] | buf[off + 1] << 8 | buf[off + 2] << 16 : buf.readUInt16LE(off);
      out[i * 4] = ((v & rm) >>> sh(rm)) * 255 / mx(rm); out[i * 4 + 1] = ((v & gm) >>> sh(gm)) * 255 / mx(gm); out[i * 4 + 2] = ((v & bm) >>> sh(bm)) * 255 / mx(bm);
      out[i * 4 + 3] = am ? ((v & am) >>> sh(am)) * 255 / mx(am) : 255;
    }
  } else throw new Error('DDS pixel format unsupported flags=' + pfFlags);
  return { width: w, height: h, rgba: out, kind };
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }

export function encodePng(width, height, rgba) {
  let opaque = true; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const ch = opaque ? 3 : 4, row = width * ch + 1, raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < ch; c++) raw[y * row + 1 + x * ch + c] = rgba[(y * width + x) * 4 + c];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
