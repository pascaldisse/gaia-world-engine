// extensions.js — WHAT THE ENGINE LOADS IS A PARAMETER, NOT AN IMPORT.
//
// LAW (Pascal, 2026-07-30): "the game is not a plugin." The engine may offer a
// plugin MECHANISM, but a production does not live inside the studio. Before
// this file, main.js imported `AtlasStrategy` by name, constructed it, synced it,
// updated it and published it — the engine could not boot without the Paleblood
// Atlas being present in its own source tree.
//
// §IRON: a varying value is a parameter WITH A DEFAULT. The default here is the
// engine's own historical wiring, so a boot that passes nothing behaves exactly
// as it did before this file existed. Nothing about the live app changes until
// someone deliberately passes a different list.
//
// Parameter, first one that answers wins:
//   window.__GAIA_EXTENSIONS__ = [mod | register | '/url.js', …]   host page decides
//   ?ext=/game/atlas-strategy.js,/game/other.js                   URL, for probes
//   DEFAULT_EXTENSIONS                                            this engine's own
//
// An entry may be a URL STRING, a register FUNCTION, or an ALREADY-IMPORTED
// MODULE. That is not convenience — it is the difference between a dev server and
// a production bundle: a URL like '/game/atlas-strategy.js' exists only while a
// dev server is serving files by path, and 404s inside a built artifact where the
// same code lives in /assets/index-<hash>.js (measured 2026-07-30: static build
// booted with no strategy, no cosmos and an empty museum). A host page that wants
// its extensions BUNDLED must `import` them itself and pass the module.
//
// CONTRACT — an extension module exports `register(ctx)` (or a default export of
// the same shape) and may return a descriptor:
//   { name, api, sync(), update(dt) }
// `name`+`api` get published on `window.gaia` under that name (so existing
// consumers like atlas-intro's `window.gaia.atlasStrategy` keep working), and
// sync/update are called by the engine's own loops. Returning nothing is legal:
// an extension may be pure side effect.
//
// A failing extension must NOT take the engine down: the studio still opens when
// a production is broken or absent. Failures are warned and skipped.

// THE ENGINE SHIPS NO PRODUCTION (Pascal, 2026-07-31: "it should never even be
// part of the engine to begin with"). The game lived here as 29 files under
// client/plugins/ — a copy that drifted 1-2 days behind its real home in
// ~/projects/paloptic/client/game and served an outdated film on :5174.
// A host page names its own production:
//     window.__GAIA_EXTENSIONS__ = ['/game/atlas-strategy.js']
//     window.__GAIA_GATE__       = '/game/atlas-gate.js'
// Defaults are EMPTY so the studio opens with no production at all.
export const DEFAULT_EXTENSIONS = [];
export const DEFAULT_GATE = null;

// Relative defaults resolve against THIS module (client/kernel/), while a host
// page passes origin-absolute paths ('/game/…'); `new URL` handles both, and an
// absolute path ignores the base exactly as intended.
const resolve = (u) => new URL(u, import.meta.url).href;

function fromQuery(key) {
  try {
    const v = new URLSearchParams(location.search).get(key);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
  } catch { return null; }
}

export function extensionList() {
  const w = typeof window !== 'undefined' ? window.__GAIA_EXTENSIONS__ : null;
  const list = (Array.isArray(w) && w.length ? w : null) ?? fromQuery('ext') ?? DEFAULT_EXTENSIONS;
  // only strings are URLs to resolve; modules and functions pass through as-is
  return list.map((e) => (typeof e === 'string' ? resolve(e) : e));
}

export function gateModule() {
  const w = typeof window !== 'undefined' ? window.__GAIA_GATE__ : null;
  if (w === false || w === null) return null;          // an explicit "no gate"
  if (w && typeof w !== 'string') return w;            // already imported by the host
  const q = fromQuery('gate');
  const pick = w || (q && q[0]) || DEFAULT_GATE;
  return pick ? resolve(pick) : null;    // no default gate -> no gate, not a 404
}

export async function loadExtensions(ctx) {
  const loaded = [];
  for (const entry of extensionList()) {
    const url = typeof entry === 'string' ? entry : (entry?.url ?? entry?.name ?? '[module]');
    try {
      const mod = typeof entry === 'string' ? await import(/* @vite-ignore */ entry) : entry;
      const register = typeof mod === 'function' ? mod : (mod.register ?? mod.default);
      if (typeof register !== 'function') {
        console.warn('[gaia] extension has no register(ctx) export — skipped:', url);
        continue;
      }
      const d = (await register(ctx)) ?? {};
      loaded.push({ url, name: d.name ?? null, api: d.api ?? null, sync: d.sync ?? null, update: d.update ?? null });
    } catch (err) {
      console.warn('[gaia] extension failed to load — booting without it:', url, err);
    }
  }
  return {
    loaded,
    published: Object.fromEntries(loaded.filter((e) => e.name && e.api).map((e) => [e.name, e.api])),
    sync() { for (const e of loaded) { try { e.sync?.(); } catch (err) { console.warn('[gaia] extension sync failed:', e.url, err); } } },
    update(dt) { for (const e of loaded) { try { e.update?.(dt); } catch (err) { console.warn('[gaia] extension update failed:', e.url, err); } } },
  };
}
