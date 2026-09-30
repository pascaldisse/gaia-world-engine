#!/usr/bin/env node
// vendor GAIA Motion web runtime into a consumer repo: node tools/vendor.mjs <destDir> [--allow-dirty]
// copies web/*.js (runtime only: no tests/demo/tools/scratch _*) + VERSION (commit sha, -dirty if tree unclean)
import { readdirSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); const dest = args.find((a) => !a.startsWith('--'));
if (!dest) { console.error('usage: node tools/vendor.mjs <destDir> [--allow-dirty]'); process.exit(2); }
const git = (...a) => execFileSync('git', ['-C', src, ...a], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', '.') !== '';
if (dirty && !args.includes('--allow-dirty')) { console.error(`web/ has uncommitted changes — commit first or pass --allow-dirty`); process.exit(1); }
const files = readdirSync(src).filter((f) => f.endsWith('.js') && !f.startsWith('_') && !/\.test\.|^demo/.test(f)).sort();
mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(join(src, f), join(dest, f));
writeFileSync(join(dest, 'VERSION'), `gaia-motion-web ${sha}${dirty ? '-dirty' : ''}\nfiles: ${files.join(' ')}\n`);
console.log(`vendored ${files.length} files @ ${sha.slice(0, 7)}${dirty ? '-dirty' : ''} → ${resolve(dest)}`);
