import { defineConfig } from 'vite';

// Two games can run side by side: GAIA_PORT moves the world server (and the
// client's idea of where it lives — injected as __GAIA_PORT__), and
// GAIA_CLIENT_PORT moves vite itself.
export default defineConfig({
  root: 'client',
  server: { port: Number(process.env.GAIA_CLIENT_PORT ?? 5173), fs: { allow: ['..'] } },
  define: { __GAIA_PORT__: JSON.stringify(process.env.GAIA_PORT ?? '8420') },
});
