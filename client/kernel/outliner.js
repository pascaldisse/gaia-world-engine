// The outliner is the answer to "what exists here?": every entity in the
// world, grouped by scene, selectable even when it has no body to click —
// triggers, water volumes, ambience patches, the environment itself.
// Searchable; doubles as the gizmo-category switchboard.

const ICONS = [
  ['presence', '◉'],
  ['spawn', '⌖'],
  ['environment', '☼'],
  ['weather', 'ϟ'],
  ['terrain', '▲'],
  ['water', '≈'],
  ['trigger', '◈'],
  ['interact', '✧'],
  ['light', '✦'],
  ['sound', '♪'],
  ['particles', '∴'],
  ['scatter', '⁂'],
  ['mesh', '▣'],
  ['behavior', '↻'],
];

function iconFor(comps) {
  for (const [name, icon] of ICONS) if (comps[name]) return icon;
  return '·';
}

export class Outliner {
  constructor({ el, store, view, scenes, gizmos, onPick, onFocus, onScene }) {
    this.el = el;
    this.store = store;
    this.view = view;
    this.scenes = scenes;
    this.gizmos = gizmos;
    this.onPick = onPick;
    this.onFocus = onFocus;
    this.onScene = onScene;
    this.collapsed = new Set();
    this.search = '';
    this.selected = null;
    this.visible = false;
    this.dirty = true;
    this.lastRender = 0;
    this.sceneSeen = null;
    this.rows = new Map();
    // presence pose merges arrive constantly — only structural changes
    // (spawn/despawn/snapshot, or a component appearing/changing kind)
    // should rebuild the list
    store.onChange((event) => {
      if (event.kind !== 'set') this.dirty = true;
      else if (event.component !== 'transform' && event.component !== 'presence') this.dirty = true;
    });
    this.buildChrome();
  }

  buildChrome() {
    this.el.innerHTML = '';
    const head = div('o-head');
    const title = span('o-title', 'world');
    this.countEl = span('o-count', '');
    head.append(title, this.countEl);
    this.el.append(head);

    this.searchEl = document.createElement('input');
    this.searchEl.type = 'text';
    this.searchEl.placeholder = 'search id or component…';
    this.searchEl.addEventListener('input', () => {
      this.search = this.searchEl.value;
      this.renderList();
    });
    this.el.append(this.searchEl);

    // gizmo switchboard: each chip toggles a show-all overlay category
    // (the selected entity always draws its own gizmos)
    if (this.gizmos) {
      const chips = div('o-gizmos');
      this.chipEls = new Map();
      for (const { key, label } of this.gizmos.categories) {
        const chip = document.createElement('button');
        chip.textContent = label;
        chip.onclick = () => {
          this.gizmos.toggle(key);
          chip.classList.toggle('active', this.gizmos.show.has(key));
        };
        this.chipEls.set(key, chip);
        chips.append(chip);
      }
      this.el.append(chips);
    }

    this.listEl = div('o-list');
    this.el.append(this.listEl);
  }

  show() {
    this.visible = true;
    this.el.style.display = 'flex';
    if (this.chipEls && this.gizmos) {
      for (const [key, chip] of this.chipEls) chip.classList.toggle('active', this.gizmos.show.has(key));
    }
    this.renderList();
  }

  hide() {
    this.visible = false;
    this.el.style.display = 'none';
  }

  setSelected(id) {
    if (this.selected) this.rows.get(this.selected)?.classList.remove('selected');
    this.selected = id;
    if (id) this.rows.get(id)?.classList.add('selected');
  }

  update() {
    if (!this.visible) return;
    if (this.view.currentScene !== this.sceneSeen) {
      this.sceneSeen = this.view.currentScene;
      this.dirty = true;
    }
    if (this.dirty && performance.now() - this.lastRender > 600) this.renderList();
  }

  // groups: unclaimed world entities first (environment, state, spawn…), then
  // scenes in world-file order with the current one marked, presences last
  groupsOf() {
    const presences = [];
    const unclaimed = [];
    const byScene = new Map();
    for (const [id, comps] of this.store.entities) {
      if (comps.presence) presences.push([id, comps]);
      else if (comps.scene?.name) {
        if (!byScene.has(comps.scene.name)) byScene.set(comps.scene.name, []);
        byScene.get(comps.scene.name).push([id, comps]);
      } else unclaimed.push([id, comps]);
    }
    const groups = [];
    if (unclaimed.length) groups.push({ name: 'world', rows: unclaimed });
    const index = this.scenes?.index;
    const ordered = index ? index.scenes.map((s) => s.name) : [];
    for (const name of ordered) {
      if (byScene.has(name)) {
        groups.push({ name, rows: byScene.get(name), current: name === this.view.currentScene });
        byScene.delete(name);
      }
    }
    for (const [name, rows] of byScene) groups.push({ name, rows });
    if (presences.length) groups.push({ name: 'presences', rows: presences });
    for (const group of groups) group.rows.sort((a, b) => a[0].localeCompare(b[0]));
    return groups;
  }

  renderList() {
    this.lastRender = performance.now();
    this.dirty = false;
    this.listEl.innerHTML = '';
    this.rows = new Map();
    this.countEl.textContent = `${this.store.entities.size}`;
    const q = this.search.trim().toLowerCase();
    const matches = ([id, comps]) =>
      !q || id.toLowerCase().includes(q) || Object.keys(comps).some((k) => k.toLowerCase().startsWith(q));

    for (const group of this.groupsOf()) {
      const rows = group.rows.filter(matches);
      if (!rows.length) continue;
      const collapsed = this.collapsed.has(group.name) && !q;
      const head = div('o-group');
      head.textContent = `${collapsed ? '▸' : '▾'} ${group.name}${group.current ? ' ·' : ''} `;
      head.append(span('o-n', `(${rows.length})`));
      head.onclick = () => {
        if (this.collapsed.has(group.name)) this.collapsed.delete(group.name);
        else this.collapsed.add(group.name);
        this.renderList();
      };
      // scenes are themselves editable: bounds, load volumes,
      // neighbors — the streaming geography, inspected like an entity
      if (this.onScene && this.scenes?.rawScene?.(group.name)) {
        const gear = span('o-scene-edit', '⛭');
        gear.title = 'edit scene streaming (bounds, load volumes)';
        gear.onclick = (e) => {
          e.stopPropagation();
          this.onScene(group.name);
        };
        head.append(gear);
      }
      this.listEl.append(head);
      if (collapsed) continue;

      for (const [id, comps] of rows) {
        const row = div('o-row');
        row.append(span('o-icon', iconFor(comps)));
        row.append(span('o-id', id === this.view.ownPresence ? `${id} (you)` : id));
        if (!this.view.isActive(comps)) row.classList.add('dim');
        if (id === this.selected) row.classList.add('selected');
        row.onclick = () => this.onPick?.(id);
        row.ondblclick = () => this.onFocus?.(id);
        this.rows.set(id, row);
        this.listEl.append(row);
      }
    }
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
