// Dependency-free ZIP read/write helpers for browser and Node.
// Supports plain ZIP32 archives, stored entries, and deflate-raw reads.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8');

let crcTable = null;

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('expected Uint8Array-compatible bytes');
}

function u16le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function putU16le(out, off, value) {
  out[off] = value & 0xff;
  out[off + 1] = (value >>> 8) & 0xff;
}

function putU32le(out, off, value) {
  out[off] = value & 0xff;
  out[off + 1] = (value >>> 8) & 0xff;
  out[off + 2] = (value >>> 16) & 0xff;
  out[off + 3] = (value >>> 24) & 0xff;
}

function checkRange(bytes, off, len, what) {
  if (off < 0 || len < 0 || off + len > bytes.length) throw new RangeError(`truncated ZIP ${what}`);
}

function findEndOfCentralDirectory(bytes) {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let p = bytes.length - 22; p >= min; p -= 1) {
    if (u32le(bytes, p) === 0x06054b50) return p;
  }
  throw new Error('ZIP end-of-central-directory not found');
}

async function inflateRaw(bytes) {
  if (globalThis.DecompressionStream) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const nodeZlib = 'node:zlib';
  const { inflateRawSync } = await import(nodeZlib);
  const inflated = inflateRawSync(bytes);
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
}

export function crc32(bytes) {
  bytes = asUint8Array(bytes);
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let bit = 0; bit < 8; bit += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function readZip(bytes) {
  bytes = asUint8Array(bytes);
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = u16le(bytes, eocd + 4);
  const cdDisk = u16le(bytes, eocd + 6);
  const entriesOnDisk = u16le(bytes, eocd + 8);
  const totalEntries = u16le(bytes, eocd + 10);
  const centralDirSize = u32le(bytes, eocd + 12);
  const centralDirOffset = u32le(bytes, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) throw new Error('multi-disk ZIP archives are not supported');
  if (totalEntries === 0xffff || centralDirSize === 0xffffffff || centralDirOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  checkRange(bytes, centralDirOffset, centralDirSize, 'central directory');

  const out = new Map();
  let p = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    checkRange(bytes, p, 46, 'central directory header');
    if (u32le(bytes, p) !== 0x02014b50) throw new Error(`bad central directory header at ${p}`);
    const flags = u16le(bytes, p + 8);
    const method = u16le(bytes, p + 10);
    const expectedCrc = u32le(bytes, p + 16);
    const compressedSize = u32le(bytes, p + 20);
    const uncompressedSize = u32le(bytes, p + 24);
    const nameLen = u16le(bytes, p + 28);
    const extraLen = u16le(bytes, p + 30);
    const commentLen = u16le(bytes, p + 32);
    const localOffset = u32le(bytes, p + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported');
    }
    checkRange(bytes, p + 46, nameLen + extraLen + commentLen, 'central directory entry');
    const name = textDecoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    checkRange(bytes, localOffset, 30, `local header for ${name}`);
    if (u32le(bytes, localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const localFlags = u16le(bytes, localOffset + 6);
    const localMethod = u16le(bytes, localOffset + 8);
    const localNameLen = u16le(bytes, localOffset + 26);
    const localExtraLen = u16le(bytes, localOffset + 28);
    if (localMethod !== method) throw new Error(`central/local method mismatch for ${name}`);
    if ((localFlags & 0x0008) !== (flags & 0x0008)) throw new Error(`central/local flags mismatch for ${name}`);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    checkRange(bytes, dataStart, compressedSize, `data for ${name}`);
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let value;
    if (method === 0) {
      if (compressed.length !== uncompressedSize) throw new Error(`stored ZIP size mismatch for ${name}`);
      value = compressed.slice();
    } else if (method === 8) {
      value = await inflateRaw(compressed);
      if (value.length !== uncompressedSize) throw new Error(`deflated ZIP size mismatch for ${name}`);
    } else {
      throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    }
    if (crc32(value) !== expectedCrc) throw new Error(`CRC-32 mismatch for ${name}`);
    out.set(name, value);

    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== centralDirOffset + centralDirSize) throw new Error('central directory size mismatch');
  return out;
}

export function writeZip(entries) {
  if (!(entries instanceof Map)) throw new TypeError('writeZip expects a Map<string, Uint8Array>');
  const records = [];
  let localSize = 0;
  let centralSize = 0;

  for (const [name, dataBytes] of entries) {
    if (typeof name !== 'string') throw new TypeError('ZIP entry names must be strings');
    const nameBytes = textEncoder.encode(name);
    const data = asUint8Array(dataBytes);
    if (nameBytes.length > 0xffff) throw new RangeError(`ZIP entry name too long: ${name}`);
    if (data.length > 0xffffffff) throw new RangeError(`ZIP entry too large: ${name}`);
    if (localSize > 0xffffffff) throw new RangeError('ZIP archive too large');
    const crc = crc32(data);
    const localOffset = localSize;
    records.push({ name, nameBytes, data, crc, localOffset });
    localSize += 30 + nameBytes.length + data.length;
    centralSize += 46 + nameBytes.length;
  }

  if (localSize > 0xffffffff || centralSize > 0xffffffff || records.length > 0xffff) throw new RangeError('ZIP archive too large');
  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) throw new RangeError('ZIP archive too large');
  const out = new Uint8Array(totalSize);
  let p = 0;

  for (const rec of records) {
    putU32le(out, p, 0x04034b50);
    putU16le(out, p + 4, 20); // version needed
    putU16le(out, p + 6, 0x0800); // UTF-8 names
    putU16le(out, p + 8, 0); // stored
    putU16le(out, p + 10, 0); // mod time
    putU16le(out, p + 12, 0); // mod date
    putU32le(out, p + 14, rec.crc);
    putU32le(out, p + 18, rec.data.length);
    putU32le(out, p + 22, rec.data.length);
    putU16le(out, p + 26, rec.nameBytes.length);
    putU16le(out, p + 28, 0);
    p += 30;
    out.set(rec.nameBytes, p);
    p += rec.nameBytes.length;
    out.set(rec.data, p);
    p += rec.data.length;
  }

  const centralDirOffset = p;
  for (const rec of records) {
    putU32le(out, p, 0x02014b50);
    putU16le(out, p + 4, 20); // version made by
    putU16le(out, p + 6, 20); // version needed
    putU16le(out, p + 8, 0x0800); // UTF-8 names
    putU16le(out, p + 10, 0); // stored
    putU16le(out, p + 12, 0); // mod time
    putU16le(out, p + 14, 0); // mod date
    putU32le(out, p + 16, rec.crc);
    putU32le(out, p + 20, rec.data.length);
    putU32le(out, p + 24, rec.data.length);
    putU16le(out, p + 28, rec.nameBytes.length);
    putU16le(out, p + 30, 0);
    putU16le(out, p + 32, 0);
    putU16le(out, p + 34, 0);
    putU16le(out, p + 36, 0);
    putU32le(out, p + 38, 0);
    putU32le(out, p + 42, rec.localOffset);
    p += 46;
    out.set(rec.nameBytes, p);
    p += rec.nameBytes.length;
  }

  const centralDirSize = p - centralDirOffset;
  putU32le(out, p, 0x06054b50);
  putU16le(out, p + 4, 0);
  putU16le(out, p + 6, 0);
  putU16le(out, p + 8, records.length);
  putU16le(out, p + 10, records.length);
  putU32le(out, p + 12, centralDirSize);
  putU32le(out, p + 16, centralDirOffset);
  putU16le(out, p + 20, 0);
  p += 22;
  if (p !== out.length) throw new Error('internal ZIP writer size mismatch');
  return out;
}
