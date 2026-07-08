// VRM AVATAR EDITOR — VRoid-compatible character editing inside the world.
//
// Templates are real VRoid exports (client/assets/vrm/); edits are pure data
// on the entity (`mesh.vrm.edits`), sent as ordinary dev ops — so avatar
// customization is co-creation like everything else: any client, human or
// agent, can patch a face. Press V in creator mode.
//
// Spec: docs/VRM-CHARACTER-EDITOR-SPEC.md. Slots/expressions/bones enumerate
// from the LOADED file, not from hardcoded lists — any conforming VRM works.

import { isTyping } from '../kernel/dom.js';
import { r2 } from '../../shared/num.js';
import { loadVRM, slotMapOf, applyVrmEdits, exportVRM, PROPORTION_BONES } from '../kernel/vrm.js';

const TEMPLATES = {
  'nyari-final': '/assets/vrm/nyari-final.vrm',
  'sendagaya-shino': '/assets/vrm/cand-Sendagaya_Shino.vrm',
  'sakurada-fumiriya': '/assets/vrm/cand-Sakurada_Fumiriya.vrm',
  'victoria-rubin': '/assets/vrm/cand-Victoria_Rubin.vrm',
};

// slot -> label, in display order (only slots present on the file render)
const SLOT_LABELS = [
  ['faceSkin', 'face skin'],
  ['bodySkin', 'body skin'],
  ['iris', 'iris'],
  ['eyeHighlight', 'highlight'],
  ['sclera', 'sclera'],
  ['eyeline', 'eyeline'],
  ['eyelash', 'eyelash'],
  ['brow', 'brow'],
  ['mouth', 'mouth'],
  ['hair', 'hair'],
  ['hairBack', 'back hair'],
  ['tops', 'tops'],
  ['bottoms', 'bottoms'],
  ['neckAccessory', 'neck acc.'],
  ['shoes', 'shoes'],
];

const EXPRESSION_ORDER = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight'];

const cleanId = (id) =>
  String(id || 'vrm-avatar')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'vrm-avatar';

