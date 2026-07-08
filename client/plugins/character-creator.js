import { isTyping } from '../kernel/dom.js';
import { r2 } from '../../shared/num.js';

const DEFAULT = {
  id: 'gaia-character',
  skin: '#f1c7a8',
  hair: '#2b1738',
  iris: '#7a1128',
  outfit: '#26344f',
  height: 1,
  head: 1,
  eye: 1,
  hairLength: 0.65,
  shoulders: 1,
  hips: 1,
};

const PRESETS = {
  neutral: DEFAULT,
  nyari: {
    ...DEFAULT,
    id: 'nyari-cleanroom',
    skin: '#f3c6aa',
    hair: '#160b22',
    iris: '#7a1128',
    outfit: '#2c1742',
    height: 0.96,
    head: 1.08,
    eye: 1.22,
    hairLength: 0.82,
    shoulders: 0.86,
    hips: 0.94,
  },
  chibi: {
    ...DEFAULT,
    id: 'chibi-character',
    height: 0.78,
    head: 1.34,
    eye: 1.45,
    hairLength: 0.55,
    shoulders: 0.78,
    hips: 0.82,
  },
};
const PRESET_NAMES = Object.keys(PRESETS);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
const cleanId = (id) =>
  String(id || 'gaia-character')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'gaia-character';

function part(shape, opts = {}) {
  return { shape, ...opts };
}

export function buildCharacterMesh(spec = {}) {
  const s = normalizeSpec(spec);
  const h = s.height;
  const head = s.head;
  const eye = s.eye;
  const shoulders = s.shoulders;
  const hips = s.hips;
  const hairLength = s.hairLength;
  const skin = s.skin;
  const hair = s.hair;
  const iris = s.iris;
  const outfit = s.outfit;

  const torsoY = 1.18 * h;
  const neckY = 1.75 * h;
  const headY = 2.08 * h;
  const headR = 0.28 * head;
  const faceZ = -0.24 * head;
  const eyeX = 0.105 * head;
  const eyeY = headY + 0.035 * head;
  const eyeR = 0.034 * eye;

  return {
    parts: [
      part('cylinder', { radius: 0.075 * hips, height: 0.9 * h, position: [-0.12 * hips, 0.48 * h, 0], color: outfit, roughness: 0.72 }),
      part('cylinder', { radius: 0.075 * hips, height: 0.9 * h, position: [0.12 * hips, 0.48 * h, 0], color: outfit, roughness: 0.72 }),
      part('box', { size: [0.22, 0.07, 0.32], position: [-0.12 * hips, 0.05, -0.055], color: '#151821', roughness: 0.8 }),
      part('box', { size: [0.22, 0.07, 0.32], position: [0.12 * hips, 0.05, -0.055], color: '#151821', roughness: 0.8 }),
      part('box', { size: [0.48 * hips, 0.22 * h, 0.31], position: [0, 0.94 * h, 0], color: outfit, roughness: 0.62 }),
      part('box', { size: [0.58 * shoulders, 0.62 * h, 0.34], position: [0, torsoY, 0], color: outfit, roughness: 0.58 }),
      part('sphere', { radius: 0.095, scale: [1.0 * shoulders, 0.82, 0.75], position: [-0.35 * shoulders, 1.43 * h, 0], color: skin, roughness: 0.55 }),
      part('sphere', { radius: 0.095, scale: [1.0 * shoulders, 0.82, 0.75], position: [0.35 * shoulders, 1.43 * h, 0], color: skin, roughness: 0.55 }),
      part('cylinder', { radius: 0.055, height: 0.72 * h, position: [-0.43 * shoulders, 1.08 * h, 0], color: skin, roughness: 0.55 }),
      part('cylinder', { radius: 0.055, height: 0.72 * h, position: [0.43 * shoulders, 1.08 * h, 0], color: skin, roughness: 0.55 }),
      part('sphere', { radius: 0.07, position: [-0.43 * shoulders, 0.68 * h, -0.01], color: skin, roughness: 0.55 }),
      part('sphere', { radius: 0.07, position: [0.43 * shoulders, 0.68 * h, -0.01], color: skin, roughness: 0.55 }),
      part('cylinder', { radius: 0.09, height: 0.18 * h, position: [0, neckY, 0], color: skin, roughness: 0.55 }),
      part('sphere', { radius: headR, scale: [0.9, 1.06, 0.82], position: [0, headY, 0], color: skin, roughness: 0.5 }),
      part('sphere', { radius: eyeR, scale: [1.55, 0.78, 0.18], position: [-eyeX, eyeY, faceZ], color: '#fff7f3', roughness: 0.35 }),
      part('sphere', { radius: eyeR, scale: [1.55, 0.78, 0.18], position: [eyeX, eyeY, faceZ], color: '#fff7f3', roughness: 0.35 }),
      part('sphere', { radius: eyeR * 0.48, scale: [1, 1, 0.2], position: [-eyeX, eyeY, faceZ - 0.018], color: iris, emissive: iris, emissiveIntensity: 0.35, roughness: 0.2 }),
      part('sphere', { radius: eyeR * 0.48, scale: [1, 1, 0.2], position: [eyeX, eyeY, faceZ - 0.018], color: iris, emissive: iris, emissiveIntensity: 0.35, roughness: 0.2 }),
      part('sphere', { radius: 0.025 * head, scale: [0.8, 0.6, 0.35], position: [0, headY - 0.045 * head, faceZ - 0.03], color: '#d39b8a', roughness: 0.55 }),
      part('box', { size: [0.13 * head, 0.018, 0.012], position: [0, headY - 0.145 * head, faceZ - 0.035], color: '#8d4a56', roughness: 0.6 }),
      part('sphere', { radius: headR * 1.035, scale: [0.95, 0.62, 0.9], position: [0, headY + 0.12 * head, -0.005], color: hair, roughness: 0.82 }),
      part('sphere', { radius: headR * 0.9, scale: [0.88, 0.9 + hairLength * 0.9, 0.55], position: [0, headY - 0.13 * hairLength, 0.16], color: hair, roughness: 0.86 }),
      part('sphere', { radius: headR * 0.38, scale: [0.55, 1.25, 0.35], position: [-0.24 * head, headY - 0.06, -0.03], color: hair, roughness: 0.82 }),
      part('sphere', { radius: headR * 0.38, scale: [0.55, 1.25, 0.35], position: [0.24 * head, headY - 0.06, -0.03], color: hair, roughness: 0.82 }),
    ],
  };
}

