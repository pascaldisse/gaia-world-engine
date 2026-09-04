// Unity stable-hash (XXH64-based) fileID derivation, shared by convert-model.mjs
// and emit.mjs. Also parses .fbx.meta externalObjects material remaps.

import path from 'node:path';

const XXH64_MASK = (1n << 64n) - 1n;
const XXH64_P1 = 0x9E3779B185EBCA87n;
const XXH64_P2 = 0xC2B2AE3D27D4EB4Fn;
const XXH64_P3 = 0x165667B19E3779F9n;
const XXH64_P4 = 0x85EBCA77C2B2AE63n;
const XXH64_P5 = 0x27D4EB2F165667C5n;

function u64(x) { return x & XXH64_MASK; }
function rotl(x, r) { return u64((x << BigInt(r)) | (x >> BigInt(64 - r))); }
function readU32LE(buf, off) {
  return BigInt(buf[off]) | (BigInt(buf[off + 1]) << 8n) | (BigInt(buf[off + 2]) << 16n) | (BigInt(buf[off + 3]) << 24n);
}
function readU64LE(buf, off) {
  return readU32LE(buf, off) | (readU32LE(buf, off + 4) << 32n);
}
function round(acc, input) {
  acc = u64(acc + u64(input * XXH64_P2));
  acc = rotl(acc, 31);
  acc = u64(acc * XXH64_P1);
  return acc;
}
function mergeRound(acc, val) {
  val = round(0n, val);
  acc = u64(acc ^ val);
  acc = u64(u64(acc * XXH64_P1) + XXH64_P4);
  return acc;
}
function avalanche(h) {
  h = u64(h ^ (h >> 33n));
  h = u64(h * XXH64_P2);
  h = u64(h ^ (h >> 29n));
  h = u64(h * XXH64_P3);
  h = u64(h ^ (h >> 32n));
  return h;
}
export function xxh64(input, seed = 0n) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const len = buf.length;
  let off = 0;
  let h;
  seed = u64(seed);
  if (len >= 32) {
    let v1 = u64(seed + XXH64_P1 + XXH64_P2);
    let v2 = u64(seed + XXH64_P2);
    let v3 = seed;
    let v4 = u64(seed - XXH64_P1);
    const limit = len - 32;
    while (off <= limit) {
      v1 = round(v1, readU64LE(buf, off)); off += 8;
      v2 = round(v2, readU64LE(buf, off)); off += 8;
      v3 = round(v3, readU64LE(buf, off)); off += 8;
      v4 = round(v4, readU64LE(buf, off)); off += 8;
    }
    h = u64(rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18));
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = u64(seed + XXH64_P5);
  }
  h = u64(h + BigInt(len));
  while (off + 8 <= len) {
    const k1 = round(0n, readU64LE(buf, off));
    h = u64(h ^ k1);
    h = u64(u64(rotl(h, 27) * XXH64_P1) + XXH64_P4);
    off += 8;
  }
  if (off + 4 <= len) {
    h = u64(h ^ u64(readU32LE(buf, off) * XXH64_P1));
    h = u64(u64(rotl(h, 23) * XXH64_P2) + XXH64_P3);
    off += 4;
  }
  while (off < len) {
    h = u64(h ^ u64(BigInt(buf[off]) * XXH64_P5));
    h = u64(rotl(h, 11) * XXH64_P1);
    off += 1;
  }
  return avalanche(h);
}
export function signed(n) { return BigInt.asIntN(64, n).toString(); }

function safeSlug(s) {
  return String(s ?? '').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}
export function safeBase(file) { return safeSlug(path.basename(file, path.extname(file))) || 'model'; }

export function unitySubAssetFileID(typeName, name, x = 0) {
  return signed(xxh64(`Type:${typeName}->${name}${x}`, 0n));
}

export function parseExternalObjectsMaterials(metaText) {
  const out = [];
  const re = /- first:\s*\n\s*type: UnityEngine:Material[\s\S]*?name: (.+?)\s*\n\s*second: \{fileID: (-?\d+), guid: ([0-9a-fA-F]{32}), type: \d+\}/g;
  let m;
  while ((m = re.exec(metaText))) {
    out.push({ name: m[1], fileID: m[2], guid: m[3] });
  }
  return out;
}

// Unity .meta files record sub-asset (fileID -> name) recycle tables in one of
// two shapes: a flat `fileIDToRecycleName:` map (legacy) or an entry-list
// `internalIDToNameTable:` (also legacy, but serialized differently). Both can
// resolve gen-1/legacy fileIDs (e.g. Mesh class 4300000-style IDs) to the
// sub-asset name that the stable-hash scheme would otherwise miss.
export function parseMetaRecycleNames(metaText) {
  const map = new Map();

  // (a) flat map: fileIDToRecycleName:\n    <fileID>: <name>\n ...
  const lines = metaText.split(/\r?\n/);
  const flatLineIndex = lines.findIndex((l) => l.includes('fileIDToRecycleName:'));
  if (flatLineIndex !== -1) {
    for (let i = flatLineIndex + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s+(-?\d+):\s*(.+?)\s*$/);
      if (!m) break;
      map.set(m[1], m[2]);
    }
  }

  // (b) entry list: internalIDToNameTable:\n  - first:\n      43: 4300002\n    second: Name
  const entryRe = /-\s*first:\s*\n\s+-?\d+:\s*(-?\d+)\s*\n\s+second:\s*(.+)/g;
  let m;
  while ((m = entryRe.exec(metaText))) {
    map.set(m[1], m[2].trim());
  }

  return map;
}
