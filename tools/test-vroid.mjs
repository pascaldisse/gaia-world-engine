#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { parseTree, readValues, serializeTree, setValue } from '../shared/vroid.js';

const VROID_PATH = '/Users/pascaldisse/Documents/model.vroid';
const DATA_BIN_ENTRY = 'v1model/data.bin';

function u16le(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function u32le(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function findEndOfCentralDirectory(bytes) {
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let p = bytes.length - 22; p >= min; p -= 1) {
    if (u32le(bytes, p) === 0x06054b50) return p;
  }
  throw new Error('ZIP end-of-central-directory not found');
}

function extractZipEntry(zipBytes, wantedName) {
  const eocd = findEndOfCentralDirectory(zipBytes);
  const totalEntries = u16le(zipBytes, eocd + 10);
  const centralDirOffset = u32le(zipBytes, eocd + 16);
  let p = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (u32le(zipBytes, p) !== 0x02014b50) throw new Error(`bad central directory header at ${p}`);
    const method = u16le(zipBytes, p + 10);
    const compressedSize = u32le(zipBytes, p + 20);
    const uncompressedSize = u32le(zipBytes, p + 24);
    const nameLen = u16le(zipBytes, p + 28);
    const extraLen = u16le(zipBytes, p + 30);
    const commentLen = u16le(zipBytes, p + 32);
    const localOffset = u32le(zipBytes, p + 42);
    const name = new TextDecoder().decode(zipBytes.slice(p + 46, p + 46 + nameLen));

    if (name === wantedName) {
      if (u32le(zipBytes, localOffset) !== 0x04034b50) throw new Error(`bad local header for ${wantedName}`);
      const localNameLen = u16le(zipBytes, localOffset + 26);
      const localExtraLen = u16le(zipBytes, localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = zipBytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) {
        assert.equal(compressed.length, uncompressedSize, 'stored ZIP size mismatch');
        return compressed;
      }
      if (method === 8) {
        const inflated = inflateRawSync(compressed);
        assert.equal(inflated.length, uncompressedSize, 'deflated ZIP size mismatch');
        return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
      }
      throw new Error(`unsupported ZIP compression method ${method} for ${wantedName}`);
    }

    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP entry not found: ${wantedName}`);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function almostEqual(a, b) {
  return Math.abs(a - b) <= 1e-6;
}

const zipBytes = await readFile(VROID_PATH);
const dataBin = extractZipEntry(zipBytes, DATA_BIN_ENTRY);
const top = parseTree(dataBin);
const roundTrip = serializeTree(top);
assert.ok(bytesEqual(roundTrip, dataBin), 'serializeTree(parseTree(bytes)) must be byte-identical');

const values = readValues(top);
const keys = Object.keys(values);
assert.ok(keys.length >= 300, `expected >=300 keys, got ${keys.length}`);

const targetKey = keys.includes('Level2Nose_NoseBig') ? 'Level2Nose_NoseBig' : keys[0];
const newValue = almostEqual(values[targetKey], 0.375) ? 0.625 : 0.375;
assert.equal(setValue(top, targetKey, newValue), true, `setValue should write ${targetKey}`);
const editedBytes = serializeTree(top);
const editedValues = readValues(parseTree(editedBytes));
assert.ok(almostEqual(editedValues[targetKey], newValue), `${targetKey} round-trip value mismatch`);

console.log(`vroid: ${VROID_PATH}`);
console.log(`entry: ${DATA_BIN_ENTRY}`);
console.log(`data.bin bytes: ${dataBin.length}`);
console.log(`roundtrip byte-identical: yes`);
console.log(`keys read: ${keys.length}`);
console.log(`setValue roundtrip: ${targetKey}=${editedValues[targetKey]}`);
