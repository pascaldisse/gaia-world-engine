import { normalizeManifest, zoneAt, activeZones } from '../../shared/zones.js';

// Client-side streaming policy: track which zone the player is in, keep that
// zone + its neighbors + the always-zones (backdrops) resident — and zones
// with explicit `load` volumes only while the player stands inside one.
// Streaming is invisible — zones are built before they can be seen or
// entered, and builds are time-sliced in the view.
export class Zones {
  constructor({ store, view, environment }) {
    this.store = store;
    this.view = view;
    this.environment = environment;
    this.raw = null; // the manifest as authored — what the editor edits
    this.manifest = null;
    this.current = null;
    this.currentVoidY = -120;
    this.activeSet = null;
    this.activeKey = null;
  }

  setManifest(raw) {
    this.raw = raw;
    this.manifest = normalizeManifest(raw);
    this.current = null;
    this.activeSet = null;
    this.activeKey = null;
    if (!this.manifest) {
      this.view.currentZone = null;
      this.view.setActiveZones(null);
    }
  }

  // the `zone` op: streaming geography edited live (bounds, load volumes,
  // neighbors…) — merge into the raw manifest and re-derive everything
  applyZoneOp(op) {
    const zone = this.raw?.zones?.find((z) => z.name === op.name);
    if (!zone) return;
    for (const [key, value] of Object.entries(op.value ?? {})) {
      if (value === null) delete zone[key];
      else zone[key] = value;
    }
    this.manifest = normalizeManifest(this.raw);
    this.activeKey = null; // force a streaming re-evaluation next update
  }

  rawZone(name) {
    return this.raw?.zones?.find((z) => z.name === name) ?? null;
  }

  update(position) {
    if (!this.manifest) return;
    const zone =
      zoneAt(this.manifest, position.x, position.z) ??
      this.current ??
      this.manifest.zones.find((z) => z.bounds)?.name ??
      null;
    const changed = zone !== this.current;
    const first = this.current === null;
    if (changed) {
      this.currentVoidY = this.manifest.zones.find((z) => z.name === zone)?.voidY ?? this.manifest.voidY;
      this.current = zone;
      this.view.currentZone = zone;
    }
    // the active set can change WITHOUT a zone change — load volumes gate on
    // the player's position (crossing a height, entering an approach)
    const active = activeZones(this.manifest, zone, [position.x, position.y, position.z], this.activeSet);
    const key = [...active].sort().join('|');
    if (key !== this.activeKey) {
      this.activeKey = key;
      this.activeSet = active;
      this.view.setActiveZones(active);
    }
    if (changed) {
      this.applyEnvironment(first);
      this.view.updateAmbience();
    }
  }

  // crossing into a zone adopts its mood — crossfaded, so a seam is a slow
  // change of air, never a cut; a zone without an environment keeps the old
  applyEnvironment(snap = false) {
    for (const comps of this.store.entities.values()) {
      if (comps.environment && comps.zone?.name === this.current) {
        if (snap) this.environment.apply(comps.environment);
        else this.environment.applyFaded(comps.environment, 3);
        return;
      }
    }
  }
}
