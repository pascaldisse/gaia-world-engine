// per-tab identity that survives reloads: the same tab reconnects to the
// same presence entity, so anything granted to it (a carried light, later
// an inventory) is still there after F5. New tabs get their own.
const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('gaia-client') : null;
export const clientId = stored ?? `c${Math.random().toString(36).slice(2, 8)}`;
if (!stored && typeof sessionStorage !== 'undefined') sessionStorage.setItem('gaia-client', clientId);

export function connect({ url, presence, onSnapshot, onOps, onStatus, onScreenshot }) {
  let socket;
  let retry = 500;

  function open() {
    onStatus?.('connecting');
    socket = new WebSocket(url);
    socket.onopen = () => {
      retry = 500;
      onStatus?.('live');
      if (presence) socket.send(JSON.stringify({ type: 'hello', presence }));
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot') onSnapshot?.(msg.entities ?? {}, msg.time ?? 0, msg.manifest ?? null, msg.game ?? null);
      else if (msg.type === 'ops') onOps?.(msg.ops ?? [], msg.from);
      else if (msg.type === 'screenshot-request') onScreenshot?.(msg.id, msg.from);
    };
    socket.onclose = () => {
      onStatus?.('reconnecting');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
    socket.onerror = () => socket.close();
  }

  open();

  return {
    send: (ops) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ops', ops, from: clientId }));
      }
    },
    sendRaw: (msg) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
  };
}
