// FILM2 FOLD · contact sheet. A strip of 1-fps frames -> one JPEG grid with
// each frame's film-second burned in, so a picture can always be argued about
// with its own timestamp in the corner (the wall-clock naming bug of 07-29 is
// only visible when the number is IN the frame).
//
//   node tools/film2-fold-contact.mjs <stripDir> <out.jpg> [cols]
//
// Uses python3 + Pillow (no ImageMagick on this machine).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const out = process.argv[3];
const cols = Number(process.argv[4] ?? 8);
if (!dir || !out) { console.error('usage: film2-fold-contact.mjs <stripDir> <out.jpg> [cols]'); process.exit(1); }
const frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort();
if (!frames.length) { console.error('no frames in', dir); process.exit(1); }

const py = `
import sys, os
from PIL import Image, ImageDraw, ImageFont
d, out, cols = sys.argv[1], sys.argv[2], int(sys.argv[3])
names = sorted([f for f in os.listdir(d) if f.startswith('f') and f.endswith('.jpg')])
TW = 320
ims = []
for n in names:
    im = Image.open(os.path.join(d, n)).convert('RGB')
    h = max(1, round(im.height * TW / im.width))
    im = im.resize((TW, h), Image.LANCZOS)
    ims.append((n, im))
TH = max(i.height for _, i in ims)
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * TW, rows * TH), (8, 10, 16))
try: font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16)
except Exception: font = ImageFont.load_default()
dr = ImageDraw.Draw(sheet)
for i, (n, im) in enumerate(ims):
    x, y = (i % cols) * TW, (i // cols) * TH
    sheet.paste(im, (x, y))
    label = n[1:-4]
    dr.rectangle([x + 4, y + 4, x + 4 + 8 * len(label) + 8, y + 26], fill=(0, 0, 0))
    dr.text((x + 8, y + 6), label, fill=(210, 225, 255), font=font)
sheet.save(out, quality=82)
print(out, sheet.width, 'x', sheet.height, len(ims), 'frames')
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
console.log(execFileSync('python3', ['-c', py, dir, out, String(cols)], { encoding: 'utf8' }).trim());
