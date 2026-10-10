// native-transport.js — serial IPC pipe JS -> native host.
// ORDER is load-bearing (handles are JS-allocated; a create must land before its users). The send fn must deliver messages to the host
// IN ORDER and resolve its reports IN ORDER: Tauri invoke / custom protocol = no such guarantee -> exactly ONE in flight; the WebSocket
// (one ordered connection, reports come back in request order) allows N in flight (?nativeInflight). Queued pieces COALESCE into the
// next message (so a slow host batches frames instead of stacking round trips).
// Every message is a raw byte slice of the command stream (any split point; the host buffers partial commands).
const dec = new TextDecoder();
function parseReport(r) {
  if (typeof r === 'string') return r ? JSON.parse(r) : {};
  const bytes = r instanceof ArrayBuffer ? new Uint8Array(r) : r?.buffer ? new Uint8Array(r.buffer, r.byteOffset, r.byteLength) : null;
  if (!bytes || bytes.length === 0) return {};
  return JSON.parse(dec.decode(bytes));
}
/** Tauri 2 raw-body command: invoke(cmd, Uint8Array) -> posted as application/octet-stream over the ipc:// custom protocol -> `InvokeBody::Raw`.
 *  MEASURED ~16 MB/s in WKWebView (the body transfer to wry's custom scheme dominates). Kept selectable (?nativeTransport=invoke). maxInflight = 1. */
