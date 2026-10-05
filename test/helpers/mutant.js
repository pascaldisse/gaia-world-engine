// Source-mutation helper: load a module with one literal replaced -> proves a test bites.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
export async function loadMutant(relFromRepo, from, to) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const abs = join(root, relFromRepo);
  const src = readFileSync(abs, 'utf8');
  if (!src.includes(from)) throw new Error(`mutant anchor not found: ${from}`);
  const out = src.replace(from, to).replace(/from '\.\//g, `from '${pathToFileURL(dirname(abs)).href}/`);
  // temp lives under node_modules/.cache so bare imports ('three') resolve from the repo
  const cache = join(root, 'node_modules', '.cache'); mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'mut-')); const f = join(dir, 'm.mjs');
  writeFileSync(f, out);
  try { return await import(pathToFileURL(f).href + '?' + Math.random()); } finally { rmSync(dir, { recursive: true, force: true }); }
}
