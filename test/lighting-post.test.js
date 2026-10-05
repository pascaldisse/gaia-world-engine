// S3 — GTAO/TRAA/bloom chain: graph construction, fallback ladder, swap/restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildChain, LightingPost, POST_DEFAULTS, TONEMAPS, resolvePost, aoDistanceWeight, ndcDepthToDist } from '../client/kernel/lighting/post.js';
import { LightingController } from '../client/kernel/lighting/index.js';

const cam = () => new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);

function fakePost(scene, camera) {
  const pp = new THREE.PostProcessing({}); // stub renderer: nothing is rendered
  pp.outputNode = THREE.PostProcessing ? pp.outputNode : null;
  const calls = { render: 0, bloom: [] };
  const post = {
    postProcessing: pp,
    render: () => { calls.render++; },
    setBloom: (o) => calls.bloom.push(o),
  };
  post._origOutput = pp.outputNode;
  return { post, pp, calls };
}

test('defaults: AO on within the chain, TRAA off, tonemap aces; TONEMAPS map to three constants', () => {
  assert.equal(POST_DEFAULTS.ao.enabled, true);
  assert.equal(POST_DEFAULTS.traa.enabled, false);
  assert.equal(POST_DEFAULTS.tonemap, 'aces');
  assert.equal(TONEMAPS.aces, THREE.ACESFilmicToneMapping);
  assert.equal(TONEMAPS.agx, THREE.AgXToneMapping);
  assert.equal(resolvePost({ ao: { radius: 3 } }).ao.samples, 16, 'partial ao merges onto defaults');
});

test('buildChain: AO + normal MRT → mode ao+mrt with GTAO node configured', () => {
  const scene = new THREE.Scene();
  const c = buildChain({ scene, camera: cam(), cfg: { ao: { radius: 2.5, thickness: 1.7, samples: 24, resolutionScale: 0.75 } } });
  assert.equal(c.mode, 'ao+mrt');
  assert.equal(c.outputNode.isNode, true);
  const { aoPass, scenePass, traaPass } = c.nodes;
  assert.equal(aoPass.radius.value, 2.5);
  assert.equal(aoPass.thickness.value, 1.7);
  assert.equal(aoPass.samples.value, 24);
  assert.equal(aoPass.resolutionScale, 0.75);
  assert.equal(traaPass, null);
  const m = scenePass.getMRT();
  assert.ok(m, 'MRT set on the scene pass');
  assert.deepEqual(Object.keys(m.outputNodes).sort(), ['normal', 'output']);
});

test('buildChain: normals:"depth" skips the normal MRT → ao+depth (GTAO reconstructs normals)', () => {
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { ao: { normals: 'depth' } } });
  assert.equal(c.mode, 'ao+depth');
  assert.equal(c.nodes.scenePass.getMRT(), null);
  assert.equal(c.nodes.aoPass.normalNode, null);
});

test('buildChain: ao disabled → bloom-only chain, no GTAO node', () => {
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { ao: { enabled: false } } });
  assert.equal(c.mode, 'bloom-only');
  assert.equal(c.nodes.aoPass, null);
  assert.equal(c.nodes.bloomPass.strength.value, 0.35);
});

test('buildChain: TRAA adds velocity to the MRT and a TRAA node', () => {
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { traa: { enabled: true } } });
  assert.ok(c.nodes.traaPass?.isTRAANode);
  assert.deepEqual(Object.keys(c.nodes.scenePass.getMRT().outputNodes).sort(), ['normal', 'output', 'velocity']);
});

test('buildChain: custom bloom params land on the bloom node', () => {
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: {}, bloomParams: { strength: 0.9, radius: 0.2, threshold: 0.5 } });
  assert.equal(c.nodes.bloomPass.strength.value, 0.9);
  assert.equal(c.nodes.bloomPass.threshold.value, 0.5);
});