export function tauriInvokeSend({ command = 'gaia_render_apply', invoke } = {}) {
  const inv = invoke ?? globalThis.__TAURI_INTERNALS__?.invoke ?? globalThis.__TAURI__?.core?.invoke;
  if (!inv) throw new Error('GaiaRenderNative: no Tauri IPC (window.__TAURI_INTERNALS__.invoke missing) — run inside the native app');
  const send = async (bytes) => parseReport(await inv(command, bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
  send.maxInflight = 1;
  return send;
}
/** Alternative: POST to a host-registered custom URI scheme (nt-host: register_asynchronous_uri_scheme_protocol). Same wire bytes. maxInflight = 1. */
export function customProtocolSend({ scheme = 'gaiarender', path = 'apply', url } = {}) {
  const u = url ?? globalThis.__TAURI_INTERNALS__?.convertFileSrc?.(path, scheme) ?? `${scheme}://localhost/${path}`;
  const send = async (bytes) => {
    const res = await fetch(u, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!res.ok) throw new Error(`gaia render protocol ${res.status}`);
    return parseReport(await res.arrayBuffer());
  };
  send.maxInflight = 1;
  return send;
}
/**
 * Localhost WebSocket to the host's ipc_ws server (client-rs/packages/game-window/src/ipc_ws.rs). ONE persistent connection, binary frames,
 * ordered both ways -> reports resolve in request order, N messages may be in flight. No CORS preflight for WebSocket (page origin
 * http://127.0.0.1:<vite> != ws port); the host checks the per-launch token (?t=) and the Origin header.
 * Rejects loudly if the host did not inject `__GAIA_NATIVE__.ws` (host run with --ipc-ws 0, or page origin != game origin) — no silent fallback.
 * Any socket error/close rejects every pending send and every later one (no reconnect: the host-side command stream state would be torn).
 * @param ws { port, token } (default window.__GAIA_NATIVE__.ws)  @param inflight messages in flight (default 2)
 */
export async function wsSend({ ws = globalThis.__GAIA_NATIVE__?.ws, host = '127.0.0.1', path = 'gaia', inflight = 2, openTimeoutMs = 5000, WebSocketCtor = globalThis.WebSocket } = {}) {
  if (!ws?.port || !ws?.token) throw new Error('GaiaRenderNative: ws transport unavailable (window.__GAIA_NATIVE__.ws missing: host started with --ipc-ws 0, or page origin != game origin) — use ?nativeTransport=invoke');
  const sock = new WebSocketCtor(`ws://${host}:${ws.port}/${path}?t=${encodeURIComponent(ws.token)}`);
  sock.binaryType = 'arraybuffer';
  const pending = [];                 // FIFO of { resolve, reject }: report N answers request N
  let dead = null;
  const fail = (err) => { dead ??= err; for (const p of pending.splice(0)) p.reject(dead); };
  sock.onmessage = (ev) => {
    const p = pending.shift();
    if (!p) { fail(new Error('GaiaRenderNative ws: unsolicited report from host')); return; }
    try { p.resolve(parseReport(ev.data)); } catch (e) { p.reject(e); }
  };
  sock.onerror = () => fail(new Error('GaiaRenderNative ws: socket error'));
  sock.onclose = (ev) => fail(new Error(`GaiaRenderNative ws: closed (code ${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GaiaRenderNative ws: no connection to ${host}:${ws.port} in ${openTimeoutMs} ms (wrong token/origin => the host logs "handshake refused")`)), openTimeoutMs);
    sock.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    sock.addEventListener('close', () => { clearTimeout(timer); reject(dead ?? new Error('GaiaRenderNative ws: closed before open')); }, { once: true });
  });
  const send = (bytes) => new Promise((resolve, reject) => {
    if (dead) { reject(dead); return; }
    pending.push({ resolve, reject });
    try { sock.send(bytes); } catch (e) { fail(e); }
  });
  send.maxInflight = Math.max(1, inflight | 0);
  send.socket = sock;
  return send;
}
/** idleCoalesce (page-memory.js): idle() callers share one promise. coalesceBelowBytes (page-memory.js coalesceKB): pieces at or above it are never copied into a coalesced message; onAck(ackedBytes) runs after every acked message (release hooks). */
export function createTransport({ send, maxChunkBytes = 16 << 20, maxInflight = send.maxInflight ?? 1, coalesceBelowBytes = 1 << 20, idleCoalesce = false, onReport, onError, onAck }) {
  const queue = [];                 // Uint8Array pieces, stream order
  let queued = 0;
  const flight = [];                // messages sent, report not back yet (oldest first)
  const waiters = [];
let idleP = null;                     // nt-frameleak: shared idle() promise (idleCoalesce)
  const st = { messages: 0, bytes: 0, ackedBytes: 0, maxQueued: 0, lastMs: 0, maxMs: 0, lastMBps: 0, maxInflight };
  const pump = () => {
    while (flight.length < maxInflight && queue.length) {
      // coalesce queued pieces up to maxChunk; split a piece that alone exceeds it (multiple of 4 keeps arrays 4-aligned)
      const cap = maxChunkBytes & ~3;
      let msg;
      if (queue[0].byteLength > cap) {
        msg = queue[0].subarray(0, cap);
        queue[0] = queue[0].subarray(cap);
      } else {
        let n = 0, take = 0;
        // only SMALL pieces are batched (one copy of <= cap bytes made of < coalesceBelow pieces); a big piece is sent as-is -> never a 16 MB concat copy of multi-MB creates (nt-pagemem)
        while (take < queue.length && queue[take].byteLength < coalesceBelowBytes && n + queue[take].byteLength <= cap) n += queue[take++].byteLength;
        if (take === 0) { msg = queue.shift(); n = msg.byteLength; }
        else if (take === 1) msg = queue.shift();
        else {
          msg = new Uint8Array(n);
          let o = 0;
          for (const p of queue.splice(0, take)) { msg.set(p, o); o += p.byteLength; }
        }
      }
      queued -= msg.byteLength;
      const f = { t0: performance.now(), n: msg.byteLength };
      flight.push(f);
      st.messages++; st.bytes += f.n;
      send(msg).then((r) => { try { onReport(r); } catch (e) { onError(e); } }, onError).finally(() => {
        const ms = performance.now() - f.t0;
        st.lastMs = ms; st.maxMs = Math.max(st.maxMs, ms);
        st.lastMBps = f.n / 1048576 / Math.max(ms, 1e-3) * 1e3; // per-message round trip (understates when pipelined: includes waiting behind the previous apply)
        st.ackedBytes += f.n;
        flight.splice(flight.indexOf(f), 1);
        if (onAck) { try { onAck(st.ackedBytes); } catch (e) { onError(e); } }
        pump();
      });
    }
    if (!flight.length && !queue.length) for (const w of waiters.splice(0)) w();
  };
  return {
    stats: st,
    get queuedBytes() { return queued; },
    /** serialized by the page but not yet acked by the host: queued + in flight. The writer-side backpressure signal (scene-adapter encodeCap). */
    get pendingBytes() { let n = queued; for (const f of flight) n += f.n; return n; },
    get inflightCount() { return flight.length; },
    get inflightAgeMs() { return flight.length ? performance.now() - flight[0].t0 : 0; },
    push(chunk) { queue.push(chunk); queued += chunk.byteLength; st.maxQueued = Math.max(st.maxQueued, queued); pump(); },
    /** resolves when everything pushed so far has been applied by the host. */
    idle() {
if (!flight.length && !queue.length) return Promise.resolve();
// nt-frameleak (page-memory.js idleCoalesce): a per-frame renderTimed() on a pipe that never fully drains pushed one waiter + promise per call, released only at a full drain -> ONE shared promise while busy
if (!idleCoalesce) return new Promise((res) => waiters.push(res));
return (idleP ??= new Promise((res) => waiters.push(() => { idleP = null; res(); })));
},
/** nt-frameleak census: pieces queued / messages in flight / idle waiters (all must stay bounded). */
census() { return { queue: queue.length, flight: flight.length, waiters: waiters.length }; },
  };
}
