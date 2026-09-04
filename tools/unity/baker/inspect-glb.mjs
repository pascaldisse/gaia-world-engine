// Minimal GLB header + JSON chunk parser, no deps.
// Usage: node inspect-glb.mjs <file.glb> [--quats <accessorIndexOrChannelHint>]
import fs from 'node:fs';

function parseGlb(path) {
  const buf = fs.readFileSync(path);
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a glb (bad magic): ' + path);
  const version = buf.readUInt32LE(4);
  const length = buf.readUInt32LE(8);

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) { // 'JSON'
      json = JSON.parse(chunkData.toString('utf8'));
    } else if (chunkType === 0x004e4942) { // 'BIN\0'
      bin = chunkData;
    }
    offset += 8 + chunkLength;
    // 4-byte alignment padding already included in chunkLength per spec
  }
  return { version, length, json, bin };
}

function componentTypeSize(ct) {
  switch (ct) {
    case 5120: case 5121: return 1; // BYTE / UNSIGNED_BYTE
    case 5122: case 5123: return 2; // SHORT / UNSIGNED_SHORT
    case 5125: case 5126: return 4; // UNSIGNED_INT / FLOAT
    default: throw new Error('unknown componentType ' + ct);
  }
}

function numComponents(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
}

function readAccessor(json, bin, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const bv = json.bufferViews[acc.bufferView];
  const compSize = componentTypeSize(acc.componentType);
  const nComp = numComponents(acc.type);
  const stride = bv.byteStride || (compSize * nComp);
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const elemOffset = base + i * stride;
    const vals = [];
    for (let c = 0; c < nComp; c++) {
      const o = elemOffset + c * compSize;
      let v;
      if (acc.componentType === 5126) v = bin.readFloatLE(o);
      else if (acc.componentType === 5125) v = bin.readUInt32LE(o);
      else if (acc.componentType === 5123) v = bin.readUInt16LE(o);
      else if (acc.componentType === 5121) v = bin.readUInt8(o);
      else if (acc.componentType === 5122) v = bin.readInt16LE(o);
      else if (acc.componentType === 5120) v = bin.readInt8(o);
      vals.push(v);
    }
    out.push(nComp === 1 ? vals[0] : vals);
  }
  return out;
}

function report(path) {
  console.log('=== ' + path + ' ===');
  const { json, length } = parseGlb(path);
  console.log('glb byteLength(header):', length, ' actual file size:', fs.statSync(path).size);
  console.log('meshes:', (json.meshes || []).length);
  console.log('skins:', (json.skins || []).length);
  if (json.skins && json.skins.length) {
    console.log('  skin[0].joints.length:', json.skins[0].joints.length);
  }
  const anims = json.animations || [];
  console.log('animations:', anims.length);
  for (const anim of anims) {
    console.log('  name:', anim.name, ' channels:', anim.channels.length, ' samplers:', anim.samplers.length);
    // duration = max input time across samplers
    let maxTime = 0;
    for (const s of anim.samplers) {
      const acc = json.accessors[s.input];
      if (acc.max) maxTime = Math.max(maxTime, acc.max[0]);
    }
    console.log('  duration (max sampler input time):', maxTime);
  }
  return { json };
}

function reportRotationChannel(path) {
  const { json, bin } = parseGlb(path);
  const anim = json.animations[0];
  // find a rotation channel targeting a leg/hip/thigh/spine node
  const nameHints = ['hip', 'thigh', 'leg', 'spine', 'pelvis'];
  let chosen = null;
  for (const ch of anim.channels) {
    if (ch.target.path !== 'rotation') continue;
    const nodeIdx = ch.target.node;
    const nodeName = (json.nodes[nodeIdx].name || '').toLowerCase();
    if (nameHints.some(h => nodeName.includes(h))) {
      chosen = { ch, nodeName };
      break;
    }
  }
  if (!chosen) {
    // fallback: first rotation channel
    const ch = anim.channels.find(c => c.target.path === 'rotation');
    chosen = { ch, nodeName: json.nodes[ch.target.node].name };
  }
  const sampler = anim.samplers[chosen.ch.sampler];
  const times = readAccessor(json, bin, sampler.input);
  const quats = readAccessor(json, bin, sampler.output);
  console.log('=== rotation channel proof:', path, ' node:', chosen.nodeName, ' frames:', quats.length, '===');
  const first = quats[0];
  const mid = quats[Math.floor(quats.length / 2)];
  const last = quats[quats.length - 1];
  console.log('  t0=' + times[0].toFixed(4), 'q=', first.map(v => v.toFixed(5)));
  console.log('  tmid=' + times[Math.floor(times.length / 2)].toFixed(4), 'q=', mid.map(v => v.toFixed(5)));
  console.log('  tlast=' + times[times.length - 1].toFixed(4), 'q=', last.map(v => v.toFixed(5)));
  const changed = JSON.stringify(first) !== JSON.stringify(last) || JSON.stringify(first) !== JSON.stringify(mid);
  console.log('  VALUES CHANGE ACROSS FRAMES:', changed);
}

const files = process.argv.slice(2);
for (const f of files) {
  report(f);
  try {
    const { json } = parseGlb(f);
    if (json.animations && json.animations.length) reportRotationChannel(f);
  } catch (e) {
    console.log('  (rotation channel proof skipped:', e.message, ')');
  }
  console.log('');
}
