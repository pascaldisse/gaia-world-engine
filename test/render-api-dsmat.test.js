// r14-dsmat: a lightmap-style NodeMaterial (colorNode = vec4(rgb, tex.a), alphaTest, double side) translates to WGSL with its
// alpha cutout intact (fragment `discard`), and the cutout flag survives into the package's material record.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { exportNodeMaterial } from '../client/kernel/render-api/tsl-export.js';

const tex = () => { const t = new THREE.DataTexture(new Uint8Array(16).fill(200), 2, 2, THREE.RGBAFormat); t.needsUpdate = true; return t; };
const geo = () => { const g = new THREE.PlaneGeometry(1, 1); g.setAttribute('uv1', g.attributes.uv.clone()); return g; };
function mat(over = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: 1, ...over });
  const albedo = TSL.texture(tex(), TSL.uv(0)), light = TSL.texture(tex(), TSL.uv(1));
  m.colorNode = TSL.vec4(albedo.rgb.mul(light.rgb), albedo.a);
  return m;
}

test('alphaTest NodeMaterial with a colorNode alpha exports a fragment discard', () => {
  const m = mat({ alphaTest: 0.5, side: THREE.DoubleSide });
  const pkg = exportNodeMaterial(m, { THREE, object: new THREE.Mesh(geo(), m) });
  assert.match(pkg.fragment, /discard/, 'alpha cutout must translate');
  assert.equal(pkg.material.side, THREE.DoubleSide);
});

test('opaque NodeMaterial (alphaTest 0) exports no discard', () => {
  const m = mat();
  const pkg = exportNodeMaterial(m, { THREE, object: new THREE.Mesh(geo(), m) });
  assert.doesNotMatch(pkg.fragment, /discard/);
});
