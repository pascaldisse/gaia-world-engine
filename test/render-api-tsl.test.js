// TSL → WGSL headless proof on REAL game materials (read-only copies of the game sources are staged under scratch/tsl-games so
// their `three/*` imports resolve to the engine's three r180 — one three instance). Skips per game when the checkout is absent.
// naga validation runs when a naga binary is found (NAGA env, or .scratch/naga/root/bin/naga from `cargo install naga-cli --root`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three/webgpu';
import { exportNodeMaterial } from '../client/kernel/render-api/tsl-export.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'scratch', 'tsl-games');
const PROJECTS = process.env.GAME_PROJECTS ?? path.join(os.homedir(), 'projects');
const NAGA = [process.env.NAGA, path.join(ROOT, '.scratch/naga/root/bin/naga')].filter(Boolean).find((p) => fs.existsSync(p));
const tex = () => { const t = new THREE.DataTexture(new Uint8Array(16).fill(200), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const stage = (game, rel, patch = (s) => s) => {
const src = path.join(PROJECTS, game, rel);
if (!fs.existsSync(src)) return null;
const dst = path.join(STAGE, game, path.basename(rel));
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, patch(fs.readFileSync(src, 'utf8')));
return pathToFileURL(dst).href;
};
const nagaCheck = (name, pkg) => {
fs.mkdirSync(STAGE, { recursive: true });
const f = path.join(STAGE, `${name}.wgsl`);
fs.writeFileSync(f, `${pkg.vertex}\n${pkg.fragment}`);
if (!NAGA) return null;
// vertex+fragment are two modules' worth of text that share structs; validate each stage on its own file.
const out = {};
for (const st of ['vertex', 'fragment']) {
const sf = path.join(STAGE, `${name}.${st}.wgsl`);
fs.writeFileSync(sf, pkg[st]);
const r = spawnSync(NAGA, [sf], { encoding: 'utf8' });
out[st] = r.status === 0 ? 'valid' : (r.stderr || r.stdout).split('\n').slice(0, 6).join(' | ');
}
return out;
};
function check(name, material, object) {
  const _p = exportNodeMaterial(material, { THREE, object }); if (process.env.R3_DUMP) fs.writeFileSync(process.env.R3_DUMP + "/" + name + ".json", JSON.stringify(_p, null, 1));
const pkg = exportNodeMaterial(material, { THREE, object });
assert.ok(/@vertex/.test(pkg.vertex), `${name}: vertex WGSL`);
assert.ok(/@fragment/.test(pkg.fragment), `${name}: fragment WGSL`);
assert.ok(pkg.bindGroups.length >= 1, `${name}: bind groups`);
const naga = nagaCheck(name, pkg);
console.log(`TSL-PROOF ${name}: built=yes vertexBytes=${pkg.vertex.length} fragBytes=${pkg.fragment.length} groups=${pkg.bindGroups.map((g) => `${g.group}:${g.name}[${g.bindings.map((b) => b.kind).join(',')}]`).join(' ')} attrs=${pkg.attributes.map((a) => a.name)} naga=${JSON.stringify(naga)}`);
if (naga) { assert.equal(naga.vertex, 'valid', `${name} naga vertex: ${naga.vertex}`); assert.equal(naga.fragment, 'valid', `${name} naga fragment: ${naga.fragment}`); }
return pkg;
}

test('tsl-export: built-in MeshStandardNodeMaterial builds headless', () => {
const pkg = exportNodeMaterial(new THREE.MeshStandardNodeMaterial({ color: 0xff0000 }), { THREE });
assert.match(pkg.fragment, /@fragment/);
assert.ok(pkg.attributes.some((a) => a.name === 'position'));
});

test('proof 1/3 boomtown powerbox (TSL: uniform texture uv mix sin cos positionLocal, shared time uniform)', async (t) => {
const url = stage('boomtown-rampage-gwe', 'client/boomtown-powerbox-material.js', (s) => s.replace(/import \{ registerMaterialShader \} from '[^']+';/, 'const registerMaterialShader = () => () => {};'));
if (!url) return t.skip('boomtown checkout absent');
const { buildPowerboxMaterial } = await import(url);
const tx = (u) => ({ url: u, scale: [1, 1], offset: [0, 0] });
const shader = { source: 'proof', background: tx('bg'), panning: tx('pan'), icon: tx('icon'), backgroundTint: [1, 1, 1, 1], edgeTint: [0.2, 0.4, 1, 1], iconTint: [1, 1, 1, 1], panColor: [0.5, 0.8, 1, 1],
backgroundPower: 1, edgePower: 2, contrast: 1.2, iconContrast: 1.5, iconEmission: 2.5, panStrength: 1, panBStrength: 0.5, iconUvScale: 2, iconUvOffset: [0, -1], panAUvScale: 1, panASpeed: [0, 1.5], panBUvScale: 2, panBSpeed: [0, 2],
metallic: 0, smoothness: 0.5, rotationAxis: [0, 1, 0], rotationSpeed: 1, bobSpeed: 2, bobHeight: 0.1 };
const m = buildPowerboxMaterial(shader, { loadTexture: tex });
check('boomtown-powerbox', m, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
});

test('proof 2/3 empire-earth gfx-sprites (engine-INJECTED three namespace; SpriteNodeMaterial)', async (t) => {
const url = stage('empire-earth', 'client/gfx-sprites.js');
if (!url) return t.skip('empire-earth checkout absent');
const { createSpriteField } = await import(url);
const injected = { ...THREE, TextureLoader: class { load(u, ok) { const x = tex(); queueMicrotask(() => ok?.()); return x; } } }; // ctx.three analogue
const scene = new THREE.Scene();
const field = createSpriteField({ scene, three: injected });
const h = field.spawn?.({ textureUrl: 'smoke.png', position: [0, 1, 0], size: 2, durationMs: 1000 }, 0);
const mesh = scene.children[0]?.children[0];
assert.ok(mesh?.material?.isNodeMaterial, 'sprite material must be a NodeMaterial');
check('ee-sprite', mesh.material, mesh);
h?.remove?.();
});

test('proof 3/3 burnout bp-paintlerp (MeshStandardNodeMaterial subclass overriding setupDiffuseColor)', async (t) => {
const url = stage('burnout-paradise-gwe', 'client/bp-paintlerp.js');
if (!url) return t.skip('burnout checkout absent');
const { toPaintLerp } = await import(url);
const src = new THREE.MeshStandardMaterial({ map: tex(), roughness: 0.4 });
src.userData.paint_lerp = true;
const m = toPaintLerp(THREE, src);
assert.ok(m.isBpPaintLerp, 'paint-lerp subclass built');
check('bp-paintlerp', m, new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
});
