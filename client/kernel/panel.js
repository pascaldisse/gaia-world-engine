// The inspector is a lens over the entity document: controls are generated
// from the JSON itself, so every component — present or future — is editable
// with zero per-component UI code.

const ENUMS = {
  'mesh.shape': ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octahedron', 'icosahedron', 'plane'],
  'light.type': ['point', 'spot', 'directional'],
  'behavior.type': ['spin', 'bob', 'orbit', 'pulse', 'flicker'],
  'sound.kind': ['hum', 'chime', 'patch', 'sample'],
  'sound.wave': ['sine', 'square', 'sawtooth', 'triangle'],
  'sound.source': ['noise', 'sine', 'square', 'sawtooth', 'triangle'],
  'sound.target': ['gain', 'freq', 'filter'],
  'scatter.shape': ['circle', 'rect'],
  'particles.type': ['drift', 'rain'],
  preset: ['glow', 'flame', 'water', 'hologram'],
  'sfx.on': ['lightning', 'grab', 'drop', 'say', 'intent'],
  'sfx.wave': ['sine', 'square', 'sawtooth', 'triangle', 'noise'],
};

const RANGES = {
  position: [-80, 80], rotation: [-3.1416, 3.1416], scale: [0.05, 8], offset: [-10, 10],
  intensity: [0, 120], distance: [0, 120], emissiveIntensity: [0, 6],
  radius: [0.05, 12], radiusTop: [0.05, 12], radiusBottom: [0.05, 12], height: [0.05, 24],
  tube: [0.05, 4], size: [0.05, 40], segments: [16, 256],
  roughness: [0, 1], metalness: [0, 1], opacity: [0, 1],
  freq: [20, 1200], level: [0, 1], interval: [0.1, 10], refDistance: [1, 30],
  speed: [-5, 5], amplitude: [0, 20], amount: [0, 1], phase: [0, 6.283],
  frequency: [0.001, 0.08], seed: [1, 99], fov: [10, 170], range: [1, 200], yaw: [-3.1416, 3.1416],
  count: [1, 2000], offsetY: [-5, 10], tilt: [0, 1], noise: [0.001, 0.1], bias: [0, 1],
  strength: [0, 2], threshold: [0, 1], near: [1, 200], far: [10, 800], exposure: [0.2, 3],
  density: [0.001, 0.05], bob: [0, 5], y: [-10, 60],
  gain: [0, 1], detune: [-100, 100], Q: [0.1, 20], rate: [0, 20], depth: [0, 1],
  reverb: [0, 1], attack: [0, 1], decay: [0, 6], delay: [0, 5], lowpass: [40, 8000], sweep: [20, 4000],
  rainCycle: [5, 600], rainAmount: [0, 1], rain: [0, 1], minGap: [1, 120], maxGap: [2, 240],
  glowStrength: [0, 4], lines: [2, 120],
};

const COMPONENT_DEFAULTS = {
  transform: { position: [0, 0, 0] },
  ground: { offset: 0 },
  mesh: { parts: [{ shape: 'box', size: [1, 1, 1], color: '#9aa0a6' }] },
  light: { type: 'point', color: '#ffffff', intensity: 20, distance: 30 },
  sound: { kind: 'hum', freq: 110, level: 0.2 },
  behavior: { type: 'spin', speed: 1 },
};

export class Panel {
  constructor({ el, store, send, history, onDuplicate, onDelete }) {
    this.el = el;
    this.store = store;
    this.send = send;
    this.history = history;
    this.onDuplicate = onDuplicate;
    this.onDelete = onDelete;
    this.id = null;
    this.tab = 'fields';
    this.interacting = false;
    this.commitTimer = null;
    el.addEventListener('pointerdown', () => (this.interacting = true));
    window.addEventListener('pointerup', () => (this.interacting = false));
  }

  show(id) {
    this.id = id;
    this.el.style.display = 'flex';
    this.render();
  }

  hide() {
    this.id = null;
    this.el.style.display = 'none';
  }

  refresh() {
    if (!this.id) return;
    if (!this.store.get(this.id)) {
      this.hide();
      return;
    }
    if (this.interacting || this.el.contains(document.activeElement)) return;
    this.render();
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
      head.append(span('section-name', name));
      head.append(button('×', () => this.setComponent(name, null)));
      section.append(head);
      const work = structuredClone(comps[name]);
      const onEdit = () => this.queueCommit(name, work);
      const content = div('section-body');
      this.renderValue(content, { v: work }, 'v', name, onEdit, () => {
        this.queueCommit(name, work);
        setTimeout(() => this.render(), 160);
      });
      section.append(content);
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

    if (typeof value === 'number') {
      parent.append(this.numberRow(label ?? key, value, key, (v) => {
        holder[key] = v;
        onEdit();
      }));
      return;
    }
    if (typeof value === 'boolean') {
      const row = div('row');
      row.append(span('label', label ?? key));
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
      row.append(span('label', label ?? key));
      const options = ENUMS[`${comp}.${key}`] ?? ENUMS[key];
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
        row.append(span('label', label ?? key));
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
      block.append(span('label', label ?? key));
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

  numberRow(label, value, rangeKey, onChange) {
    const row = div('row');
    row.append(span('label', label));
    const [min, max] = RANGES[rangeKey] ?? (value >= 0 ? [0, Math.max(1, value * 4)] : [-Math.abs(value) * 4, Math.abs(value) * 4]);
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
    const area = document.createElement('textarea');
    area.value = JSON.stringify(comps, null, 2);
    area.spellcheck = false;
    body.append(area);
    const error = div('json-error');
    const apply = button('apply', () => {
      try {
        const next = JSON.parse(area.value);
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
        error.textContent = '';
      } catch (err) {
        error.textContent = String(err.message ?? err);
      }
    });
    body.append(apply, error);
  }
}

function div(cls) {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

function button(text, onClick) {
  const el = document.createElement('button');
  el.textContent = text;
  el.onclick = onClick;
  return el;
}

function expandHex(hex) {
  return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
}
