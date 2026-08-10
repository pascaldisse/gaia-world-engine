// World-server port resolution: ?port=N beats the build-time __GAIA_PORT__
// (vite define, from env GAIA_PORT ?? 8420). Lets a live vite client point at
// any server without rebuilding — no hardcoded ports anywhere.
const fromQuery = new URLSearchParams(location.search).get('port');
export const GAIA_PORT = fromQuery && /^\d+$/.test(fromQuery) ? fromQuery : __GAIA_PORT__;
