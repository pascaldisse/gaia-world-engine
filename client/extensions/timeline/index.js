// GAIA Timeline P1 — read-only witness. Toggle: F8 or the ⏱ button.
export function register(ctx) {
  const witness = new TimelineWitness(ctx);
  return { name: 'timeline', api: witness, update: () => witness.update() };
}

class TimelineWitness {
  constructor(ctx) {
    this.ctx = ctx;
    this.events = [];
    this.segmentEvents = [];
    this.zoom = 9;
    this.offset = 0;
    this.open = false;
    this.drag = null;
    this.lastT = 0;
    this.hookedFilm = null;
    this.eventIds = new Set();
    this.mount();
    this.unlisten = ctx.store?.onChange?.((e) => this.recordWorld(e));
    // A snapshot has no per-entity event IDs; witnessing its members is the only
    // existing read-only representation of entities already present at boot.
    for (const id of ctx.store?.entities?.keys?.() ?? []) this.record('appeared', id, this.time());
  }

  mount() {
    const style = document.createElement('style');
    style.textContent = `
#gaia-timeline-toggle{position:fixed;right:14px;bottom:14px;z-index:31;border:1px solid #58657b;border-radius:4px;background:#182131;color:#dce7f5;padding:6px 9px;font:12px system-ui;cursor:pointer}
#gaia-timeline{position:fixed;left:14px;right:14px;bottom:48px;height:286px;z-index:30;display:none;flex-direction:column;background:#101827eF;border:1px solid #3d4d66;border-radius:6px;box-shadow:0 12px 32px #0009;color:#dce7f5;font:12px system-ui;overflow:hidden;backdrop-filter:blur(8px)}
#gaia-timeline.open{display:flex}.gt-head{height:32px;display:flex;align-items:center;gap:9px;padding:0 10px;border-bottom:1px solid #34425a}.gt-head button{background:#202d40;border:1px solid #4e607c;border-radius:3px;color:inherit;cursor:pointer}.gt-track{overflow:auto;flex:1;position:relative}.gt-ruler{height:28px;position:sticky;top:0;z-index:4;background:#151f2f;border-bottom:1px solid #34425a;min-width:100%}.gt-tick{position:absolute;top:0;height:100%;border-left:1px solid #52617a;color:#aabbd2;padding:4px}.gt-lane{height:38px;min-width:100%;position:relative;border-bottom:1px solid #26334a;background:linear-gradient(90deg,#131d2c,#111a27)}.gt-label{position:sticky;left:0;z-index:3;display:inline-flex;align-items:center;width:150px;height:38px;padding-left:10px;background:#182335;border-right:1px solid #3d4c66;cursor:pointer}.gt-clip,.gt-marker{position:absolute;cursor:pointer;box-sizing:border-box}.gt-clip{top:8px;height:22px;border:1px solid #7d9fd0;border-radius:3px;background:#315682bb;overflow:hidden;white-space:nowrap;padding:3px 5px}.gt-marker{top:3px;width:2px;height:32px;background:#ffd166}.gt-marker::after{content:'';position:absolute;top:0;left:-3px;border-left:4px solid transparent;border-right:4px solid transparent;border-top:6px solid #ffd166}.gt-playhead{position:absolute;top:0;bottom:0;width:2px;background:#ff5b70;z-index:8;pointer-events:none}.gt-empty{padding:12px;color:#9baeca}`;
    document.head.append(style);
    this.button = document.createElement('button'); this.button.id = 'gaia-timeline-toggle'; this.button.textContent = '⏱ Timeline (F8)';
    this.button.dataset.filmAllow = ''; this.button.onclick = () => this.toggle(); document.body.append(this.button);
    this.el = document.createElement('section'); this.el.id = 'gaia-timeline'; this.el.dataset.filmAllow = '';
    this.el.innerHTML = `<div class="gt-head"><b>Timeline · P1 witness</b><button data-z="-">−</button><span class="gt-zoom"></span><button data-z="+">+</button><span class="gt-status"></span></div><div class="gt-track"><div class="gt-ruler"></div><div class="gt-lanes"></div><div class="gt-playhead"></div></div>`;
    document.body.append(this.el); this.track = this.el.querySelector('.gt-track'); this.ruler = this.el.querySelector('.gt-ruler'); this.lanes = this.el.querySelector('.gt-lanes'); this.playhead = this.el.querySelector('.gt-playhead');
    this.el.querySelectorAll('[data-z]').forEach((b) => b.onclick = () => { this.zoom = Math.max(2, Math.min(80, this.zoom * (b.dataset.z === '+' ? 1.45 : .69))); this.render(); });
    this.track.addEventListener('pointerdown', (e) => { if (e.target.closest('.gt-label,.gt-clip,.gt-marker')) return; this.drag = true; this.scrubPointer(e); this.track.setPointerCapture(e.pointerId); });
    this.track.addEventListener('pointermove', (e) => { if (this.drag) this.scrubPointer(e); });
    this.track.addEventListener('pointerup', () => { this.drag = false; });
    document.addEventListener('keydown', (e) => { if (e.code === 'F8' && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) { e.preventDefault(); this.toggle(); } });
  }

