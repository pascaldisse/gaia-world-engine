// native-transport.js — serial IPC pipe JS -> native host.
// ORDER is load-bearing (handles are JS-allocated; a create must land before its users): exactly ONE message in flight,
// the rest queue and COALESCE into the next message (so a slow host batches frames instead of stacking round trips).
// Every message is a raw byte slice of the command stream (any split point; the host buffers partial commands).
const dec = new TextDecoder();

function parseReport(r) {
  const bytes = r instanceof ArrayBuffer ? new Uint8Array(r) : r?.buffer ? new Uint8Array(r.buffer, r.byteOffset, r.byteLength) : null;
  if (!bytes || bytes.length === 0) return {};
  return JSON.parse(dec.decode(bytes));
}

/** Tauri 2 raw-body command (default): invoke(cmd, Uint8Array) -> Tauri posts it as application/octet-stream over the ipc:// custom protocol -> `InvokeBody::Raw`. */
export function tauriInvokeSend({ command = 'gaia_render_apply', invoke } = {}) {
  const inv = invoke ?? globalThis.__TAURI_INTERNALS__?.invoke ?? globalThis.__TAURI__?.core?.invoke;
  if (!inv) throw new Error('GaiaRenderNative: no Tauri IPC (window.__TAURI_INTERNALS__.invoke missing) — run inside the native app');
  return async (bytes) => parseReport(await inv(command, bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
}

/** Alternative: POST to a host-registered custom URI scheme (nt-host: register_asynchronous_uri_scheme_protocol). Same wire bytes. */
export function customProtocolSend({ scheme = 'gaiarender', path = 'apply', url } = {}) {
  const u = url ?? globalThis.__TAURI_INTERNALS__?.convertFileSrc?.(path, scheme) ?? `${scheme}://localhost/${path}`;
  return async (bytes) => {
    const res = await fetch(u, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(`gaia render protocol ${res.status}`);
    return parseReport(await res.arrayBuffer());
  };
}

export function createTransport({ send, maxChunkBytes = 16 << 20, onReport, onError }) {
  const queue = [];                 // Uint8Array pieces, stream order
  let queued = 0, inflight = null;
  const waiters = [];
  const st = { messages: 0, bytes: 0, maxQueued: 0, lastMs: 0, maxMs: 0 };
  const pump = () => {
    if (inflight) return;
    if (!queue.length) { for (const w of waiters.splice(0)) w(); return; }
    // coalesce queued pieces up to maxChunk; split a piece that alone exceeds it (multiple of 4 keeps arrays 4-aligned)
    const cap = maxChunkBytes & ~3;
    let msg;
    if (queue[0].byteLength > cap) {
      msg = queue[0].subarray(0, cap);
      queue[0] = queue[0].subarray(cap);
    } else {
      let n = 0, take = 0;
      while (take < queue.length && n + queue[take].byteLength <= cap) n += queue[take++].byteLength;
      if (take === 1) msg = queue.shift();
      else {
        msg = new Uint8Array(n);
        let o = 0;
        for (const p of queue.splice(0, take)) { msg.set(p, o); o += p.byteLength; }
      }
    }
    queued -= msg.byteLength;
    const t0 = performance.now();
    st.messages++; st.bytes += msg.byteLength;
    inflight = send(msg).then((r) => { try { onReport(r); } catch (e) { onError(e); } }, onError).finally(() => {
      st.lastMs = performance.now() - t0; st.maxMs = Math.max(st.maxMs, st.lastMs);
      inflight = null;
      pump();
    });
  };
  return {
    stats: st,
    get queuedBytes() { return queued; },
    push(chunk) { queue.push(chunk); queued += chunk.byteLength; st.maxQueued = Math.max(st.maxQueued, queued); pump(); },
    /** resolves when everything pushed so far has been applied by the host. */
    idle() { return new Promise((res) => { if (!inflight && !queue.length) res(); else waiters.push(res); }); },
  };
}
