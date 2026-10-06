#!/usr/bin/env python3
# r4-compare.py gaia.png three.png out-prefix → side-by-side (gaia | three | 4x diff) + pixel-diff stats json. Regions: full, lower (y>=40%: no sky), character crop.
import sys, json
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
H, W, _ = a.shape
d = np.abs(a - b).max(axis=2)
def st(m, name):
    x = d[m]; ma = np.abs(a - b)[m].mean(axis=1)
    mse = ((a - b)[m] ** 2).mean()
    return {'region': name, 'px': int(x.size), 'mean_abs': round(float(ma.mean()), 2), 'p_over_8': round(float((x > 8).mean() * 100), 2), 'p_over_32': round(float((x > 32).mean() * 100), 2), 'psnr_db': round(float(10 * np.log10(255 ** 2 / mse)), 2) if mse else None}
full = np.ones((H, W), bool); lower = np.zeros((H, W), bool); lower[int(H * .4):] = True
char = np.zeros((H, W), bool); char[int(H * .45):int(H * .75), int(W * .45):int(W * .62)] = True
out = {'size': [W, H], 'stats': [st(full, 'full'), st(lower, 'lower60%'), st(char, 'character crop')]}
print(json.dumps(out, indent=1))
sbs = np.concatenate([a, b, np.repeat(np.clip(d * 4, 0, 255)[..., None], 3, axis=2)], axis=1).astype(np.uint8)
Image.fromarray(sbs).save(sys.argv[3] + '-sidebyside.png'); json.dump(out, open(sys.argv[3] + '-diff.json', 'w'), indent=1)
