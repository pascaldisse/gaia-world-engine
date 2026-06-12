import { SCHEMA, componentDefaults, fieldInfo } from '../../shared/schema.js';
import { div, span, button } from './dom.js';

// The inspector is a lens over the entity document: controls are generated
// from the JSON itself, so every component — present or future — is editable
// with zero per-component UI code. The schema (shared/schema.js) supplies
// meaning: docs, real ranges, enums, and the full add-component menu.

// fallback ranges ONLY for leaves the schema genuinely lacks (mesh-part
// transforms, env fog near/far, runtime weather.rain, sfx delay…) — a key
// the schema ranges must NOT appear here, or the two tables drift
const RANGES = {
  position: [-80, 80], rotation: [-3.1416, 3.1416], scale: [0.05, 8],
  segments: [16, 256], speed: [-5, 5], yaw: [-3.1416, 3.1416],
  level: [0, 1], y: [-10, 60], near: [1, 200], far: [10, 800],
  rain: [0, 1], delay: [0, 5],
};

const COMPONENT_DEFAULTS = componentDefaults();

export class Panel {
  constructor({ el, store, view, scenes, send, history, onDuplicate, onDelete, onEditPath, onEditCarves }) {
    this.el = el;
    this.store = store;
    this.view = view;
    this.scenes = scenes;
    this.send = send;
    this.history = history;
    this.onDuplicate = onDuplicate;
    this.onDelete = onDelete;
    this.onEditPath = onEditPath;
    this.onEditCarves = onEditCarves;
    this.id = null;
    this.sceneName = null;
    this.tab = 'fields';
    this.interacting = false;
    this.commitTimer = null;
    el.addEventListener('pointerdown', () => (this.interacting = true));
    window.addEventListener('pointerup', () => (this.interacting = false));
  }

  show(id) {
    this.id = id;
    this.sceneName = null;
    this.el.style.display = 'flex';
    this.render();
  }

  // a scene in the inspector: not an entity — its document is the streaming
  // geography (bounds disc, load volumes, neighbors), edited as JSON and
  // committed as a `scene` op the server persists to world.json
  showScene(name) {
    this.id = null;
    this.sceneName = name;
    this.el.style.display = 'flex';
    this.renderScene();
  }

  hide() {
    this.id = null;
    this.sceneName = null;
    this.el.style.display = 'none';
  }

  // called with each applied op batch — re-render only when one of the ops
  // actually touches what the panel is showing (presence streams, agent
  // traffic and carry merges must not rebuild the inspector)
  refresh(ops = null) {
    if (this.sceneName) {
      if (ops && !ops.some((op) => op.op === 'scene' && op.name === this.sceneName)) return;
      if (!this.interacting && !this.el.contains(document.activeElement)) this.renderScene();
      return;
    }
    if (!this.id) return;
    if (ops && !ops.some((op) => op.id === this.id)) return;
    if (!this.store.get(this.id)) {
      this.hide();
      return;
    }
    if (this.interacting || this.el.contains(document.activeElement)) return;
    this.render();
  }