  time() { const d = window.gaia?.director; const t = d?.status?.().t; return Number.isFinite(t) ? t : performance.now() / 1000; }
  duration() { const d = window.gaia?.director; return Number(d?.duration ?? Math.max(30, ...this.events.map((e) => e.t + 2), 30)); }
  recordWorld(e) { if (e.kind === 'spawn') this.record('appeared', e.id, this.time()); if (e.kind === 'despawn') this.record('removed', e.id, this.time()); if (e.kind === 'snapshot') for (const id of this.ctx.store?.entities?.keys?.() ?? []) this.record('appeared', id, this.time()); }
  record(kind, id, t) { const key = `${kind}:${id}:${t.toFixed(3)}`; if (!this.eventIds.has(key)) { this.eventIds.add(key); this.events.push({ kind, id, t }); } }
  hookFilm() { const film = window.gaia?.director?.director?.film2; if (!film || film === this.hookedFilm || typeof film.frame !== 'function') return; const original = film.frame.bind(film); const self = this; film.frame = function timelineWitnessFrame(t, opts) { const rec = this.segAt?.(t); if (rec && self.segmentEvents.at(-1)?.id !== rec.id) self.segmentEvents.push({ id: rec.id, t, win: rec.win }); return original(t, opts); }; this.hookedFilm = film; }
  toggle() { this.open = !this.open; this.el.classList.toggle('open', this.open); if (this.open) this.render(); }
  scrubPointer(e) { const r = this.track.getBoundingClientRect(); const x = e.clientX - r.left + this.track.scrollLeft - 150; const t = Math.max(0, Math.min(this.duration(), (x - this.offset) / this.zoom)); const d = window.gaia?.director; if (d?.scrub) d.scrub(t, { resume: false }); this.lastT = t; this.renderPlayhead(t); }
  x(t) { return 150 + this.offset + t * this.zoom; }
  select(value, entityId = null) {
    // P1 must not persist film/editor data. The existing generic Panel renders
    // this transient component through its normal entity document path.
    const id = entityId ?? this.ctx.store?.entities?.keys?.().next?.().value;
    const store = this.ctx.store, editor = window.gaia?.editor, panel = window.gaia?.panel;
    if (!id || !store?.get || !panel) return;
    const doc = store.get(id); if (!doc) return;
    doc.timeline = value; // transient client witness data — never net.send/sendDev.
    if (editor?.select) editor.select(id); else panel.show(id);
  }
  lane(label, clips = [], markers = [], entityId = null) {
    const row = document.createElement('div'); row.className = 'gt-lane';
    const lab = document.createElement('span'); lab.className = 'gt-label'; lab.textContent = label; lab.onclick = () => this.select({ kind: 'lane', label, clips, markers }, entityId); row.append(lab);
    for (const c of clips) { const el = document.createElement('div'); el.className = 'gt-clip'; el.style.left = `${this.x(c.t0)}px`; el.style.width = `${Math.max(8, (c.t1 - c.t0) * this.zoom)}px`; el.textContent = c.label; el.title = `${c.label} ${c.t0.toFixed(3)}–${c.t1.toFixed(3)}`; el.onclick = () => this.select({ kind: 'clip', ...c }, entityId); row.append(el); }
    for (const m of markers) { const el = document.createElement('i'); el.className = 'gt-marker'; el.style.left = `${this.x(m.t)}px`; el.title = `${m.kind ?? 'marker'}: ${m.id} @ ${m.t.toFixed(3)}`; el.onclick = () => this.select({ kind: 'marker', ...m }, m.id); row.append(el); }
    this.lanes.append(row);
  }
  renderPlayhead(t) { this.playhead.style.left = `${this.x(t)}px`; }
  render() {
    if (!this.open) return; const d = window.gaia?.director, duration = this.duration(), width = this.x(duration) + 80; this.ruler.style.width = `${width}px`; this.lanes.style.width = `${width}px`; this.ruler.replaceChildren(); this.lanes.replaceChildren();
    for (let t = 0; t <= duration; t += (this.zoom < 8 ? 30 : this.zoom < 18 ? 10 : 5)) { const tick = document.createElement('span'); tick.className = 'gt-tick'; tick.style.left = `${this.x(t)}px`; tick.textContent = `${t}s`; this.ruler.append(tick); }
    const scenes = d?.scenes ?? []; this.lane('Chapters', scenes.map((s) => ({ t0:s.t0, t1:s.t1, label:s.id, note:s.note }))); 
    const segs = this.hookedFilm?.segs ?? []; if (segs.length) this.lane('Film segments', segs.map((s) => ({ t0:s.win[0], t1:s.win[1], label:s.id })), this.segmentEvents);
    const byId = new Map(); for (const e of this.events) { const a = byId.get(e.id) ?? []; a.push(e); byId.set(e.id, a); }
    if (byId.size) for (const [id, es] of byId) this.lane(`Entity · ${id}`, [], es, id); else this.lane('Engine entities', [], []);
    if (!d) { const empty = document.createElement('div'); empty.className = 'gt-empty'; empty.textContent = 'No director — world-clock entity witness remains available.'; this.lanes.append(empty); }
    this.el.querySelector('.gt-zoom').textContent = `${this.zoom.toFixed(1)} px/s`; this.el.querySelector('.gt-status').textContent = d ? `${duration.toFixed(2)}s · ${this.events.length} entity events` : `${this.events.length} entity events`;
    this.renderPlayhead(this.time());
  }
  update() { this.hookFilm(); const t = this.time(); if (this.open && (Math.abs(t - this.lastT) > .03 || !this.lanes.childElementCount)) this.render(); this.lastT = t; }
}
