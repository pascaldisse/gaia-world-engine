import { test, expect } from 'bun:test';
import path from 'node:path';
// CLI transport/error contract only; not a rendered-world fixture.
async function run(response) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req, server) {
    if (new URL(req.url).pathname === '/cdp') { if (server.upgrade(req)) return; }
    return Response.json([{ type: 'page', url: `http://localhost:${server.port}/`, webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/cdp` }]);
  }, websocket: { message(ws, raw) { const request = JSON.parse(raw); ws.send(JSON.stringify({ id: request.id, result: response })); } } });
  try {
    const proc = Bun.spawn([process.execPath, path.resolve(import.meta.dir, '../tools/rain.mjs'), 'frame', '--cols', '20'], {
      env: { ...process.env, CDP_PORT: String(server.port), GAIA_CLIENT_PORT: String(server.port) }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  } finally { server.stop(true); }
}
test('Rain CLI prints protocol text and succeeds only on a successful evaluated response', async () => {
  const r = await run({ result: { type: 'string', value: '#rain frame src=transport-fixture\n..' } });
  expect(r.code).toBe(0); expect(r.stdout).toContain('#rain frame');
});
test('Rain CLI propagates CDP evaluation failures instead of returning success', async () => {
  const r = await run({ exceptionDetails: { text: 'fixture evaluation failure' } });
  expect(r.code).toBe(2); expect(r.stderr).toContain('fixture evaluation failure');
});
test('Rain CLI signals failed pixel readback; missing target remains a normal explicit diagnostic', async () => {
  expect((await run({ result: { type: 'string', value: '#rain frame !READ_FAILED GPU lost' } })).code).toBe(2);
  expect((await run({ result: { type: 'string', value: '#rain frame !NO_PIXEL_TARGET' } })).code).toBe(0);
});
