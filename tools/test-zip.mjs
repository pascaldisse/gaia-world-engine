#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readZip, writeZip } from '../shared/zip.js';
import { parseTree, readValues } from '../shared/vroid.js';

const VROID_PATH = '/tmp/model-src.vroid';
const DATA_BIN_ENTRY = 'v1model/data.bin';

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const sourceBytes = await readFile(VROID_PATH);
const map = await readZip(sourceBytes);
const dataBin = map.get(DATA_BIN_ENTRY);
assert.ok(dataBin, `${DATA_BIN_ENTRY} missing`);
assert.ok(dataBin.byteLength > 1_000_000, `${DATA_BIN_ENTRY} too small: ${dataBin.byteLength}`);
console.log(`PASS readZip contains ${DATA_BIN_ENTRY} (${dataBin.byteLength} bytes)`);

const top = parseTree(dataBin);
const values = readValues(top);
const keys = Object.keys(values);
assert.equal(keys.length, 328, `expected 328 keys, got ${keys.length}`);
console.log('PASS readValues returns exactly 328 keys');

const roundTripBytes = writeZip(map);
const roundTripMap = await readZip(roundTripBytes);
assert.deepEqual([...roundTripMap.keys()], [...map.keys()], 'round-trip entry names differ');
console.log(`PASS round-trip entry names identical (${map.size} entries)`);

for (const [name, bytes] of map) {
  const actual = roundTripMap.get(name);
  assert.ok(actual, `round-trip missing ${name}`);
  assert.ok(bytesEqual(actual, bytes), `round-trip bytes differ for ${name}`);
}
console.log('PASS round-trip entry contents byte-identical');
