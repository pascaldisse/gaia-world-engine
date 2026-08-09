# atom2 step a — P2 thickness pass, grey debug map

world=`worlds/agni-thickness` (data-only copy of surya-optin; `render.mode="thickness"`)
build token (`client/assets/build.txt`) = parent `8e28cd9…` · particles **16384**

## how the plates were taken
```sh
GAIA_PORT=8461 GAIA_WORLD=$PWD/worlds/agni-thickness node server/index.js
GAIA_PORT=8461 GAIA_CLIENT_PORT=5241 npx vite
GAIA_CLIENT_PORT=5241 CDP_PORT=9353 URL="http://localhost:5241/?mute=1" \
  PROFILE=$PWD/scratch/agni/prof-thick bash tools/agni-browser.sh
CDP_PORT=9353 GAIA_CLIENT_PORT=5241 node tools/varuna-shot.mjs \
  --out=proof/agni-thickness/a-thickness-map-g005.png --pos=0,6.0,6.0 --look=0,0.9,0 --wait=4000
```
headful: `agni-browser.sh` flag scan printed "none"; `ps` grep -c headless = **0**.
adapter (`navigator.gpu.requestAdapter().info`, real fluid tab):
`{"vendor":"apple","architecture":"metal-3","device":"","description":""}`
UA: `…Chrome/151.0.0.0 Safari/537.36` (Brave 151.1.93.134).

## plates
| file | what it shows |
|---|---|
| `a-thickness-map-g005.png` | **the proof**: grey thickness map, `debugGain 0.05`, `debugBlend replace` |
| `a-thickness-map.png` | same at gain 0.5 — body clips to white, rim impostors readable |
| `a-thickness-rt.png` | additive debug (`debugBlend add`), private-RT path first light |
| `z-hidden.png` | mesh hidden — control: the basin alone, no thickness |

## measured (independent of the shader)
`a-thickness-map-g005.png`, liquid crop (42–58% x, 33–52% y), luminance:
`min 3 · max 220 · mean 185.9 · fraction at 255 = 0.0000`
∴ the map is a RAMP, not a saturated blob — thin single droplets read near-black,
the deep body reads bright grey. That ramp IS the quantity 8e28cd9 never had.

## still UNVERIFIED at this atom
p95 frame cost with the extra pass · physics re-measure (`ymax/ymean/rmax/outsideR`)
· Atlas pre/post plate diff · blur/normal/composite (atoms b–c).
