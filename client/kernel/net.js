export const clientId = `c${Math.random().toString(36).slice(2, 8)}`;

export function connect({ url, onSnapshot, onOps, onStatus }) {
  let socket;
  let retry = 500;

  function open() {
    onStatus?.('connecting');
    socket = new WebSocket(url);
    socket.onopen = () => {
      retry = 500;
      onStatus?.('live');
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot') onSnapshot?.(msg.entities ?? {});
      else if (msg.type === 'ops') onOps?.(msg.ops ?? [], msg.from);
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
  };
}
