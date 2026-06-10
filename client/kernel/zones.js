import { normalizeManifest, zoneAt, activeZones } from '../../shared/zones.js';

// Client-side streaming policy: track which zone the player is in, keep that
// zone + its neighbors + the always-zones (backdrops) resident. Streaming is
// invisible — neighbors are built before they can be seen or entered, and
// builds are time-sliced in the view.
export class Zones {
  constructor({ store, view, environment }) {
    this.store = store;
    this.view = view;
    this.environment = environment;
    this.manifest = null;
    this.current = null;
  }

  setManifest(raw) {
    this.manifest = normalizeManifest(raw);
    this.current = null;
    if (!this.manifest) {
      this.view.currentZone = null;
      this.view.setActiveZones(null);
    }
  }

  update(position) {
    if (!this.manifest) return;
    const zone =
      zoneAt(this.manifest, position.x, position.z) ??
      this.current ??
      this.manifest.zones.find((z) => z.bounds)?.name ??
      null;
    if (zone === this.current) return;
    const first = this.current === null;
    this.current = zone;
    this.view.currentZone = zone;
    this.view.setActiveZones(activeZones(this.manifest, zone));
    this.applyEnvironment(first);
    this.view.updateAmbience();
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
