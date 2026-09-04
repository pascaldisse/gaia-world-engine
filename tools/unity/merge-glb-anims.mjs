#!/usr/bin/env node
// Merge per-clip animation GLBs into one skinned base GLB, and optionally wire
// a shared texture into every material. Pure node, zero deps.
//
// Usage:
//   node tools/unity/merge-glb-anims.mjs --base <base.glb> --clips <dir> --out <out.glb> [--texture <png>]

import fs from "node:fs";
import path from "node:path";

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--clips") out.clips = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--texture") out.texture = argv[++i];
    else {
      console.error("Unknown arg: " + a);
      process.exit(1);
    }
  }
  if (!out.base || !out.clips || !out.out) {
    console.error(
      "Usage: node tools/unity/merge-glb-anims.mjs --base <base.glb> --clips <dir> --out <out.glb> [--texture <png>]"
    );
    process.exit(1);
  }
  return out;
}

function readGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error(`${filePath}: not a GLB (bad magic)`);
  }
  const totalLength = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset < totalLength) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const chunkData = buf.subarray(offset + 8, offset + 8 + chunkLen);
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(chunkData.toString("utf8"));
    } else if (chunkType === CHUNK_BIN) {
      bin = Buffer.from(chunkData); // copy out of the mmap'd/shared buffer
    }
    offset += 8 + chunkLen;
  }
  if (!json) throw new Error(`${filePath}: no JSON chunk found`);
  return { json, bin };
}

function align4(buf) {
  const pad = (4 - (buf.length % 4)) % 4;
  if (pad === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(pad, 0)]);
}

function writeGlb(json, bin, outPath) {
  const jsonStr = JSON.stringify(json);
  let jsonBuf = Buffer.from(jsonStr, "utf8");
  // JSON chunk must be padded with spaces (0x20) to a 4-byte boundary.
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  if (jsonPad > 0) {
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  }
  // BIN chunk padded with zeros.
  let binBuf = bin;
  const binPad = (4 - (binBuf.length % 4)) % 4;
  if (binPad > 0) {
    binBuf = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]);
  }

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4); // version

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonChunkHeader.writeUInt32LE(CHUNK_JSON, 4);

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(binBuf.length, 0);
  binChunkHeader.writeUInt32LE(CHUNK_BIN, 4);

  const totalLength =
    header.length +
    jsonChunkHeader.length +
    jsonBuf.length +
    binChunkHeader.length +
    binBuf.length;
  header.writeUInt32LE(totalLength, 8);

  const out = Buffer.concat([
    header,
    jsonChunkHeader,
    jsonBuf,
    binChunkHeader,
    binBuf,
  ]);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  return out.length;
}

