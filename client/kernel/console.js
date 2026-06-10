// The event console: the op stream made visible — watch triggers fire,
// weather strike, agents edit, your own ops land. L toggles it. Presence
// pose spam is hidden unless asked for; everything else streams live.

const MAX_LINES = 200;

export class EventConsole {
  constructor({ el }) {
    this.el = el;
    this.visible = false;
    this.eventsOnly = false;
    this.showPresence = false;
    this.filter = '';
    this.paused = false;
    this.buildChrome();
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyL' || e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return;
      this.toggle();
    });
  }

  buildChrome() {
    this.el.innerHTML = '';
    const head = div('c-head');
    head.append(span('c-title', 'world log'));
    this.filterEl = document.createElement('input');
    this.filterEl.type = 'text';
    this.filterEl.placeholder = 'filter…';
    this.filterEl.addEventListener('input', () => (this.filter = this.filterEl.value.trim().toLowerCase()));
    head.append(this.filterEl);
    head.append(this.checkbox('events', (on) => (this.eventsOnly = on)));
    head.append(this.checkbox('presence', (on) => (this.showPresence = on)));
    head.append(button('×', () => this.toggle()));
    this.el.append(head);
    this.listEl = div('c-list');
    // pin-to-bottom unless the reader scrolled up to study something
    this.listEl.addEventListener('scroll', () => {
      this.paused = this.listEl.scrollTop + this.listEl.clientHeight < this.listEl.scrollHeight - 8;
    });
    this.el.append(this.listEl);
  }

  checkbox(label, onChange) {
    const wrap = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.onchange = () => onChange(box.checked);
    wrap.append(box, label);
    return wrap;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'flex' : 'none';
    document.body.classList.toggle('console-open', this.visible);
  }

  add(ops, from) {
    if (!this.visible) return;
    for (const op of ops) {
      const isPresence = typeof op.id === 'string' && op.id.startsWith('player-') && (op.component === 'transform' || op.component === 'presence');
      if (isPresence && !this.showPresence) continue;
      if (this.eventsOnly && op.op !== 'event') continue;
      const line = this.format(op, from);
      if (this.filter && !line.text.toLowerCase().includes(this.filter)) continue;
      this.append(line);
    }
  }

  format(op, from) {
    const at = new Date().toTimeString().slice(0, 8);
    const by = from ? ` ← ${from}` : '';
    if (op.op === 'event') {
      const data = op.data ? ` ${short(op.data)}` : '';
      return { cls: 'c-event', text: `${at} ⚡ ${op.name}${data}${by}` };
    }
    if (op.op === 'spawn') return { cls: 'c-spawn', text: `${at} + ${op.id}${by}` };
    if (op.op === 'despawn') return { cls: 'c-despawn', text: `${at} − ${op.id}${by}` };
    if (op.op === 'set' || op.op === 'merge') {
      const value = op.value === null ? ' ∅' : ` ${short(op.value)}`;
      return { cls: 'c-set', text: `${at} ${op.id}.${op.component}${op.op === 'merge' ? ' ⨤' : ' ='}${value}${by}` };
    }
    return { cls: 'c-set', text: `${at} ${op.op} ${op.id ?? ''}${by}` };
  }

  append({ cls, text }) {
    const row = div(`c-line ${cls}`, text);
    this.listEl.append(row);
    while (this.listEl.children.length > MAX_LINES) this.listEl.firstChild.remove();
    if (!this.paused) this.listEl.scrollTop = this.listEl.scrollHeight;
  }
}

// one line of JSON, truncated — the log is a pulse, not a document
function short(value) {
  let s = JSON.stringify(value);
  if (s && s.length > 90) s = `${s.slice(0, 87)}…`;
  return s;
}

function div(cls, text) {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
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