test('fallback ladder: an MRT failure degrades to depth-only AO (no throw)', () => {
  const scene = new THREE.Scene();
  const real = THREE.PassNode?.prototype ?? null;
  // sabotage setMRT on the very first pass built so the mrt rung throws
  const proto = Object.getPrototypeOf(buildChain({ scene, camera: cam(), cfg: {} }).nodes.scenePass);
  const orig = proto.setMRT;
  let n = 0;
  proto.setMRT = function (...a) { if (n++ === 0) throw new Error('MRT unsupported'); return orig.apply(this, a); };
  try {
    const c = buildChain({ scene, camera: cam(), cfg: {} });
    assert.equal(c.mode, 'ao+depth');
    assert.match(String(c.error), /MRT unsupported/);
    assert.equal(c.nodes.aoPass.normalNode, null);
  } finally { proto.setMRT = orig; }
  void real;
});

test('LightingPost.install swaps outputNode/render/setBloom; uninstall restores the ORIGINALS exactly', () => {
  const scene = new THREE.Scene();
  const renderer = { toneMapping: THREE.ACESFilmicToneMapping };
  const { post, pp, calls } = fakePost(scene);
  const origOut = pp.outputNode;
  const origRender = post.render;
  const origBloom = post.setBloom;
  const lp = new LightingPost({ post, scene, camera: cam(), renderer });
  assert.equal(lp.install({ tonemap: 'agx' }), true);
  assert.notEqual(pp.outputNode, origOut);
  assert.equal(renderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(lp.mode, 'ao+mrt');
  post.setBloom({ strength: 0.7 });
  assert.equal(calls.bloom.length, 1, 'original setBloom still invoked');
  assert.equal(lp.chain.nodes.bloomPass.strength.value, 0.7, 'new bloom tracked');
  post.render();
  assert.equal(calls.render, 1);
  lp.uninstall();
  assert.equal(pp.outputNode, origOut);
  assert.equal(post.render, origRender);
  assert.equal(post.setBloom, origBloom);
  assert.equal(lp.active, false);
});

test('LightingPost: a render-time throw reverts to the kernel chain once and re-renders', () => {
  const scene = new THREE.Scene();
  const { post, pp, calls } = fakePost(scene);
  const origOut = pp.outputNode;
  let boom = true;
  post.render = () => { if (boom) { boom = false; throw new Error('gpu'); } calls.render++; };
  const lp = new LightingPost({ post, scene, camera: cam(), renderer: {} });
  const warn = console.warn; console.warn = () => {};
  try {
    lp.install({});
    post.render();
  } finally { console.warn = warn; }
  assert.equal(calls.render, 1);
  assert.equal(pp.outputNode, origOut);
  assert.equal(lp.failed, true);
  assert.equal(lp.install({}), false, 'does not retry a chain that threw');
});

test('LightingPost without post.postProcessing is unsupported and does nothing', () => {
  const lp = new LightingPost({ post: { render() {}, setBloom() {} }, scene: new THREE.Scene(), camera: cam(), renderer: {} });
  assert.equal(lp.supported, false);
  assert.equal(lp.install({}), false);
});

test('controller: enabled+post installs the chain and exposure; disabled restores tonemap + chain', () => {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#000', 1, 2); scene.background = new THREE.Color();
  const sun = new THREE.DirectionalLight(); const hemi = new THREE.HemisphereLight();
  const renderer = { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1 };
  const { post, pp } = fakePost(scene);
  const origOut = pp.outputNode;
  const lc = new LightingController({ renderer, scene, sun, hemi, camera: cam(), post });
  lc.configure({});
  assert.equal(pp.outputNode, origOut, 'default off: kernel chain untouched');
  lc.configure({ enabled: true, shadows: { enabled: false }, post: { tonemap: 'agx', exposure: 0.6 } });
  assert.notEqual(pp.outputNode, origOut);
  assert.equal(renderer.toneMapping, THREE.AgXToneMapping);
  assert.equal(lc.exposure, 0.6);
  lc.configure({ enabled: false });
  assert.equal(pp.outputNode, origOut);
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(lc.exposure, 1);
});


// lane ds-ao3 — AO distance fade in metres (replaces ds-ao2 NDC eps mask).
test('ndcDepthToDist: standard perspective depth -> metres (near->near, 1->far)', () => {
  assert.ok(Math.abs(ndcDepthToDist(0, 0.1, 5000) - 0.1) < 1e-9);
  assert.ok(Math.abs(ndcDepthToDist(1, 0.1, 5000) - 5000) < 1e-6);
});

test('aoDistanceWeight: 1 <= start, 0 >= end, smooth monotone between', () => {
  assert.equal(aoDistanceWeight(10, 80, 150), 1);
  assert.equal(aoDistanceWeight(80, 80, 150), 1);
  assert.equal(aoDistanceWeight(150, 80, 150), 0);
  assert.equal(aoDistanceWeight(1200, 80, 150), 0);
  assert.ok(Math.abs(aoDistanceWeight(115, 80, 150) - 0.5) < 1e-9);
  let prev = 1;
  for (let d = 80; d <= 150; d += 5) { const w = aoDistanceWeight(d, 80, 150); assert.ok(w <= prev); prev = w; }
});

test('near/far independence: same METRES cutoff for near 0.1 vs 1 (depth value differs, distance weight identical)', () => {
  const far = 5000;
  for (const dist of [20, 80, 115, 150, 1200]) {
    const ws = [0.1, 1].map((near) => {
      const depth = (far * (dist - near)) / (dist * (far - near)); // NDC depth of a surface at `dist` m
      return aoDistanceWeight(ndcDepthToDist(depth, near, far), 80, 150);
    });
    assert.ok(Math.abs(ws[0] - ws[1]) < 1e-6, `dist ${dist}: ${ws}`);
    assert.ok(Math.abs(ws[0] - aoDistanceWeight(dist, 80, 150)) < 1e-6);
  }
  // the OLD eps rule was NOT independent: 1-depth = near/dist-ish -> 1e-3 eps cut at ~100 m @0.1 but ~1000 m @1.
  const cut = (near) => near / 1e-3;
  assert.notEqual(cut(0.1), cut(1));
});

test('ao.fadeStart/fadeEnd knobs: metre defaults, merge, land on live uniforms; skyDepthEps gone; debug off by default', () => {
  assert.equal(POST_DEFAULTS.ao.skyDepthEps, undefined, 'no dead knob');
  assert.equal(POST_DEFAULTS.ao.fadeStart, 80);
  assert.equal(POST_DEFAULTS.ao.fadeEnd, 150);
  assert.equal(POST_DEFAULTS.ao.debug, null);
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { ao: { fadeStart: 40, fadeEnd: 90 } } });
  assert.equal(c.nodes.aoFade.fadeStart.value, 40);
  assert.equal(c.nodes.aoFade.fadeEnd.value, 90);
  assert.equal(c.nodes.aoFade.weight.isNode, true);
  assert.equal(c.debug, null);
});

