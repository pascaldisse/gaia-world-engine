import * as THREE from 'three/webgpu';

// Editor draw modes, Unity-style: lit (the game's truth), unlit (albedo —
// no lights, no fog, no exposure dips, so a midnight tomb is editable at
// noon), wireframe (the geometry itself). Implemented as a material override
// sweep across the entity groups: the lit materials stay untouched in their
// shared cache, every mesh just borrows a derived MeshBasicMaterial while
// the mode is on. The sweep runs per frame so streamed-in builds convert the
// frame they attach. Editor chrome (gizmos, selection boxes, the transform
// helper) lives outside the groups and never converts.
export class Shading {
  constructor({ view, renderer }) {
    this.view = view;
    this.renderer = renderer;
    this.mode = 'lit';
    this.cache = new Map(); // source material uuid + mode -> derived material
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'lit') return; // update() converts lazily, new builds included
    for (const group of this.view.groups.values()) {
      group.traverse((node) => {
        if (node.userData?.litMaterial) {
          node.material = node.userData.litMaterial;
          delete node.userData.litMaterial;
          delete node.userData.shadingMode;
        }
      });
    }
  }

  // runs after environment.update (which writes the exposure every frame):
  // override modes render through a neutral tone map, so a dark zone's
  // authored exposure can't re-darken the unlit view
  update() {
    if (this.mode === 'lit') return;
    this.renderer.toneMappingExposure = 1;
    for (const group of this.view.groups.values()) {
      group.traverse((node) => {
        if (!node.isMesh || node.userData.shadingMode === this.mode) return;
        node.userData.litMaterial ??= node.material;
        node.material = this.derive(node.userData.litMaterial, this.mode);
        node.userData.shadingMode = this.mode;
      });
    }
  }

  derive(source, mode) {
    const key = `${source.uuid}|${mode}`;
    let material = this.cache.get(key);
    if (material) return material;
    material = new THREE.MeshBasicMaterial({
      color: readableColor(source, mode === 'wireframe' ? 0.45 : 0.3),
      wireframe: mode === 'wireframe',
      transparent: source.transparent ?? false,
      opacity: source.opacity ?? 1,
      side: source.side ?? THREE.FrontSide,
      vertexColors: source.vertexColors ?? false,
    });
    if (source.map) material.map = source.map;
    material.fog = false; // scene-view rule: fog never hides work
    material.userData.shared = true; // disposeOwn must leave cache entries alone
    this.cache.set(key, material);
    return material;
  }
}

const _hsl = { h: 0, s: 0, l: 0 };
const _hsl2 = { h: 0, s: 0, l: 0 };

// the color a part IS to an editor's eye: presets answer with their authored
// color (their .color is a white placeholder under the colorNode), glow cards
// read by their emissive, and everything gets a lightness floor — raw
// near-black albedo is exactly the unreadability these modes exist to fix
function readableColor(source, floor) {
  const color = new THREE.Color();
  if (source.userData?.baseColor) color.set(source.userData.baseColor);
  else if (source.color?.isColor) color.copy(source.color);
  else color.set('#9aa0a6');
  if (source.emissive?.isColor) {
    color.getHSL(_hsl);
    source.emissive.getHSL(_hsl2);
    if (_hsl2.l > _hsl.l) color.copy(source.emissive);
  }
  color.getHSL(_hsl);
  if (_hsl.l < floor) color.setHSL(_hsl.h, _hsl.s, floor);
  return color;
}
