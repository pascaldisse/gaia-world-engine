// Lossless shallow protobuf transcoder for VRoid Studio v1model/data.bin.
// Mirrors docs/vroid_master.py: wire-2 payloads stay raw until an edit path is parsed.

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('expected Uint8Array-compatible bytes');
}

function readVarintNumber(bytes, pos) {
  let result = 0;
  let shift = 0;
  while (true) {
    if (pos >= bytes.length) throw new RangeError('truncated varint');
    const c = bytes[pos++];
    result += (c & 0x7f) * (2 ** shift);
    if ((c & 0x80) === 0) return [result, pos];
    shift += 7;
    if (shift > 56) throw new RangeError('varint too large for Number');
  }
}

function readVarintBig(bytes, pos) {
  let result = 0n;
  let shift = 0n;
  while (true) {
    if (pos >= bytes.length) throw new RangeError('truncated varint');
    const c = bytes[pos++];
    result |= BigInt(c & 0x7f) << shift;
    if ((c & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
}

function writeVarint(value) {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new RangeError('negative varint');
  const out = [];
  while (true) {
    let c = Number(v & 0x7fn);
    v >>= 7n;
    if (v) c |= 0x80;
    out.push(c);
    if (!v) return Uint8Array.from(out);
  }
}

function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function txt(payload) {
  if (!payload) return null;
  try {
    return utf8Decoder.decode(payload);
  } catch {
    return null;
  }
}

function f32le(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, Number(value), true);
  return out;
}

function readF32le(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return view.getFloat32(0, true);
}

export class Msg {
  constructor(entries = []) {
    this.entries = entries;
  }

  static parse(input) {
    const bytes = asUint8Array(input);
    const entries = [];
    let p = 0;
    const n = bytes.length;
    while (p < n) {
      const keyRead = readVarintNumber(bytes, p);
      const key = keyRead[0];
      p = keyRead[1];
      const fnum = key >> 3;
      const wt = key & 7;
      if (wt === 0) {
        const valueRead = readVarintBig(bytes, p);
        entries.push({ fnum, wt: 0, payload: valueRead[0] });
        p = valueRead[1];
      } else if (wt === 1) {
        if (p + 8 > n) throw new RangeError(`truncated fixed64 at ${p}`);
        entries.push({ fnum, wt: 1, payload: bytes.slice(p, p + 8) });
        p += 8;
      } else if (wt === 2) {
        const lenRead = readVarintNumber(bytes, p);
        const len = lenRead[0];
        p = lenRead[1];
        if (p + len > n) throw new RangeError(`truncated length-delimited field at ${p}`);
        entries.push({ fnum, wt: 2, payload: bytes.slice(p, p + len) });
        p += len;
      } else if (wt === 5) {
        if (p + 4 > n) throw new RangeError(`truncated fixed32 at ${p}`);
        entries.push({ fnum, wt: 5, payload: bytes.slice(p, p + 4) });
        p += 4;
      } else {
        throw new Error(`bad wiretype ${wt} at ${p}`);
      }
    }
    return new Msg(entries);
  }

  serialize() {
    const chunks = [];
    for (const entry of this.entries) {
      const { fnum, wt, payload } = entry;
      chunks.push(writeVarint((fnum << 3) | wt));
      if (wt === 0) {
        chunks.push(writeVarint(payload));
      } else if (wt === 1 || wt === 5) {
        chunks.push(asUint8Array(payload));
      } else if (wt === 2) {
        const bytes = asUint8Array(payload);
        chunks.push(writeVarint(bytes.length));
        chunks.push(bytes);
      } else {
        throw new Error(`bad wiretype ${wt}`);
      }
    }
    return concatChunks(chunks);
  }

  get(fnum, idx = 0) {
    let seen = 0;
    for (const entry of this.entries) {
      if (entry.fnum === fnum) {
        if (seen === idx) return [entry.wt, entry.payload];
        seen += 1;
      }
    }
    return [null, null];
  }

  all(fnum) {
    return this.entries.filter((entry) => entry.fnum === fnum).map((entry) => [entry.wt, entry.payload]);
  }

  setOrAdd(fnum, wt, payload) {
    for (let i = 0; i < this.entries.length; i += 1) {
      if (this.entries[i].fnum === fnum) {
        this.entries[i] = { fnum, wt, payload };
        return;
      }
    }
    this.entries.push({ fnum, wt, payload });
  }

  // Python-name alias for callers following docs/vroid_master.py directly.
  set_or_add(fnum, wt, payload) {
    this.setOrAdd(fnum, wt, payload);
  }
}

export function parseTree(bytes) {
  return Msg.parse(bytes);
}

export function serializeTree(top) {
  if (!(top instanceof Msg)) throw new TypeError('serializeTree expects a Msg from parseTree');
  return top.serialize();
}

export function buildShort2Key(top) {
  const out = new Map();
  for (const [wt, gp] of top.all(5)) {
    if (wt !== 2) continue;
    const group = Msg.parse(gp);
    for (const [pwt, pp] of group.all(5)) {
      if (pwt !== 2) continue;
      const param = Msg.parse(pp);
      const [, keyBytes] = param.get(1);
      const [, subBytes] = param.get(3);
      if (keyBytes && subBytes) {
        const [, shortBytes] = Msg.parse(subBytes).get(1);
        if (shortBytes) out.set(txt(shortBytes), txt(keyBytes));
      }
    }
  }
  return out;
}

export function readValues(top) {
  const short2key = buildShort2Key(top);
  const out = {};
  const catalogText = new TextDecoder('latin1').decode(serializeTree(top));
  for (const match of catalogText.matchAll(/Level[0-9][A-Za-z0-9]+_[A-Za-z0-9_]+/g)) {
    out[match[0]] = 0.0;
  }
  for (const key of short2key.values()) {
    if (key != null) out[key] = 0.0;
  }
  for (const [wt, sp] of top.all(4)) {
    if (wt !== 2) continue;
    const slot = Msg.parse(sp);
    const [, f3] = slot.get(3);
    if (!f3) continue;
    const f3m = Msg.parse(f3);
    const [, f5] = f3m.get(5);
    if (!f5) continue;
    const f5m = Msg.parse(f5);
    for (const [pwt, pp] of f5m.all(2)) {
      if (pwt !== 2) continue;
      const param = Msg.parse(pp);
      const [, nameBytes] = param.get(1);
      if (!nameBytes) continue;
      const name = txt(nameBytes);
      const [valueWt, valuePayload] = param.get(2);
      const value = valueWt === 5 && valuePayload ? readF32le(valuePayload) : 0.0;
      out[short2key.get(name) ?? name] = value;
    }
  }
  return out;
}

export function setValue(top, catalogKey, value) {
  const short2key = buildShort2Key(top);
  const key2short = new Map(Array.from(short2key.entries()).map(([short, key]) => [key, short]));
  const short = key2short.get(catalogKey);
  if (short == null) throw new Error(`unknown slider ${catalogKey}`);

  for (let si = 0; si < top.entries.length; si += 1) {
    const entry = top.entries[si];
    if (entry.fnum !== 4 || entry.wt !== 2) continue;
    const slot = Msg.parse(entry.payload);
    const [, f3] = slot.get(3);
    if (!f3) continue;
    const f3m = Msg.parse(f3);
    const [, f5] = f3m.get(5);
    if (!f5) continue;
    const f5m = Msg.parse(f5);
    let changed = false;
    for (let pi = 0; pi < f5m.entries.length; pi += 1) {
      const paramEntry = f5m.entries[pi];
      if (paramEntry.fnum !== 2 || paramEntry.wt !== 2) continue;
      const param = Msg.parse(paramEntry.payload);
      const [, nameBytes] = param.get(1);
      if (nameBytes && txt(nameBytes) === short) {
        param.setOrAdd(2, 5, f32le(value));
        f5m.entries[pi] = { fnum: 2, wt: 2, payload: param.serialize() };
        changed = true;
        break;
      }
    }
    if (changed) {
      f3m.setOrAdd(5, 2, f5m.serialize());
      slot.setOrAdd(3, 2, f3m.serialize());
      top.entries[si] = { fnum: 4, wt: 2, payload: slot.serialize() };
      return true;
    }
  }
  return false;
}