function normalizeSpec(spec = {}) {
  return {
    id: cleanId(spec.id ?? DEFAULT.id),
    skin: spec.skin ?? DEFAULT.skin,
    hair: spec.hair ?? DEFAULT.hair,
    iris: spec.iris ?? DEFAULT.iris,
    outfit: spec.outfit ?? DEFAULT.outfit,
    height: clamp(spec.height ?? DEFAULT.height, 0.65, 1.45),
    head: clamp(spec.head ?? DEFAULT.head, 0.7, 1.55),
    eye: clamp(spec.eye ?? DEFAULT.eye, 0.55, 1.7),
    hairLength: clamp(spec.hairLength ?? DEFAULT.hairLength, 0, 1),
    shoulders: clamp(spec.shoulders ?? DEFAULT.shoulders, 0.65, 1.45),
    hips: clamp(spec.hips ?? DEFAULT.hips, 0.65, 1.45),
  };
}

export class CharacterCreator {
  constructor({ store, send, history, editor, player }) {
    this.store = store;
    this.send = send;
    this.history = history;
    this.editor = editor;
    this.player = player;
    this.preset = 'nyari';
    this.spec = normalizeSpec(PRESETS.nyari);
    this.visible = false;
    this.mount = document.createElement('div');
    this.mount.id = 'character-creator';
    this.injectStyle();
    this.render();
    document.body.append(this.mount);
    document.addEventListener('keydown', (e) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyC' && this.editor?.mode === 'create' && !this.player?.gameMode) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  injectStyle() {
    if (document.getElementById('character-creator-style')) return;
    const style = document.createElement('style');
    style.id = 'character-creator-style';
    style.textContent = `
      #character-creator{position:fixed;left:12px;bottom:70px;width:320px;max-height:72vh;display:none;flex-direction:column;gap:8px;padding:10px;background:rgba(8,14,24,.94);border:1px solid rgba(125,249,255,.28);border-radius:10px;color:#dbe7ff;font:11px ui-monospace,'SF Mono',Menlo,monospace;z-index:34;box-shadow:0 12px 40px rgba(0,0,0,.38);overflow:auto}
      #character-creator .cc-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(125,249,255,.16);padding-bottom:7px}.cc-title{flex:1;color:#7df9ff;font-weight:700;letter-spacing:.08em}.cc-doc{color:#9fb4d8;line-height:1.35}.cc-row{display:grid;grid-template-columns:92px 1fr 46px;align-items:center;gap:8px}.cc-row input[type='range']{width:100%}.cc-row input[type='color']{width:42px;height:24px;padding:0;border:0;background:transparent}.cc-row input[type='text'],#character-creator select{background:rgba(0,0,0,.22);border:1px solid rgba(125,249,255,.18);border-radius:6px;color:#dbe7ff;font:inherit;padding:5px}.cc-buttons{display:flex;gap:6px;flex-wrap:wrap}.cc-buttons button,.cc-head button{background:rgba(125,249,255,.10);border:1px solid rgba(125,249,255,.25);border-radius:8px;color:#dbe7ff;font:inherit;padding:5px 8px;cursor:pointer}.cc-buttons button:hover,.cc-head button:hover{background:rgba(125,249,255,.20)}.cc-note{color:#ffd9a0;min-height:1.2em}.cc-chip{color:#9fb4d8}`;
    document.head.append(style);
  }

  toggle(on = !this.visible) {
    this.visible = on;
    this.mount.style.display = on ? 'flex' : 'none';
    if (on) this.loadFromSelection();
  }

  loadFromSelection() {
    const id = this.editor?.selected;
    const cc = id && this.store.get(id)?.characterCreator;
    if (cc) {
      this.spec = normalizeSpec({ id, ...cc });
      this.render();
    }
  }

  set(key, value) {
    this.spec = normalizeSpec({ ...this.spec, [key]: value });
    this.render();
  }

  setPreset(name) {
    this.preset = name;
    this.spec = normalizeSpec(PRESETS[name] ?? PRESETS.neutral);
    this.render();
  }

  randomize() {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    this.spec = normalizeSpec({
      ...this.spec,
      skin: pick(['#f1c7a8', '#d8a17f', '#8f5f4d', '#f4d5bd', '#c58d71']),
      hair: pick(['#160b22', '#20130f', '#efe7d0', '#6b263d', '#24324a', '#0c0d10']),
      iris: pick(['#7a1128', '#2f6b8f', '#5a7a32', '#7b5ad6', '#2a1f18']),
      outfit: pick(['#26344f', '#2c1742', '#1d4038', '#44232a', '#20232a']),
      height: 0.82 + Math.random() * 0.35,
      head: 0.88 + Math.random() * 0.35,
      eye: 0.82 + Math.random() * 0.55,
      hairLength: Math.random(),
      shoulders: 0.78 + Math.random() * 0.38,
      hips: 0.78 + Math.random() * 0.34,
    });
    this.render();
  }

  entityComponents(existing = null) {
    const spec = normalizeSpec(this.spec);
    const px = this.player?.position?.x ?? 0;
    const pz = this.player?.position?.z ?? 0;
    const yaw = this.player?.bodyYaw ?? this.player?.yaw ?? 0;
    const pos = existing?.transform?.position ?? [r2(px - Math.sin(yaw) * 2.2), 0, r2(pz - Math.cos(yaw) * 2.2)];
    const { id: _id, ...savedSpec } = spec;
    return {
      transform: { ...(existing?.transform ?? {}), position: pos, rotation: existing?.transform?.rotation ?? [0, r2(yaw), 0] },
      ground: existing?.ground ?? { offset: 0 },
      mesh: buildCharacterMesh(spec),
      characterCreator: { ...savedSpec, version: 1, source: 'clean-room-gaia' },
    };
  }

  apply() {
    const id = cleanId(this.spec.id);
    this.spec.id = id;
    const exists = this.store.get(id);
    const components = this.entityComponents(exists);
    let ops;
    let undo;
    if (exists) {
      ops = Object.entries(components).map(([component, value]) => ({ op: 'set', id, component, value }));
      undo = Object.keys(components).map((component) => ({ op: 'set', id, component, value: structuredClone(exists[component] ?? null) }));
    } else {
      ops = [{ op: 'spawn', id, components }];
      undo = [{ op: 'despawn', id }];
    }
    this.send(ops);
    this.history?.push(undo, ops, `characterCreator.${id}`);
    setTimeout(() => this.editor?.select(id), 120);
    this.note(`saved ${id}`);
  }

  note(text) {
    const el = this.mount.querySelector('.cc-note');
    if (el) el.textContent = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      const n = this.mount.querySelector('.cc-note');
      if (n?.textContent === text) n.textContent = '';
    }, 1800);
  }

  render() {
    const s = this.spec;
    const row = (key, label, min, max, step = 0.01) => `
      <label class="cc-row"><span>${label}</span><input data-key="${key}" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span>${Number(s[key]).toFixed(2)}</span></label>`;
    const color = (key, label) => `
      <label class="cc-row"><span>${label}</span><input data-key="${key}" type="color" value="${s[key]}"><span class="cc-chip">${s[key]}</span></label>`;
    const presetOptions = PRESET_NAMES.map((name) => `<option value="${name}"${name === this.preset ? ' selected' : ''}>${name}</option>`).join('');
    this.mount.innerHTML = `
      <div class="cc-head"><div class="cc-title">CHARACTER CREATOR</div><button data-act="close">×</button></div>
      <div class="cc-doc">Clean-room GAIA avatar builder. No VRoid assets; exports live entity mesh data. Press C in creator mode.</div>
      <label class="cc-row"><span>preset</span><select data-act="preset">${presetOptions}</select><span></span></label>
      <label class="cc-row"><span>id</span><input data-key="id" type="text" value="${s.id}"><span></span></label>
      ${color('skin', 'skin')}${color('hair', 'hair')}${color('iris', 'iris')}${color('outfit', 'outfit')}
      ${row('height', 'height', 0.65, 1.45)}${row('head', 'head', 0.7, 1.55)}${row('eye', 'eyes', 0.55, 1.7)}${row('hairLength', 'hair len', 0, 1)}${row('shoulders', 'shoulders', 0.65, 1.45)}${row('hips', 'hips', 0.65, 1.45)}
      <div class="cc-buttons"><button data-act="apply">spawn/update</button><button data-act="selection">load selected</button><button data-act="random">randomize</button></div>
      <div class="cc-note"></div>`;
    for (const input of this.mount.querySelectorAll('[data-key]')) {
      const eventName = input.type === 'text' ? 'change' : 'input';
      input.addEventListener(eventName, () => this.set(input.dataset.key, input.type === 'range' ? Number(input.value) : input.value));
    }
    this.mount.querySelector('[data-act="close"]')?.addEventListener('click', () => this.toggle(false));
    this.mount.querySelector('[data-act="apply"]')?.addEventListener('click', () => this.apply());
    this.mount.querySelector('[data-act="selection"]')?.addEventListener('click', () => this.loadFromSelection());
    this.mount.querySelector('[data-act="random"]')?.addEventListener('click', () => this.randomize());
    this.mount.querySelector('[data-act="preset"]')?.addEventListener('change', (e) => this.setPreset(e.target.value));
  }
}
