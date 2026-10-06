// Humanoid kit stage 6 — clip playback. docs/HUMANOID-KIT-SPEC.md §16.
// ONE AnimationMixer per instance on the instance root; it drives the shared instance bones, so every LOD level
// (+ per-piece meshes) skins from the same pose. AnimationClip objects are parsed ONCE per template (humanoid.js) and
// shared by every mixer. This file: the per-instance player + the per-frame tick (view.update(dt)).
import * as THREE from 'three';
import { CLIP_FADE, resolveClipName, retargetTrackName } from '../../shared/humanoid.js';

const LIVE = new Set(); // players with an active/fading action
let lastNow = null;

// gltf.animations → Map(name → AnimationClip). `.scale` tracks dropped: body params own bone scale.
export function prepareClips(animations = []) {
  const out = new Map();
  animations.forEach((clip, i) => {
    const name = clip.name || `clip${i}`;
    if (out.has(name)) return;
    clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale'));
    out.set(name, clip);
  });
  return out;
}

// clips authored on another rig → base rig by node name, else canonical bone; unmappable tracks dropped.
// returns NEW AnimationClip objects (cache the result per (clips template, base template)).
export function retargetClips(clips, rig) {
  const out = new Map();
  for (const [name, clip] of clips) {
    const tracks = [];
    for (const t of clip.tracks) {
      const to = retargetTrackName(t.name, rig);
      if (!to) continue;
      const c = to === t.name ? t : t.clone();
      c.name = to;
      tracks.push(c);
    }
    if (tracks.length) out.set(name, new THREE.AnimationClip(name, clip.duration, tracks));
  }
  return out;
}

// clips: Map(name → AnimationClip) (shared, never mutated). Mixer is created lazily on the first valid clip.
export function createClipPlayer(root, clips, { fade = CLIP_FADE, warn = (...a) => console.warn(...a) } = {}) {
  let mixer = null;
  let cur = null; // { name, action, speed, loop, finished }
  let fading = null; // { from, t, dur } — latest crossfade only
  const warned = new Set();
  const sync = () => { if (cur || fading) LIVE.add(player); else LIVE.delete(player); };
  const player = {
    names: () => [...clips.keys()],
    getClip: (name) => clips.get(resolveClipName(clips.keys(), name)) ?? null, // the SHARED AnimationClip (read-only)
    get current() { return cur?.name ?? null; },
    // name: clip name | null/'' (stop, fades out). opts { speed=1, loop=true, t0=0, fade }. Same clip as current ⇒ speed/loop
    // update in place (no restart). unknown name ⇒ console.warn once, previous clip KEPT, returns false.
    setClip(name, opts = {}) {
      const dur = Number.isFinite(opts.fade) && opts.fade >= 0 ? opts.fade : fade;
      if (name === null || name === undefined || name === '') {
        if (cur) {
          if (dur > 0) { cur.action.fadeOut(dur); fading = { from: cur.name, t: 0, dur }; } else cur.action.stop();
          cur = null;
        }
        sync();
        return true;
      }
      const resolved = resolveClipName(clips.keys(), name);
      if (!resolved) {
        if (!warned.has(name)) { warned.add(name); warn(`[humanoid] clip "${name}" not found (have: ${[...clips.keys()].join(', ') || 'none'}) — keeping ${cur ? `"${cur.name}"` : 'rest pose'}`); }
        return false;
      }
      const speed = Number.isFinite(opts.speed) ? opts.speed : 1;
      const loop = opts.loop !== false;
      const t0 = Number.isFinite(opts.t0) && opts.t0 > 0 ? opts.t0 : 0;
      const setLoop = (a) => { a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity); a.clampWhenFinished = !loop; };
      if (cur && cur.name === resolved) {
        cur.speed = speed;
        cur.action.setEffectiveTimeScale(speed);
        if (cur.loop !== loop) { cur.loop = loop; setLoop(cur.action); if (loop && cur.finished) { cur.finished = false; cur.action.reset().play(); } }
        sync();
        return true;
      }
      mixer ??= new THREE.AnimationMixer(root);
      if (!mixer._humanoidFin) { mixer._humanoidFin = true; mixer.addEventListener('finished', (e) => { if (cur && e.action === cur.action) cur.finished = true; }); }
      const action = mixer.clipAction(clips.get(resolved));
      action.reset();
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(speed);
      setLoop(action);
      action.time = t0;
      action.play();
      const prev = cur;
      if (prev && prev.action !== action) {
        if (dur > 0) { action.crossFadeFrom(prev.action, dur, false); fading = { from: prev.name, t: 0, dur }; } else prev.action.stop();
      }
      cur = { name: resolved, action, speed, loop, finished: false };
      sync();
      return true;
    },
    update(dt) {
      if (!mixer) return;
      mixer.update(dt);
      if (fading && (fading.t += dt) >= fading.dur) fading = null;
      if (!fading && (!cur || cur.finished)) LIVE.delete(player);
    },
    // plain-data snapshot (tests / overlays)
    state() {
      return {
        name: cur?.name ?? null, speed: cur?.speed ?? null, loop: cur?.loop ?? null, time: cur?.action.time ?? 0, finished: !!cur?.finished,
        fading: !!fading, from: fading?.from ?? null, fadeT: fading?.t ?? 0, fadeDur: fading?.dur ?? 0,
        weight: cur?.action.getEffectiveWeight() ?? 0,
      };
    },
    dispose() {
      LIVE.delete(player);
      if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(root); }
      mixer = null; cur = null; fading = null;
    },
  };
  return player;
}

// per-frame (view.update(dt)). dt omitted ⇒ own clock, clamped.
export function tickHumanoidClips(dt) {
  if (!LIVE.size) { lastNow = null; return; }
  if (!(dt >= 0)) {
    const now = performance.now();
    dt = lastNow === null ? 0 : Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
  }
  for (const p of LIVE) p.update(dt);
}
export const humanoidClipStats = () => ({ live: LIVE.size });
