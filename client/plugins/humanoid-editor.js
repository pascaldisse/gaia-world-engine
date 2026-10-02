// HUMANOID KIT EDITOR — one base body, N characters: pick a base + preset, toggle costume pieces per
// slot, drag body params, color the slots, seed a variant, then spawn it as an op or save the preset
// as a JSON file. Press H in creator mode. Spec: docs/HUMANOID-KIT-SPEC.md
//
// What it edits is `mesh.humanoid` (pure world data) — the unit's OVERRIDES on top of an optional
// preset. Slider/swatch drags preview on a local ghost (no op per tick, double-buffered so the
// body never blinks); `spawn/update` is the single undoable op.
import * as THREE from 'three';
import { isTyping } from '../kernel/dom.js';
import { r2 } from '../../shared/num.js';
import { heightAt } from '../kernel/terrain.js';
import { PARAM_DEFS, PARAM_NAMES, DEFAULT_COLOR_SLOTS, DEFAULT_COSTUME_SLOTS, resolveHumanoid, loadPresetChain } from '../../shared/humanoid.js';
import { mountHumanoid, releaseHumanoid, resolveAssetUrl, fetchAssetJson } from '../kernel/humanoid.js';

const DEFAULT_KIT = '/assets/humanoid/kit.json';
const PARAM_LABELS = { height: 'height', build: 'build', torsoLength: 'torso len', shoulders: 'shoulders', neckLength: 'neck len', headScale: 'head', armLength: 'arm len', legLength: 'leg len', handScale: 'hands', footScale: 'feet' };
const cleanId = (id) =>
  String(id || 'humanoid-unit')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'humanoid-unit';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class HumanoidEditor {
  constructor({ store, view, send, history, editor, player }) {
    this.store = store;
    this.view = view;
    this.send = send;
    this.history = history;
    this.editor = editor;
    this.player = player;
    this.visible = false;
    this.kitUrl = DEFAULT_KIT;
    this.kit = null;
    this.entityId = 'humanoid-unit';
    this.unit = { costume: {}, params: {}, colors: {} }; // overrides only
    this.presetDoc = null; // flattened preset the unit sits on (for displaying inherited values)
    this.ghost = null; // current preview instance group
    this.ghostToken = 0;
    this.variantCount = 6;
    this.mount = document.createElement('div');
    this.mount.id = 'humanoid-editor';
    this.injectStyle();
    this.render();
    document.body.append(this.mount);
    document.addEventListener('keydown', (e) => {
      if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyH' && this.editor?.mode === 'create' && !this.player?.gameMode) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  injectStyle() {
    if (document.getElementById('humanoid-editor-style')) return;
    const style = document.createElement('style');
    style.id = 'humanoid-editor-style';
    style.textContent = `
#humanoid-editor{position:fixed;left:12px;top:56px;width:344px;max-height:84vh;display:none;flex-direction:column;gap:7px;padding:10px;background:rgba(10,20,14,.95);border:1px solid rgba(130,235,160,.30);border-radius:10px;color:#dcf5e2;font:11px ui-monospace,'SF Mono',Menlo,monospace;z-index:34;box-shadow:0 12px 40px rgba(0,0,0,.38);overflow:auto}
#humanoid-editor .he-head{display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(130,235,160,.18);padding-bottom:7px}.he-title{flex:1;color:#8df0a8;font-weight:700;letter-spacing:.08em}.he-doc{color:#9fc2a9;line-height:1.35}.he-sect{color:#8df0a8;letter-spacing:.06em;margin-top:4px;border-bottom:1px dashed rgba(130,235,160,.15);padding-bottom:2px}
#humanoid-editor .he-row{display:grid;grid-template-columns:78px 1fr 44px 18px;align-items:center;gap:6px}.he-row input[type='range']{width:100%}.he-row input[type='color']{width:42px;height:22px;padding:0;border:0;background:transparent}.he-row input[type='text'],.he-row input[type='number'],#humanoid-editor select{background:rgba(0,0,0,.25);border:1px solid rgba(130,235,160,.20);border-radius:6px;color:#dcf5e2;font:inherit;padding:4px;min-width:0}
#humanoid-editor .he-buttons{display:flex;gap:6px;flex-wrap:wrap}.he-buttons button,#humanoid-editor .he-head button,.he-row button{background:rgba(130,235,160,.10);border:1px solid rgba(130,235,160,.28);border-radius:8px;color:#dcf5e2;font:inherit;padding:4px 8px;cursor:pointer}.he-row button{padding:0 4px;border-radius:5px;color:#9fc2a9}.he-buttons button:hover,#humanoid-editor .he-head button:hover,.he-row button:hover{background:rgba(130,235,160,.22)}.he-note{color:#ffd9a0;min-height:1.2em}.he-chip{color:#9fc2a9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.he-inh{opacity:.55}`;
    document.head.append(style);
  }

  toggle(on = !this.visible) {
    this.visible = on;
    this.mount.style.display = on ? 'flex' : 'none';
    if (on && !this.kit) this.loadKit();
    if (on) this.preview();
    else this.clearGhost();
  }

  // ---- kit + preset ----------------------------------------------------------
  async loadKit(url = this.kitUrl) {
    this.kitUrl = url;
    this.note('loading kit…');
    try {
      const res = await fetch(await resolveAssetUrl(url));
      if (!res.ok) throw new Error(`${res.status}`);
      this.kit = await res.json();
      if (!this.unit.base && !this.unit.preset) {
        const preset = Object.values(this.kit.presets ?? {})[0];
        if (preset) this.unit.preset = preset;
        else this.unit.base = Object.values(this.kit.bases ?? {})[0];
      }
      this.note(`kit ${this.kit.name ?? url} ✓`);
    } catch (err) {
      this.kit = null;
      this.note(`kit load failed: ${err.message}`);
    }
    await this.refreshPreset();
    this.render();
    this.preview();
  }

  async refreshPreset() {
    this.presetDoc = null;
    if (!this.unit.preset) return;
    try {
      this.presetDoc = await loadPresetChain(this.unit.preset, async (u) => fetchAssetJson(await resolveAssetUrl(u)));
    } catch (err) {
      this.note(`preset failed: ${err.message}`);
    }
  }

  // effective values = preset → unit overrides (seed variation is applied by the mount, not shown here)
  concrete() {
    return resolveHumanoid({ ...this.unit, seed: undefined }, this.presetDoc);
  }

  async setPreset(url) {
    if (url) this.unit.preset = url;
    else delete this.unit.preset;
    // a preset swap re-bases the look: drop overrides so the preset actually shows
    this.unit.params = {};
    this.unit.costume = {};
    this.unit.colors = {};
    delete this.unit.base;
    await this.refreshPreset();
    this.render();
    this.preview();
  }

  // ---- edits ------------------------------------------------------------------
  setParam(name, v) {
    this.unit.params[name] = Number(v);
    this.syncRow(`params.${name}`, Number(v).toFixed(2));
    this.previewSoon();
  }
  clearParam(name) {
    delete this.unit.params[name];
    this.render();
    this.previewSoon();
  }
  setColor(slot, hex) {
    this.unit.colors[slot] = hex;
    this.syncRow(`colors.${slot}`, hex);
    this.previewSoon();
  }
  clearColor(slot) {
    delete this.unit.colors[slot];
    this.render();
    this.previewSoon();
  }
  setPiece(slot, url) {
    // '' = inherit preset, '-' = explicit none
    if (url === '') delete this.unit.costume[slot];
    else this.unit.costume[slot] = url === '-' ? null : url;
    this.previewSoon();
  }
  setSeed(v) {
    if (v === '' || v === null || v === undefined) delete this.unit.seed;
    else this.unit.seed = Number(v);
    this.preview();
  }
  rollSeed() {
    this.unit.seed = 1 + Math.floor(Math.random() * 9999); // UI action only — the RESULT is stored as data
    this.render();
    this.preview();
  }
  reset() {
    this.unit = { costume: {}, params: {}, colors: {}, preset: this.unit.preset };
    this.render();
    this.preview();
  }

  specNow() {
    const u = { ...this.unit };
    for (const k of ['params', 'costume', 'colors']) if (!Object.keys(u[k] ?? {}).length) delete u[k];
    return structuredClone(u);
  }

  // ---- preview ghost (double-buffered) -------------------------------------------
  previewSoon() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.preview(), 50);
  }
  ghostPose() {
    const px = this.player?.position?.x ?? 0;
    const pz = this.player?.position?.z ?? 0;
    const yaw = this.player?.bodyYaw ?? this.player?.yaw ?? 0;
    const x = r2(px - Math.sin(yaw) * 2.6);
    const z = r2(pz - Math.cos(yaw) * 2.6);
    return { x, z, y: heightAt(x, z), yaw: yaw + Math.PI };
  }
  async preview() {
    if (!this.visible || !this.view?.scene) return;
    const spec = this.specNow();
    if (!spec.preset && !spec.base) return;
    const token = ++this.ghostToken;
    const next = new THREE.Group();
    next.userData.humanoidToken = token;
    const pose = this.ghost?.userData.pose ?? this.ghostPose();
    next.userData.pose = pose;
    next.position.set(pose.x, pose.y, pose.z);
    next.rotation.y = pose.yaw;
    this.view.scene.add(next);
    const root = await mountHumanoid(next, spec, token, () => {});
    if (token !== this.ghostToken || !this.visible) {
      this.disposeGroup(next);
      return;
    }
    if (!root) {
      this.disposeGroup(next);
      this.note('preview failed (see console)');
      return;
    }
    const old = this.ghost;
    this.ghost = next;
    if (old) this.disposeGroup(old);
    this.view.buildVersion++;
    const issues = root.userData.humanoid.report;
    if (issues.drift.length || issues.failed.length || issues.unmapped.length) this.note(`pieces: ${issues.failed.length} failed · ${issues.drift.length} drift · ${issues.unmapped.length} unmapped`);
  }
  disposeGroup(group) {
    group.traverse((n) => releaseHumanoid(n));
    group.parent?.remove(group);
  }
  clearGhost() {
    this.ghostToken++;
    if (this.ghost) this.disposeGroup(this.ghost);
    this.ghost = null;
  }

  // ---- ops -------------------------------------------------------------------------
  meshComponent() {
    return { humanoid: this.specNow() };
  }
  apply() {
    const id = cleanId(this.entityId);
    this.entityId = id;
    const exists = this.store.get(id);
    const pose = this.ghost?.userData.pose ?? this.ghostPose();
    const components = {
      transform: exists?.transform ?? { position: [pose.x, 0, pose.z], rotation: [0, r2(pose.yaw), 0] },
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
    this.history?.push(undo, ops, `humanoidEditor.${id}`);
    setTimeout(() => this.editor?.select(id), 150);
    this.note(`saved ${id} → world`);
  }
  // N seeded variants of the current unit, in a row — the "model once, generate the rest" move
  spawnVariants() {
    const n = Math.max(1, Math.min(48, Number(this.variantCount) || 6));
    const id0 = cleanId(this.entityId);
    const pose = this.ghost?.userData.pose ?? this.ghostPose();
    const right = [Math.cos(pose.yaw), -Math.sin(pose.yaw)];
    const ops = [];
    const undo = [];
    for (let i = 0; i < n; i++) {
      const id = `${id0}-v${i + 1}`;
      const off = (i - (n - 1) / 2) * 1.1;
      const spec = { ...this.specNow(), seed: (this.unit.seed ?? 0) * 1000 + i + 1 };
      ops.push({
        op: 'spawn', id,
        components: {
          transform: { position: [r2(pose.x + right[0] * off), 0, r2(pose.z + right[1] * off)], rotation: [0, r2(pose.yaw), 0] },
          ground: { offset: 0 },
          mesh: { humanoid: spec },
        },
      });
      undo.push({ op: 'despawn', id });
    }
    this.send(ops);
    this.history?.push(undo, ops, `humanoidEditor.variants.${id0}`);
    this.note(`spawned ${n} variants (${id0}-v1…)`);
  }
  loadFromSelection() {
    const id = this.editor?.selected;
    const spec = id && this.store.get(id)?.mesh?.humanoid;
    if (!spec) {
      this.note('selected entity has no humanoid mesh');
      return;
    }
    this.entityId = id;
    this.unit = { ...structuredClone(spec), costume: structuredClone(spec.costume ?? {}), params: structuredClone(spec.params ?? {}), colors: structuredClone(spec.colors ?? {}) };
    this.refreshPreset().then(() => {
      this.render();
      this.preview();
    });
  }
  // preset = recipe: unit state as a reusable JSON file (extends the current preset when there is one)
  presetDocument(name) {
    const c = this.concrete();
    const u = this.specNow();
    const doc = { name };
    if (u.preset) doc.extends = u.preset;
    else if (c.base) doc.base = c.base;
    if (u.base) doc.base = u.base;
    for (const k of ['params', 'costume', 'colors']) if (u[k]) doc[k] = u[k];
    if (this.presetDoc?.vary) doc.vary = this.presetDoc.vary;
    return doc;
  }
  savePreset() {
    const name = cleanId(this.entityId);
    const blob = new Blob([JSON.stringify(this.presetDocument(name), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    this.note(`preset ${name}.json saved ✓`);
  }

  note(text) {
    const el = this.mount.querySelector('.he-note');
    if (el) el.textContent = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      const n = this.mount.querySelector('.he-note');
      if (n?.textContent === text) n.textContent = '';
    }, 3200);
  }
  syncRow(key, text) {
    const el = this.mount.querySelector(`[data-value-for="${key}"]`);
    if (el) el.textContent = text;
  }

  // ---- UI ----------------------------------------------------------------------------
  render() {
    const c = this.concrete();
    const kit = this.kit;
    const sel = (v, cur) => (v === cur ? ' selected' : '');
    const presets = Object.entries(kit?.presets ?? {});
    const presetOptions = [`<option value=""${sel('', this.unit.preset ?? '')}>(none — bare base)</option>`, ...presets.map(([name, url]) => `<option value="${esc(url)}"${sel(url, this.unit.preset ?? '')}>${esc(name)}</option>`)].join('');
    const bases = Object.entries(kit?.bases ?? {});
    const baseOptions = bases.map(([name, url]) => `<option value="${esc(url)}"${sel(url, c.base ?? '')}>${esc(name)}</option>`).join('');
    const slotNames = [...new Set([...DEFAULT_COSTUME_SLOTS.filter((s) => kit?.slots?.[s]), ...Object.keys(kit?.slots ?? {})])];
    const slotRows = slotNames.map((slot) => {
      const pieces = Object.entries(kit.slots[slot].pieces ?? {});
      const own = slot in this.unit.costume ? (this.unit.costume[slot] === null ? '-' : this.unit.costume[slot]) : '';
      const inherited = c.costume[slot] ?? null;
      const inhName = pieces.find(([, u]) => u === inherited)?.[0];
      const opts = [
        `<option value=""${sel('', own)}>${slot in this.unit.costume ? 'inherit' : `· ${inhName ?? 'none'}`}</option>`,
        `<option value="-"${sel('-', own)}>none</option>`,
        ...pieces.map(([name, url]) => `<option value="${esc(url)}"${sel(url, own)}>${esc(name)}</option>`),
      ].join('');
      return `<label class="he-row"><span>${esc(slot)}</span><select data-piece="${esc(slot)}">${opts}</select><span></span><span></span></label>`;
    }).join('');
    const paramRows = PARAM_NAMES.map((name) => {
      const [lo, hi] = PARAM_DEFS[name].range;
      const own = name in this.unit.params;
      return `<label class="he-row${own ? '' : ' he-inh'}" title="${esc(PARAM_DEFS[name].doc)}"><span>${PARAM_LABELS[name]}</span><input data-param="${name}" type="range" min="${lo}" max="${hi}" step="0.01" value="${c.params[name]}"><span data-value-for="params.${name}">${c.params[name].toFixed(2)}</span>${own ? `<button data-clear-param="${name}" title="inherit">×</button>` : '<span></span>'}</label>`;
    }).join('');
    const colorSlots = kit?.colorSlots ?? DEFAULT_COLOR_SLOTS;
    const colorRows = colorSlots.map((slot) => {
      const own = slot in this.unit.colors;
      const hex = c.colors[slot] ?? '#888888';
      return `<label class="he-row${own ? '' : ' he-inh'}"><span>${esc(slot)}</span><input data-color="${esc(slot)}" type="color" value="${hex}"><span class="he-chip" data-value-for="colors.${esc(slot)}">${c.colors[slot] ?? '—'}</span>${own ? `<button data-clear-color="${esc(slot)}" title="inherit">×</button>` : '<span></span>'}</label>`;
    }).join('');
    this.mount.innerHTML = `
<div class="he-head"><div class="he-title">HUMANOID KIT</div><button data-act="close">×</button></div>
<div class="he-doc">One base body → N characters. Edits are overrides on a preset; the unit is plain data (<b>mesh.humanoid</b>). Press H in creator mode.</div>
<label class="he-row"><span>kit</span><input data-act="kit" type="text" value="${esc(this.kitUrl)}"><span></span><span></span></label>
<label class="he-row"><span>preset</span><select data-act="preset">${presetOptions}</select><span></span><span></span></label>
<label class="he-row"><span>base</span><select data-act="base">${baseOptions}</select><span></span><span></span></label>
<div class="he-sect">COSTUME</div>${slotRows || '<div class="he-doc">no kit loaded</div>'}
<div class="he-sect">BODY</div>${paramRows}
<div class="he-sect">COLORS</div>${colorRows}
<div class="he-sect">VARIANT</div>
<label class="he-row"><span>seed</span><input data-act="seed" type="number" step="1" value="${this.unit.seed ?? ''}" placeholder="none"><button data-act="roll" title="new random seed (stored as data)">🎲</button><span></span></label>
<label class="he-row"><span>variants</span><input data-act="count" type="number" min="1" max="48" value="${this.variantCount}"><span></span><span></span></label>
<label class="he-row"><span>entity id</span><input data-act="id" type="text" value="${esc(this.entityId)}"><span></span><span></span></label>
<div class="he-buttons"><button data-act="apply">spawn/update</button><button data-act="variants">spawn variants</button><button data-act="selection">load selected</button><button data-act="save">save preset</button><button data-act="reset">reset</button></div>
<div class="he-note"></div>`;
    const $ = (sel2) => this.mount.querySelector(sel2);
    const on = (sel2, ev, fn) => this.mount.querySelectorAll(sel2).forEach((el) => el.addEventListener(ev, () => fn(el)));
    on('[data-param]', 'input', (el) => this.setParam(el.dataset.param, el.value));
    on('[data-param]', 'change', () => this.render()); // drag ended: refresh override styling
    on('[data-clear-param]', 'click', (el) => this.clearParam(el.dataset.clearParam));
    on('[data-color]', 'input', (el) => this.setColor(el.dataset.color, el.value));
    on('[data-color]', 'change', () => this.render());
    on('[data-clear-color]', 'click', (el) => this.clearColor(el.dataset.clearColor));
    on('[data-piece]', 'change', (el) => this.setPiece(el.dataset.piece, el.value));
    $('[data-act="close"]')?.addEventListener('click', () => this.toggle(false));
    $('[data-act="kit"]')?.addEventListener('change', (e) => this.loadKit(e.target.value.trim() || DEFAULT_KIT));
    $('[data-act="preset"]')?.addEventListener('change', (e) => this.setPreset(e.target.value));
    $('[data-act="base"]')?.addEventListener('change', (e) => { this.unit.base = e.target.value; this.preview(); });
    $('[data-act="seed"]')?.addEventListener('change', (e) => this.setSeed(e.target.value));
    $('[data-act="roll"]')?.addEventListener('click', () => this.rollSeed());
    $('[data-act="count"]')?.addEventListener('change', (e) => (this.variantCount = Number(e.target.value)));
    $('[data-act="id"]')?.addEventListener('change', (e) => (this.entityId = cleanId(e.target.value)));
    $('[data-act="apply"]')?.addEventListener('click', () => this.apply());
    $('[data-act="variants"]')?.addEventListener('click', () => this.spawnVariants());
    $('[data-act="selection"]')?.addEventListener('click', () => this.loadFromSelection());
    $('[data-act="save"]')?.addEventListener('click', () => this.savePreset());
    $('[data-act="reset"]')?.addEventListener('click', () => this.reset());
  }
}
