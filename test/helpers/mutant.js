// Source-mutation helper: load a module with one literal replaced -> proves a test bites.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
export async function loadMutant(relFromRepo, from, to) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const abs = join(root, relFromRepo);
  const src = readFileSync(abs, 'utf8');
  if (!src.includes(from)) throw new Error(`mutant anchor not found: ${from}`);
  const out = src.replace(from, to).replace(/from '\.\//g, `from '${pathToFileURL(dirname(abs)).href}/`);
  const f = join(mkdtempSync(join(tmpdir(), 'mut-')), 'm.mjs');
  writeFileSync(f, out);
  return import(pathToFileURL(f).href + '?' + Math.random());
}
