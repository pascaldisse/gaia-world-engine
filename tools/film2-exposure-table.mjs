// FILM2 FOLD · exposure table. A strip of clock-named frames -> per-frame
// luma statistics, so "it looks blown out" becomes a number that can be
// argued with.
//
//   node tools/film2-exposure-table.mjs <stripDir> <outBase> [firstSec] [lastSec]
//
// Emits <outBase>.json and <outBase>.txt.
//
// THE TWO NUMBERS THAT DECIDE:
//   p99      — how bright the brightest real content is (a star's peak).
//   contrast — p99 minus median. A FLAT WASH is the conviction: a white blob
//              on lifted lavender has a high p99 AND a high median, so its
//              contrast collapses. Legibility lives in contrast, not peak.
// blowout   — fraction of pixels above 0.9 luma; "a star may not be larger
//              than the parish it lights" is this number staying small.
//
// Uses python3 + Pillow (no ImageMagick on this machine), same as the
// contact-sheet tool.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const outBase = process.argv[3];
const first = process.argv[4] ? Number(process.argv[4]) : -Infinity;
const last = process.argv[5] ? Number(process.argv[5]) : Infinity;
if (!dir || !outBase) {
  console.error('usage: film2-exposure-table.mjs <stripDir> <outBase> [firstSec] [lastSec]');
  process.exit(1);
}

const py = `
import sys, os, json
from PIL import Image
d, first, last = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
names = sorted([f for f in os.listdir(d) if f.startswith('f') and f.endswith('.jpg')],
               key=lambda n: float(n[1:-4]))
rows = []
for n in names:
    sec = float(n[1:-4])
    if sec < first or sec > last: continue
    im = Image.open(os.path.join(d, n)).convert('RGB')
    # Rec.709 luma, computed from the full-res pixels (no resize: a resize
    # averages away exactly the peak this table exists to measure).
    px = im.load()
    W, H = im.size
    hist = [0] * 256
    for y in range(H):
        for x in range(W):
            r, g, b = px[x, y]
            hist[(r * 54 + g * 183 + b * 19) >> 8] += 1
    total = W * H
    def q(f):
        want, run = f * total, 0
        for v in range(256):
            run += hist[v]
            if run >= want: return v / 255.0
        return 1.0
    p99, med = q(0.99), q(0.50)
    blow = sum(hist[230:]) / total          # 230/255 = 0.902
    rows.append({'frame': n, 'sec': sec, 'p99': round(p99, 4), 'median': round(med, 4),
                 'contrast': round(p99 - med, 4), 'blowout': round(blow, 4),
                 'w': W, 'h': H})
print(json.dumps(rows))
`;

const raw = execFileSync('python3', ['-c', py, dir, String(first), String(last)], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
const rows = JSON.parse(raw);
if (!rows.length) { console.error('no frames in range'); process.exit(1); }

fs.mkdirSync(path.dirname(outBase), { recursive: true });
fs.writeFileSync(`${outBase}.json`, `${JSON.stringify(rows, null, 2)}\n`);

const head = `  sec     p99   median  contrast  blowout   verdict`;
const line = (r) => {
  // verdict is advisory only — the eye and the contact sheet still rule.
  const bad = [];
  if (r.contrast < 0.25) bad.push('FLAT');
  if (r.blowout > 0.12) bad.push('BLOWN');
  if (r.median > 0.30) bad.push('LIFTED');
  return `${String(r.sec).padStart(6)}  ${r.p99.toFixed(3)}   ${r.median.toFixed(3)}    ${r.contrast.toFixed(3)}    ${r.blowout.toFixed(3)}   ${bad.join(' ') || 'ok'}`;
};
const txt = [`film2 fold · exposure table · ${dir}`, `frames: ${rows.length}  (${rows[0].sec} … ${rows[rows.length - 1].sec})`,
  '', head, ...rows.map(line), '',
  'FLAT   = contrast (p99-median) < 0.25 — white-on-white, silhouette cannot read',
  'BLOWN  = >12% of pixels above 0.9 luma — the star is larger than its parish',
  'LIFTED = median > 0.30 — background is no longer deep dark violet',
].join('\n');
fs.writeFileSync(`${outBase}.txt`, `${txt}\n`);
console.log(txt);
console.error(`\nwrote ${outBase}.json ${outBase}.txt`);
