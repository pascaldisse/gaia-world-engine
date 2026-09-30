// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §13 fade lifecycle: Living -> Fading -> Faded, per fragment.
import { createRng, mixSeed } from './prng.js';

export const FadeType = Object.freeze({ NONE: 'none', DESTROY: 'destroy', SCALE_DOWN: 'scaleDown' });
export const FADE_DEFAULTS = Object.freeze({ fadeType: FadeType.SCALE_DOWN, fadeTime: 5, lifeTime: 7, lifeVariation: 3 });
const SALT_FADE = 0xfade0001;

// The lifetime jitter roll is fixed at creation (deterministic per seed), applied once opts are known.
export function createFadeState(seed) {
  return { age: 0, phase: 'living', scale: 1, removed: false, roll: createRng(mixSeed(seed, SALT_FADE))() };
}

export function tickFade(state, dt, opts = {}) {
  const o = { ...FADE_DEFAULTS, ...opts };
  if (o.fadeType === FadeType.NONE || state.removed) return state;
  state.age += Math.max(0, dt);
  const life = Math.max(0, o.lifeTime + (2 * state.roll - 1) * o.lifeVariation);
  const t = state.age - life;
  if (o.fadeType === FadeType.DESTROY) {
    if (t >= 0 && state.age > 0) { state.removed = true; state.phase = 'faded'; state.scale = 0; }
    return state;
  }
  // SCALE_DOWN: linear 1 - clamp(t/fadeTime) after the lifetime, then removed
  if (t <= 0) { state.phase = 'living'; state.scale = 1; return state; }
  const k = o.fadeTime > 0 ? Math.min(1, t / o.fadeTime) : 1;
  state.scale = 1 - k;
  if (k >= 1) { state.phase = 'faded'; state.removed = true; state.scale = 0; } else state.phase = 'fading';
  return state;
}
