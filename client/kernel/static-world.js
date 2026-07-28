// static-world.js — STATIC BOOT MODE: the Atlas as a snapshot, no server.
//
// Drop-in replacement for kernel/net.js's `connect()` — same call shape
// ({url, presence, onSnapshot, onOps, onStatus, onScreenshot}), same return
// shape ({send, sendDev, sendRaw}) — so main.js only ever picks WHICH one to
// call, never rewrites the callback bodies. `url`/`presence`/`onScreenshot`
// are accepted and ignored: there is no socket, and no client renders a
// remote screenshot request because there is no server to relay one.
//
// Hydration: one fetch of /assets/world-snapshot.json (baked ahead of time —
// see tools/ or docs/atlas-static.md for how it's produced), shaped exactly
// like the server's ws `snapshot` message minus the envelope:
//   { time, entities, world, game, materials }
//
// Authoring ops (spawn/set/merge/despawn from the panel, palette, editor,
// debug knobs, ensurePresence, …) have nowhere to round-trip to — there is
// no world server — so `send`/`sendDev` loop the ops straight back through
// `onOps` exactly like a server broadcast would, except nothing persists and
// nothing else sees them. That keeps every caller (main.js, panel.js,
// editor.js, …) working unmodified: they already expect an eventual `onOps`
// echo, not a synchronous local mutation.
export function connectStatic({ onSnapshot, onOps, onStatus }) {
  onStatus?.('loading');
  fetch('/assets/world-snapshot.json')
    .then((res) => {
      if (!res.ok) throw new Error(`world-snapshot.json ${res.status}`);
      return res.json();
    })
    .then((snap) => {
      onStatus?.('static');
      onSnapshot?.(snap.entities ?? {}, snap.time ?? 0, snap.world ?? null, snap.game ?? null, snap.materials ?? null);
    })
    .catch((err) => {
      console.error('[gaia] static snapshot load failed', err);
      onStatus?.('error');
    });

  const send = (ops) => {
    if (!ops?.length) return;
    onOps?.(ops, 'static');
  };

  return {
    send,
    sendDev: send,
    // no socket to raw-send a screenshot reply over — static deploys don't
    // serve /screenshot requests because nothing issues them (no server)
    sendRaw: () => {},
  };
}

// true when the URL opts into static mode by hand (?static=1) — the build-
// time flag (__GAIA_STATIC__, set by `vite build` with GAIA_STATIC_BUILD=1)
// is the other half of the "URL has ?static=1 OR a build flag" switch and is
// read directly at the main.js call site since it's a define, not a runtime import.
export function staticModeRequested() {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('static');
}