export class VrmEditor {
  constructor({ store, view, send, history, editor, player }) {
    this.store = store;
    this.view = view;
    this.send = send;
    this.history = history;
    this.editor = editor;
    this.player = player;
    this.visible = false;
    this.template = 'nyari-final';
    this.entityId = 'vrm-avatar';
    this.edits = { colors: {}, expressions: {}, bones: {}, meta: {} };
    this.probe = null; // { src, slots: Map, expressions: [], vrm }
    this.mount = document.createElement('div');
    this.mount.id = 'vrm-editor';
    this.injectStyle();
    this.render();
    document.body.append(this.mount);
    document.addEventListener('keydown', (e) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyV' && this.editor?.mode === 'create' && !this.player?.gameMode) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  injectStyle() {
    if (document.getElementById('vrm-editor-style')) return;
    const style = document.createElement('style');
    style.id = 'vrm-editor-style';
    style.textContent = `
      #vrm-editor{position:fixed;right:12px;bottom:70px;width:330px;max-height:76vh;display:none;flex-direction:column;gap:8px;padding:10px;background:rgba(14,8,24,.94);border:1px solid rgba(190,125,255,.30);border-radius:10px;color:#e6dbff;font:11px ui-monospace,'SF Mono',Menlo,monospace;z-index:34;box-shadow:0 12px 40px rgba(0,0,0,.38);overflow:auto}
      #vrm-editor .ve-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(190,125,255,.18);padding-bottom:7px}.ve-title{flex:1;color:#c99aff;font-weight:700;letter-spacing:.08em}.ve-doc{color:#b3a4d8;line-height:1.35}.ve-sect{color:#c99aff;letter-spacing:.06em;margin-top:4px;border-bottom:1px dashed rgba(190,125,255,.15);padding-bottom:2px}
      #vrm-editor .ve-row{display:grid;grid-template-columns:92px 1fr 46px;align-items:center;gap:8px}.ve-row input[type='range']{width:100%}.ve-row input[type='color']{width:42px;height:24px;padding:0;border:0;background:transparent}.ve-row input[type='text'],#vrm-editor select{background:rgba(0,0,0,.22);border:1px solid rgba(190,125,255,.20);border-radius:6px;color:#e6dbff;font:inherit;padding:5px}
      #vrm-editor .ve-buttons{display:flex;gap:6px;flex-wrap:wrap}.ve-buttons button,#vrm-editor .ve-head button{background:rgba(190,125,255,.10);border:1px solid rgba(190,125,255,.28);border-radius:8px;color:#e6dbff;font:inherit;padding:5px 8px;cursor:pointer}.ve-buttons button:hover,#vrm-editor .ve-head button:hover{background:rgba(190,125,255,.22)}.ve-note{color:#ffd9a0;min-height:1.2em}.ve-chip{color:#b3a4d8;overflow:hidden;text-overflow:ellipsis}`;
    document.head.append(style);
  }

  toggle(on = !this.visible) {
    this.visible = on;
    this.mount.style.display = on ? 'flex' : 'none';
    if (on && !this.probe) this.setTemplate(this.template);
  }

  // Load the template once (probe) to enumerate its actual slots/expressions.
  async setTemplate(name) {
    this.template = name;
    const src = TEMPLATES[name];
    this.note('reading avatar…');
    try {
      const vrm = await loadVRM(src);
      const slots = slotMapOf(vrm);
      const expressions = (vrm.expressionManager?.expressions ?? [])
        .map((e) => e.expressionName)
        .sort((a, b) => {
          const ia = EXPRESSION_ORDER.indexOf(a);
          const ib = EXPRESSION_ORDER.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
      this.probe = { src, slots, expressions, vrm };
      this.note('');
    } catch (err) {
      this.probe = null;
      this.note(`load failed: ${err.message}`);
    }
    this.render();
  }

  // current base color of a slot (live material, honoring prior edits)
  slotColor(slot) {
    if (this.edits.colors[slot]) return this.edits.colors[slot];
    const mat = this.probe?.slots.get(slot)?.[0];
    return mat?.color ? `#${mat.color.getHexString()}` : '#888888';
  }

  set(kind, key, value) {
    if (value === '' || value === null) delete this.edits[kind][key];
    else this.edits[kind][key] = value;
    // live-preview on the probe instance
    if (this.probe?.vrm) applyVrmEdits(this.probe.vrm, { [kind]: { [key]: value } });
    // live-preview on any already-spawned entity wearing this avatar
    const group = this.view?.groups?.get(this.entityId);
    if (group?.userData.vrm) applyVrmEdits(group.userData.vrm, { [kind]: { [key]: value } });
    this.renderValues();
  }

  meshComponent() {
    const edits = {};
    for (const [k, v] of Object.entries(this.edits)) {
      if (Object.keys(v).length) edits[k] = structuredClone(v);
    }
    return { vrm: { src: this.probe.src, ...(Object.keys(edits).length ? { edits } : {}) } };
  }

  apply() {
    if (!this.probe) return;
    const id = cleanId(this.entityId);
    this.entityId = id;
    const exists = this.store.get(id);
    const px = this.player?.position?.x ?? 0;
    const pz = this.player?.position?.z ?? 0;
    const yaw = this.player?.bodyYaw ?? this.player?.yaw ?? 0;
    const components = {
      transform: exists?.transform ?? { position: [r2(px - Math.sin(yaw) * 2.2), 0, r2(pz - Math.cos(yaw) * 2.2)], rotation: [0, r2(yaw + Math.PI), 0] },
      ground: exists?.ground ?? { offset: 0 },
      mesh: this.meshComponent(),
    };
    let ops;
    let undo;
    if (exists) {
      ops = [{ op: 'set', id, component: 'mesh', value: components.mesh }];
      undo = [{ op: 'set', id, component: 'mesh', value: structuredClone(exists.mesh ?? null) }];
    } else {
      ops = [{ op: 'spawn', id, components }];
      undo = [{ op: 'despawn', id }];
    }
    this.send(ops);
    this.history?.push(undo, ops, `vrmEditor.${id}`);
    setTimeout(() => this.editor?.select(id), 150);
    this.note(`saved ${id} → world`);
  }

  loadFromSelection() {
    const id = this.editor?.selected;
    const spec = id && this.store.get(id)?.mesh?.vrm;
    if (!spec) {
      this.note('selected entity has no vrm mesh');
      return;
    }
    this.entityId = id;
    this.edits = { colors: {}, expressions: {}, bones: {}, meta: {}, ...structuredClone(spec.edits ?? {}) };
    const tpl = Object.entries(TEMPLATES).find(([, src]) => src === spec.src)?.[0];
    if (tpl) this.setTemplate(tpl);
    else this.render();
  }

  async download() {
    if (!this.probe) return;
    try {
      this.note('exporting VRM…');
      const blob = await exportVRM(this.probe.src, this.edits);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${cleanId(this.edits.meta.title || this.entityId)}.vrm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.note('VRM exported ✓ (colors+bones+meta baked)');
    } catch (err) {
      this.note(`export failed: ${err.message}`);
    }
  }

  reset() {
    this.edits = { colors: {}, expressions: {}, bones: {}, meta: {} };
    this.setTemplate(this.template); // fresh probe instance = pristine colors
  }

  note(text) {
    const el = this.mount.querySelector('.ve-note');
    if (el) el.textContent = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      const n = this.mount.querySelector('.ve-note');
      if (n?.textContent === text) n.textContent = '';
    }, 2600);
  }

  renderValues() {
    for (const span of this.mount.querySelectorAll('[data-value-for]')) {
      const [kind, key] = span.dataset.valueFor.split('.');
      const v = this.edits[kind]?.[key];
      if (kind === 'colors') span.textContent = this.slotColor(key);
      else span.textContent = v === undefined ? (kind === 'bones' ? '1.00' : '0.00') : Number(v).toFixed(2);
    }
  }

  render() {
    const templateOptions = Object.keys(TEMPLATES)
      .map((name) => `<option value="${name}"${name === this.template ? ' selected' : ''}>${name}</option>`)
      .join('');
    const colorRows = this.probe
      ? SLOT_LABELS.filter(([slot]) => this.probe.slots.has(slot))
          .map(
            ([slot, label]) =>
              `<label class="ve-row"><span>${label}</span><input data-edit="colors.${slot}" type="color" value="${this.slotColor(slot)}"><span class="ve-chip" data-value-for="colors.${slot}">${this.slotColor(slot)}</span></label>`,
          )
          .join('')
      : '';
    const exprRows = this.probe
      ? this.probe.expressions
          .map(
            (name) =>
              `<label class="ve-row"><span>${name}</span><input data-edit="expressions.${name}" type="range" min="0" max="1" step="0.01" value="${this.edits.expressions[name] ?? 0}"><span data-value-for="expressions.${name}">${(this.edits.expressions[name] ?? 0).toFixed(2)}</span></label>`,
          )
          .join('')
      : '';
    const boneRows = PROPORTION_BONES.map(
      (bone) =>
        `<label class="ve-row"><span>${bone}</span><input data-edit="bones.${bone}" type="range" min="0.6" max="1.6" step="0.01" value="${this.edits.bones[bone] ?? 1}"><span data-value-for="bones.${bone}">${Number(this.edits.bones[bone] ?? 1).toFixed(2)}</span></label>`,
    ).join('');
    this.mount.innerHTML = `
      <div class="ve-head"><div class="ve-title">VRM AVATAR EDITOR</div><button data-act="close">×</button></div>
      <div class="ve-doc">VRoid-compatible avatars as live world data. Edits are patches; export bakes them into a portable .vrm. Press V in creator mode.</div>
      <label class="ve-row"><span>template</span><select data-act="template">${templateOptions}</select><span></span></label>
      <label class="ve-row"><span>entity id</span><input data-act="id" type="text" value="${this.entityId}"><span></span></label>
      ${this.probe ? `
      <div class="ve-sect">COLORS</div>${colorRows}
      <div class="ve-sect">EXPRESSIONS</div>${exprRows}
      <div class="ve-sect">PROPORTIONS (bone scale)</div>${boneRows}
      <div class="ve-sect">META (baked on export)</div>
      <label class="ve-row"><span>title</span><input data-meta="title" type="text" value="${this.edits.meta.title ?? ''}"><span></span></label>
      <label class="ve-row"><span>author</span><input data-meta="author" type="text" value="${this.edits.meta.author ?? ''}"><span></span></label>
      ` : '<div class="ve-doc">loading template…</div>'}
      <div class="ve-buttons"><button data-act="apply">spawn/update</button><button data-act="selection">load selected</button><button data-act="export">export .vrm</button><button data-act="reset">reset</button></div>
      <div class="ve-note"></div>`;
    for (const input of this.mount.querySelectorAll('[data-edit]')) {
      const [kind, key] = input.dataset.edit.split('.');
      input.addEventListener('input', () => this.set(kind, key, input.type === 'range' ? Number(input.value) : input.value));
    }
    for (const input of this.mount.querySelectorAll('[data-meta]')) {
      input.addEventListener('change', () => this.set('meta', input.dataset.meta, input.value));
    }
    this.mount.querySelector('[data-act="close"]')?.addEventListener('click', () => this.toggle(false));
    this.mount.querySelector('[data-act="template"]')?.addEventListener('change', (e) => {
      this.edits = { colors: {}, expressions: {}, bones: {}, meta: {} };
      this.setTemplate(e.target.value);
    });
    this.mount.querySelector('[data-act="id"]')?.addEventListener('change', (e) => (this.entityId = cleanId(e.target.value)));
    this.mount.querySelector('[data-act="apply"]')?.addEventListener('click', () => this.apply());
    this.mount.querySelector('[data-act="selection"]')?.addEventListener('click', () => this.loadFromSelection());
    this.mount.querySelector('[data-act="export"]')?.addEventListener('click', () => this.download());
    this.mount.querySelector('[data-act="reset"]')?.addEventListener('click', () => this.reset());
  }
}
