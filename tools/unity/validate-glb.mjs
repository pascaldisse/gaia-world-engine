#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ImageLoader } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Minimal browser shims used by GLTFLoader in Node for binary GLBs.
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
globalThis.self ??= globalThis;

// GLTFLoader can parse a GLB in Node, but Node has no browser image decoder.
// Treat external image loads as successful after checking the adjacent file exists.
ImageLoader.prototype.load = function load(url, onLoad, onProgress, onError) {
  const file = path.resolve(String(url).replace(/^file:\/\//, ''));
  if (!existsSync(file)) {
    onError?.(new Error(`missing image ${url}`));
    return { src: url };
  }
  const image = { src: url, width: 1, height: 1 };
  queueMicrotask(() => onLoad?.(image));
  return image;
};

function readGlbJson(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLen;
    if (chunkType === 0x4e4f534a) return JSON.parse(buf.subarray(dataStart, dataEnd).toString('utf8').trim());
    offset = dataEnd;
  }
  throw new Error('GLB has no JSON chunk');
}

async function loadGlb(file) {
  const bytes = readFileSync(file);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  return await new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, `${path.dirname(file)}/`, resolve, reject);
  });
}

function countScene(scene) {
  let meshes = 0;
  let primitives = 0;
  const materials = new Set();
  scene.traverse(o => {
    if (o.isMesh) {
      meshes += 1;
      if (o.geometry) primitives += 1;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) materials.add(m.uuid ?? m.name);
    }
  });
  return { meshes, primitives, materials: materials.size };
}

for (const fileArg of process.argv.slice(2)) {
  const file = path.resolve(fileArg);
  try {
    const json = readGlbJson(file);
    const externalImages = (json.images ?? []).map(img => img.uri).filter(Boolean);
    const missingImages = externalImages.filter(uri => !existsSync(path.resolve(path.dirname(file), uri)));
    if (missingImages.length) throw new Error(`missing adjacent images: ${missingImages.join(', ')}`);
    const gltf = await loadGlb(file);
    const counts = countScene(gltf.scene);
    const parserJson = gltf.parser?.json ?? json;
    console.log(JSON.stringify({
      file: fileArg,
      bytes: statSync(file).size,
      ...counts,
      textures: parserJson.textures?.length ?? 0,
      images: parserJson.images?.length ?? 0,
      externalImagesPresent: externalImages.length - missingImages.length,
      nodes: parserJson.nodes?.length ?? 0,
      animations: parserJson.animations?.length ?? 0,
    }));
  } catch (err) {
    console.error(`${fileArg}: ${err.stack || err.message || String(err)}`);
    process.exitCode = 1;
  }
}