// Append raw bytes to the growing BIN buffer, 4-byte aligned, returning the
// byteOffset the new bufferView should use plus the (possibly grown) buffer.
function appendBin(binParts, stateRef, data) {
  const startOffset = stateRef.length;
  const pad = (4 - (startOffset % 4)) % 4;
  if (pad > 0) {
    binParts.push(Buffer.alloc(pad, 0));
    stateRef.length += pad;
  }
  const byteOffset = stateRef.length;
  binParts.push(data);
  stateRef.length += data.length;
  return byteOffset;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const basePath = path.resolve(args.base);
  const clipsDir = path.resolve(args.clips);
  const outPath = path.resolve(args.out);

  console.log(`Loading base: ${basePath}`);
  const { json: baseJson, bin: baseBin } = readGlb(basePath);

  baseJson.accessors = baseJson.accessors || [];
  baseJson.bufferViews = baseJson.bufferViews || [];
  baseJson.animations = baseJson.animations || [];
  baseJson.buffers = baseJson.buffers || [{ byteLength: baseBin.length }];

  if (baseJson.buffers.length !== 1) {
    throw new Error(
      `base has ${baseJson.buffers.length} buffers, expected exactly 1 (single-BIN GLB assumption)`
    );
  }

  const baseNodeIndexByName = new Map();
  const dupNames = new Set();
  baseJson.nodes.forEach((n, i) => {
    if (!n.name) return;
    if (baseNodeIndexByName.has(n.name)) {
      dupNames.add(n.name);
    } else {
      baseNodeIndexByName.set(n.name, i);
    }
  });
  if (dupNames.size > 0) {
    console.error(
      "FAIL: base GLB has duplicate node names, cannot build a unique name map:",
      [...dupNames].join(", ")
    );
    process.exit(1);
  }

  // Accumulate new bin bytes as a list of Buffers + running length; concat once at the end.
  const binParts = [baseBin];
  const state = { length: baseBin.length };

  const clipFiles = fs
    .readdirSync(clipsDir)
    .filter((f) => f.endsWith(".glb"))
    .filter((f) => path.resolve(clipsDir, f) !== basePath)
    .sort();

  console.log(`Found ${clipFiles.length} clip GLB(s) in ${clipsDir}`);

  const animNames = [];
  let mismatchesFound = false;

  for (const file of clipFiles) {
    const clipPath = path.join(clipsDir, file);
    const { json: clipJson, bin: clipBin } = readGlb(clipPath);

    if (!clipJson.animations || clipJson.animations.length === 0) {
      console.error(`FAIL: ${file} has no animations`);
      mismatchesFound = true;
      continue;
    }

    // Build clip-node-index -> base-node-index map by name, but only
    // validate/require nodes that are actually targeted by a channel
    // (still assert uniqueness in the base for ALL clip node names touched).
    const usedNodeIndices = new Set();
    for (const anim of clipJson.animations) {
      for (const ch of anim.channels) {
        if (ch.target && typeof ch.target.node === "number") {
          usedNodeIndices.add(ch.target.node);
        }
      }
    }

    const clipToBaseNode = new Map();
    const missing = [];
    for (const clipNodeIdx of usedNodeIndices) {
      const clipNode = clipJson.nodes[clipNodeIdx];
      const name = clipNode && clipNode.name;
      if (!name) {
        missing.push(`<node ${clipNodeIdx} has no name>`);
        continue;
      }
      if (!baseNodeIndexByName.has(name)) {
        missing.push(name);
        continue;
      }
      clipToBaseNode.set(clipNodeIdx, baseNodeIndexByName.get(name));
    }

    if (missing.length > 0) {
      console.error(
        `FAIL: ${file}: animated node name(s) not found uniquely in base: ${missing.join(", ")}`
      );
      mismatchesFound = true;
      continue;
    }

    for (const anim of clipJson.animations) {
      const animName = path.basename(file, ".glb");

      // Map clip accessor index -> new base accessor index, memoized per animation
      // (samplers commonly reuse the same input/time accessor).
      const accessorRemap = new Map();

      function remapAccessor(clipAccessorIdx) {
        if (accessorRemap.has(clipAccessorIdx)) {
          return accessorRemap.get(clipAccessorIdx);
        }
        const acc = clipJson.accessors[clipAccessorIdx];
        const bv = clipJson.bufferViews[acc.bufferView];
        if (bv.buffer !== 0) {
          throw new Error(
            `${file}: accessor ${clipAccessorIdx} references buffer ${bv.buffer}, expected single-buffer GLB`
          );
        }

        const byteOffsetInBin = bv.byteOffset || 0;
        const byteLength = bv.byteLength;
        const srcBytes = clipBin.subarray(
          byteOffsetInBin,
          byteOffsetInBin + byteLength
        );

        const newByteOffset = appendBin(binParts, state, Buffer.from(srcBytes));

        const newBufferViewIdx = baseJson.bufferViews.length;
        const newBufferView = {
          buffer: 0,
          byteOffset: newByteOffset,
          byteLength: byteLength,
        };
        if (bv.byteStride !== undefined) newBufferView.byteStride = bv.byteStride;
        if (bv.target !== undefined) newBufferView.target = bv.target;
        baseJson.bufferViews.push(newBufferView);

        const newAccessor = {
          bufferView: newBufferViewIdx,
          componentType: acc.componentType,
          count: acc.count,
          type: acc.type,
        };
        if (acc.byteOffset !== undefined) newAccessor.byteOffset = acc.byteOffset;
        if (acc.normalized !== undefined) newAccessor.normalized = acc.normalized;
        if (acc.min !== undefined) newAccessor.min = acc.min;
        if (acc.max !== undefined) newAccessor.max = acc.max;

        const newAccessorIdx = baseJson.accessors.length;
        baseJson.accessors.push(newAccessor);
        accessorRemap.set(clipAccessorIdx, newAccessorIdx);
        return newAccessorIdx;
      }

      const newSamplers = anim.samplers.map((s) => {
        const ns = {
          input: remapAccessor(s.input),
          output: remapAccessor(s.output),
        };
        if (s.interpolation !== undefined) ns.interpolation = s.interpolation;
        return ns;
      });

      const newChannels = anim.channels.map((ch) => {
        const baseNode = clipToBaseNode.get(ch.target.node);
        if (baseNode === undefined) {
          // Shouldn't happen: usedNodeIndices covers every channel target.
          throw new Error(
            `${file}: channel targets node ${ch.target.node} not present in node map`
          );
        }
        return {
          sampler: ch.sampler,
          target: { node: baseNode, path: ch.target.path },
        };
      });

      baseJson.animations.push({
        name: animName,
        samplers: newSamplers,
        channels: newChannels,
      });
      animNames.push(animName);
      console.log(
        `  merged ${animName} (${newChannels.length} channels) from ${file}`
      );
    }
  }

  if (mismatchesFound) {
    console.error("FAIL: one or more clip files had node-name mismatches or missing animations. Aborting.");
    process.exit(1);
  }

  // ---- optional texture wiring ----
  if (args.texture) {
    const texPath = path.resolve(args.texture);
    if (!fs.existsSync(texPath)) {
      console.error(`FAIL: texture not found: ${texPath}`);
      process.exit(1);
    }

    // Assert every mesh primitive has TEXCOORD_0.
    const missingUv = [];
    (baseJson.meshes || []).forEach((mesh, mi) => {
      (mesh.primitives || []).forEach((prim, pi) => {
        if (!prim.attributes || prim.attributes.TEXCOORD_0 === undefined) {
          missingUv.push(`mesh ${mi} (${mesh.name || "?"}) primitive ${pi}`);
        }
      });
    });
    if (missingUv.length > 0) {
      console.error(
        "FAIL: mesh primitive(s) missing TEXCOORD_0, cannot wire texture: " +
          missingUv.join(", ")
      );
      process.exit(1);
    }

    const pngBytes = fs.readFileSync(texPath);
    const imageByteOffset = appendBin(binParts, state, Buffer.from(pngBytes));

    const imageBufferViewIdx = baseJson.bufferViews.length;
    baseJson.bufferViews.push({
      buffer: 0,
      byteOffset: imageByteOffset,
      byteLength: pngBytes.length,
    });

    baseJson.images = baseJson.images || [];
    const imageIdx = baseJson.images.length;
    baseJson.images.push({
      mimeType: "image/png",
      bufferView: imageBufferViewIdx,
      name: path.basename(texPath, path.extname(texPath)),
    });

    baseJson.samplers = baseJson.samplers || [];
    const samplerIdx = baseJson.samplers.length;
    baseJson.samplers.push({
      magFilter: 9729, // LINEAR
      minFilter: 9987, // LINEAR_MIPMAP_LINEAR
      wrapS: 10497, // REPEAT
      wrapT: 10497, // REPEAT
    });

    baseJson.textures = baseJson.textures || [];
    const textureIdx = baseJson.textures.length;
    baseJson.textures.push({ sampler: samplerIdx, source: imageIdx });

    baseJson.materials = baseJson.materials || [];
    baseJson.materials.forEach((mat) => {
      mat.pbrMetallicRoughness = {
        baseColorTexture: { index: textureIdx },
        metallicFactor: 0,
        roughnessFactor: 1,
      };
    });

    console.log(
      `Wired texture ${path.basename(texPath)} (${pngBytes.length} bytes) into ${baseJson.materials.length} material(s), image #${imageIdx}, texture #${textureIdx}`
    );
  }

  const finalBin = Buffer.concat(binParts);
  baseJson.buffers[0].byteLength = finalBin.length;

  const outSize = writeGlb(baseJson, finalBin, outPath);

  console.log(`\nMerged ${animNames.length} animation(s) into ${outPath}`);
  console.log(`Output size: ${outSize} bytes`);
}

main();
