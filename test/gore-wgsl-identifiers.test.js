// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// Live-found (parent, prior run 151348): an attribute name that collides
// with a WGSL keyword/reserved word ('meta') becomes an invalid WGSL
// identifier verbatim in the generated shader → shader parse failure → black
// screen. This enumerates every geometry the gore extension creates and
// checks every attribute name against the PUBLIC W3C WGSL keyword/reserved-
// word table (wgsl-keywords.js, sourced from gpuweb/gpuweb's spec source —
// not from any forbidden path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as three from 'three/webgpu';
import * as tsl from 'three/tsl';
import { Scene, Mesh, BoxGeometry, MeshStandardNodeMaterial } from 'three/webgpu';
import { createGore } from '../client/extensions/gore/index.js';
import { WGSL_FORBIDDEN_IDENTIFIERS, isWgslSafeIdentifier } from '../client/extensions/gore/wgsl-keywords.js';

function collectGeometries(gore, scene) {
  gore.blood.splash([0, 1, 0], [0, 1, 0], 2);
  gore.blood.pool([1, 0, 1], [0, 1, 0], 0.5);
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardNodeMaterial());
  mesh.updateMatrixWorld(true);
  const cutResult = gore.cut(mesh, { plane: { point: [0, 0.1, 0], normal: [0, 1, 0] } });
  const geometries = scene.children.filter((c) => c.geometry).map((c) => c.geometry);
  assert.ok(geometries.length >= 4, 'sanity: particles mesh + pool mesh + cut stump + cut piece');
  return geometries;
}

test("sanity: 'meta' really is on the forbidden list (the live-found bug)", () => {
  assert.ok(WGSL_FORBIDDEN_IDENTIFIERS.has('meta'));
  assert.equal(isWgslSafeIdentifier('meta'), false);
});

test('sanity: our own custom attribute names are safe', () => {
  assert.equal(isWgslSafeIdentifier('goreXParticleColor'), true);
  assert.equal(isWgslSafeIdentifier('goreXDecalColor'), true);
  assert.equal(isWgslSafeIdentifier('position'), true);
  assert.equal(isWgslSafeIdentifier('normal'), true);
  assert.equal(isWgslSafeIdentifier('uv'), true);
});

test('every geometry attribute name across everything the extension creates is WGSL-safe', () => {
  const scene = new Scene();
  const gore = createGore({ three, tsl, scene });
  const geometries = collectGeometries(gore, scene);
  const offenders = [];
  for (const geo of geometries) {
    for (const name of Object.keys(geo.attributes)) {
      if (!isWgslSafeIdentifier(name)) offenders.push(name);
    }
  }
  assert.deepEqual(offenders, [], `WGSL-reserved attribute name(s) found: ${offenders.join(', ')}`);
});

test("mutant: an attribute literally named 'meta' -> RED", () => {
  assert.equal(isWgslSafeIdentifier('meta'), false, "'meta' must be caught");
  // the real RED proof (see report) patches blood-particles.js's attribute
  // name to 'meta' and reruns the geometry-enumeration test above.
});
