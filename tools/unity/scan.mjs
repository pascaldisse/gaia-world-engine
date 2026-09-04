#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function usage() {
  console.error('usage: node tools/unity/scan.mjs <unityProjectRoot> [--out <guids.json>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args[0] || args[0] === '-h' || args[0] === '--help') usage();
const projectRoot = path.resolve(args[0]);
let outPath = path.join(OUT_DIR, 'guids.json');
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out') outPath = path.resolve(args[++i] ?? usage());
  else usage();
}

function kindForAsset(assetPath) {
  const base = path.basename(assetPath);
  if (!path.extname(base)) return 'folder';
  const ext = path.extname(base).slice(1).toLowerCase();
  const table = {
    unity: 'scene', prefab: 'prefab', mat: 'material', fbx: 'model', obj: 'model', dae: 'model', blend: 'model', glb: 'model', gltf: 'model',
    png: 'texture', jpg: 'texture', jpeg: 'texture', tga: 'texture', psd: 'texture', tif: 'texture', tiff: 'texture', exr: 'texture', hdr: 'texture',
    cs: 'script', shader: 'shader', shadergraph: 'shader', cginc: 'shader', hlsl: 'shader', compute: 'shader', asset: 'asset', controller: 'animator',
    anim: 'animation', overridecontroller: 'animator', physmat: 'physics-material', terrainlayer: 'terrain-layer', rendertexture: 'render-texture',
    lighting: 'lighting-settings', inputactions: 'input-actions', asmdef: 'assembly-definition', spriteatlas: 'sprite-atlas', wav: 'audio', mp3: 'audio', ogg: 'audio'
  };
  return table[ext] ?? ext;
}

async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && ent.name.endsWith('.meta')) yield p;
  }
}

const roots = ['Assets', 'Packages'].map(p => path.join(projectRoot, p));
const guids = {};
let metaCount = 0;
let duplicateCount = 0;
for (const root of roots) {
  for await (const metaPath of walk(root)) {
    metaCount++;
    const text = await fs.readFile(metaPath, 'utf8').catch(() => '');
    const match = /^guid:\s*([0-9a-fA-F]{32})\s*$/m.exec(text);
    if (!match) continue;
    const guid = match[1].toLowerCase();
    const assetAbs = metaPath.slice(0, -'.meta'.length);
    const assetRel = path.relative(projectRoot, assetAbs).split(path.sep).join('/');
    const rec = { path: assetRel, kind: kindForAsset(assetRel) };
    if (guids[guid] && guids[guid].path !== rec.path) {
      duplicateCount++;
      rec.duplicateOf = guids[guid].path;
    }
    guids[guid] = rec;
  }
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
const payload = {
  unityProjectRoot: projectRoot,
  generatedAt: new Date().toISOString(),
  metaCount,
  guidCount: Object.keys(guids).length,
  duplicateCount,
  guids
};
await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ out: outPath, metaCount, guidCount: payload.guidCount, duplicateCount }, null, 2));