  renderScene() {
    const raw = this.scenes?.rawScene(this.sceneName);
    if (!raw) {
      this.hide();
      return;
    }
    this.el.innerHTML = '';
    const head = div('panel-head');
    head.append(span('panel-title', `scene · ${this.sceneName}`));
    head.append(button('×', () => this.hide()));
    this.el.append(head);

    const state =
      this.view?.currentScene === this.sceneName
        ? 'current'
        : this.view?.activeScenes?.has(this.sceneName)
          ? 'resident'
          : 'streamed out';
    this.el.append(div('runtime', raw.always ? `${state} · always-loaded` : state));
    this.el.append(
      div(
        'section-doc',
        'bounds: the disc this scene claims. load: volumes that stream it in — ' +
          '{center:[x,z], radius, y:[min,max]}; a scene WITH load volumes no longer ' +
          'loads with its neighbors. Apply persists to world.json.',
      ),
    );

    const body = div('panel-body');
    this.el.append(body);
    const editable = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key !== 'name') editable[key] = value;
    }
    this.jsonEditor(body, editable, (next) => {
      if (next.name) delete next.name;
      const prev = structuredClone(editable);
      const value = {};
      const undoValue = {};
      for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
        value[key] = next[key] ?? null;
        undoValue[key] = prev[key] ?? null;
      }
      if (Object.keys(value).length) {
        const redo = [{ op: 'scene', name: this.sceneName, value }];
        this.send(redo);
        this.history.push([{ op: 'scene', name: this.sceneName, value: undoValue }], redo, `scene.${this.sceneName}`);
      }
    });
  }

  // textarea + apply + error line; onApply gets the parsed JSON and may
  // throw — the message lands in the error line
  jsonEditor(body, value, onApply) {
    const area = document.createElement('textarea');
    area.value = JSON.stringify(value, null, 2);
    area.spellcheck = false;
    body.append(area);
    const error = div('json-error');
    const apply = button('apply', () => {
      try {
        onApply(JSON.parse(area.value));
        error.textContent = '';
      } catch (err) {
        error.textContent = String(err.message ?? err);
      }
    });
    body.append(apply, error);
  }

  queueCommit(name, work) {
    clearTimeout(this.commitTimer);
    const value = structuredClone(work);
    this.commitTimer = setTimeout(() => {
      const prev = structuredClone(this.store.get(this.id)?.[name] ?? null);
      this.send([{ op: 'set', id: this.id, component: name, value }]);
      this.history.push(
        [{ op: 'set', id: this.id, component: name, value: prev }],
        [{ op: 'set', id: this.id, component: name, value }],
        `${this.id}.${name}`,
      );
    }, 120);
  }

  setComponent(name, value) {
    const prev = structuredClone(this.store.get(this.id)?.[name] ?? null);
    this.send([{ op: 'set', id: this.id, component: name, value }]);
    this.history.push(
      [{ op: 'set', id: this.id, component: name, value: prev }],
      [{ op: 'set', id: this.id, component: name, value: structuredClone(value) }],
    );
    setTimeout(() => this.render(), 80);
  }

  render() {
    const comps = this.store.get(this.id);
    if (!comps) return;
    this.el.innerHTML = '';

    const head = div('panel-head');
    head.append(span('panel-title', this.id));
    head.append(
      button('dup', () => this.onDuplicate?.(this.id)),
      button('del', () => this.onDelete?.(this.id)),
      button('×', () => this.hide()),
    );
    this.el.append(head);

    // runtime: what the kernel KNOWS vs what the data says — streamed-in or
    // data-only, which scene owns it, where it actually is right now
    if (this.view) {
      const group = this.view.getGroup(this.id);
      const built = group ? 'built' : this.view.isActive(comps) ? 'building…' : 'data-only (scene not streamed)';
      const pos = group ? group.position.toArray() : comps.transform?.position;
      const bits = [comps.scene?.name ? `scene ${comps.scene.name}` : 'unclaimed', built];
      // a bodiless entity's group sits at the origin — that's not a position
      if (pos && (comps.transform?.position || pos.some((v) => v !== 0))) {
        bits.push(`at ${pos.map((v) => (Math.round(v * 10) / 10).toFixed(1)).join(', ')}`);
      }
      this.el.append(div('runtime', bits.join(' · ')));
    }

    const tabs = div('panel-tabs');
    for (const tab of ['fields', 'json']) {
      const b = button(tab, () => {
        this.tab = tab;
        this.render();
      });
      if (tab === this.tab) b.classList.add('active');
      tabs.append(b);
    }
    this.el.append(tabs);

    const body = div('panel-body');
    this.el.append(body);
    if (this.tab === 'json') this.renderJson(body, comps);
    else this.renderFields(body, comps);
  }

  renderFields(body, comps) {
    for (const name of Object.keys(comps)) {
      const section = div('panel-section');
      const head = div('section-head');
      const title = span('section-name', name);
      if (SCHEMA[name]?.doc) title.title = SCHEMA[name].doc;
      head.append(title);
      head.append(button('×', () => this.setComponent(name, null)));
      section.append(head);
      if (SCHEMA[name]?.doc) section.append(div('section-doc', SCHEMA[name].doc));
      const work = structuredClone(comps[name]);
      const onEdit = () => this.queueCommit(name, work);
      const content = div('section-body');
      this.renderValue(content, { v: work }, 'v', name, onEdit, () => {
        this.queueCommit(name, work);
        setTimeout(() => this.render(), 160);
      });
      section.append(content);
      // tube parts get a door into the world: Edit Path hands the spline to
      // the editor (click a point, W moves it, R scales its thickness) —
      // and Edit Holes does the same for the boolean cutters (`carve`):
      // ghost meshes you grab with the entity gizmos
      if (name === 'mesh') {
        const parts = comps.mesh?.parts ?? [comps.mesh];
        parts.forEach((part, i) => {
          const tag = parts.length > 1 ? ` · part ${i}` : '';
          if (part?.shape === 'tube' && Array.isArray(part.path) && part.path.length >= 2) {
            section.append(button(`edit path${tag}`, () => this.onEditPath?.(this.id, i)));
          }
          if (!part) return;
          const n = Array.isArray(part.carve) ? part.carve.length : 0;
          section.append(button(`edit holes (${n})${tag}`, () => this.onEditCarves?.(this.id, i)));
        });
      }
      body.append(section);
    }

    const addRow = div('panel-add');
    const select = document.createElement('select');
    select.append(new Option('+ add component', ''));
    for (const name of Object.keys(COMPONENT_DEFAULTS)) {
      if (!comps[name]) select.append(new Option(name, name));
    }
    select.onchange = () => {
      if (select.value) this.setComponent(select.value, structuredClone(COMPONENT_DEFAULTS[select.value]));
    };
    addRow.append(select);
    body.append(addRow);
  }

  // renders holder[key] into parent; mutates holder in place and calls onEdit
  renderValue(parent, holder, key, comp, onEdit, onRestructure, label = null) {
    const value = holder[key];
    const info = fieldInfo(comp, key);
    const labelEl = () => {
      const el = span('label', label ?? key);
      if (info?.doc) el.title = info.doc;
      return el;
    };

    if (typeof value === 'number') {
      parent.append(this.numberRow(labelEl(), value, comp, key, (v) => {
        holder[key] = v;
        onEdit();
      }));
      return;
    }
    if (typeof value === 'boolean') {
      const row = div('row');
      row.append(labelEl());
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = value;
      box.onchange = () => {
        holder[key] = box.checked;
        onEdit();
      };
      row.append(box);
      parent.append(row);
      return;
    }
    if (typeof value === 'string') {
      const row = div('row');
      row.append(labelEl());
      const options = info?.enum;
      if (/^#[0-9a-f]{3,8}$/i.test(value)) {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = value.length === 4 ? expandHex(value) : value;
        input.oninput = () => {
          holder[key] = input.value;
          onEdit();
        };
        row.append(input);
      } else if (options) {
        const select = document.createElement('select');
        for (const opt of options) select.append(new Option(opt, opt, false, opt === value));
        select.onchange = () => {
          holder[key] = select.value;
          onEdit();
          onRestructure?.();
        };
        row.append(select);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.onchange = () => {
          holder[key] = input.value;
          onEdit();
        };
        row.append(input);
      }
      parent.append(row);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length && value.length <= 4 && value.every((n) => typeof n === 'number')) {
        const row = div('row');
        row.append(labelEl());
        const wrap = div('vec');
        value.forEach((n, i) => {
          const input = document.createElement('input');
          input.type = 'number';
          input.step = 'any';
          input.value = n;
          input.oninput = () => {
            value[i] = Number(input.value) || 0;
            onEdit();
          };
          wrap.append(input);
        });
        row.append(wrap);
        parent.append(row);
        return;
      }
      const block = div('block');
      block.append(labelEl());
      value.forEach((item, i) => {
        const itemHead = div('item-head');
        itemHead.append(span('item-label', `${i}`));
        itemHead.append(
          button('×', () => {
            value.splice(i, 1);
            onRestructure?.();
          }),
        );
        block.append(itemHead);
        const sub = div('indent');
        this.renderValue(sub, value, i, comp, onEdit, onRestructure, ' ');
        block.append(sub);
      });
      block.append(
        button('+ item', () => {
          value.push(structuredClone(value[value.length - 1] ?? {}));
          onRestructure?.();
        }),
      );
      parent.append(block);
      return;
    }
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        this.renderValue(parent, value, k, comp, onEdit, onRestructure);
      }
      return;
    }
  }

  numberRow(labelEl, value, comp, rangeKey, onChange) {
    const row = div('row');
    row.append(labelEl);
    const [min, max] =
      fieldInfo(comp, rangeKey)?.range ??
      RANGES[rangeKey] ??
      (value >= 0 ? [0, Math.max(1, value * 4)] : [-Math.abs(value) * 4, Math.abs(value) * 4]);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = (max - min) / 200;
    slider.value = value;
    const num = document.createElement('input');
    num.type = 'number';
    num.step = 'any';
    num.value = value;
    slider.oninput = () => {
      num.value = slider.value;
      onChange(Number(slider.value));
    };
    num.oninput = () => {
      slider.value = num.value;
      onChange(Number(num.value) || 0);
    };
    row.append(slider, num);
    return row;
  }

  renderJson(body, comps) {
    this.jsonEditor(body, comps, (next) => {
      const prev = structuredClone(comps);
      const undoOps = [];
      const redoOps = [];
      for (const name of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (JSON.stringify(prev[name]) === JSON.stringify(next[name])) continue;
        undoOps.push({ op: 'set', id: this.id, component: name, value: prev[name] ?? null });
        redoOps.push({ op: 'set', id: this.id, component: name, value: next[name] ?? null });
      }
      if (redoOps.length) {
        this.send(redoOps);
        this.history.push(undoOps, redoOps);
      }
    });
  }
}

function expandHex(hex) {
  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
}