test('near/far uniforms are LIVE and bound to the SCENE camera (not the post-quad render camera)', () => {
  const camera = cam();
  const c = buildChain({ scene: new THREE.Scene(), camera, cfg: {} });
  const { near, far } = c.nodes.aoFade;
  assert.equal(near.constructor.name, 'ReferenceNode');
  assert.equal(far.constructor.name, 'ReferenceNode');
  assert.equal(near.object, camera);
  assert.equal(far.object, camera);
  assert.equal(near.property, 'near');
  assert.equal(far.property, 'far');
  // dist graph depends on those uniforms, not the global render-camera cameraNear/cameraFar
  const seen = new Set();
  c.nodes.aoFade.dist.traverse((n) => seen.add(n));
  assert.ok(seen.has(near) && seen.has(far));
  assert.ok(![...seen].some((n) => n.name === 'cameraNear' || n.name === 'cameraFar'), 'no global cameraNear/cameraFar');
});

test('sky mask samples the scenePass depth at screen uv (explicit sample node, not the default-uv texture node)', () => {
  const c = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: {} });
  const s = c.nodes.aoFade.depthSample;
  assert.equal(s.isTextureNode, true);
  assert.notEqual(s, c.nodes.scenePass.getTextureNode('depth'), 'a distinct .sample(uv) clone');
  assert.ok(s.uvNode, 'explicit uvNode set');
});

test('ao.debug="mask" swaps the output for the mask-as-colour view and tags the chain', () => {
  const base = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: {} });
  const dbg = buildChain({ scene: new THREE.Scene(), camera: cam(), cfg: { ao: { debug: 'mask' } } });
  assert.equal(dbg.debug, 'mask');
  assert.notEqual(dbg.outputNode, base.outputNode);
  assert.equal(dbg.nodes.bloomPass, null, 'debug view bypasses bloom/tonemap-able colour path');
});
