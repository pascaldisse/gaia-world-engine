// Dump the procedural iris canvas itself to a PNG. The only honest way to
// review a texture is to LOOK at it, separately from the lighting that will
// later be blamed for it.
import { connect, boot } from './eyes-cdp.mjs';
import fs from 'node:fs';
const c = await connect();
const url = await c.ev('return window.gaia?.eyes?.irisPng ? window.gaia.eyes.irisPng() : null;');
if (!url) { console.error('no gaia.eyes in the page — boot it first'); process.exit(1); }
const out = process.argv[2] ?? 'proof/eyes/iris-texture.png';
fs.mkdirSync('proof/eyes', { recursive: true });
fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
console.log({ out, bytes: fs.statSync(out).size });
c.close();
