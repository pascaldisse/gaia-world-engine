# surya-optin — opt-in fluid + four primitives (one world)

新file only. Engine seams untouched.

## 世界data
- `world.json` → `features.primitives: true` (primitives.js `setWorld`: `world?.features?.primitives === true`).
- `scenes/main.json` → 8 entities.

## opt-in gate (fluid)
`client/kernel/fluid.js` `register(ctx)`:
- probe = `window.__GAIA_FLUID__.enabled === true` OR `?fluid=1` — 非使用 here.
- `worldConfig()` counts entities with `components.fluid.enabled === true`;
  `matches.length === 1 ? matches[0] : null` — ambiguity ≠ consent.
∴ exactly ONE fluid component in this world: `surya_spring`.

## 四原基
| primitive | entity | field |
|---|---|---|
| attach | `surya_lantern` | `attach.parent = "surya_pillar"` (matrix inheritance) |
| lifecycle / TTL | `surya_mote` | `lifecycle.ttl = 60` (no `bornAt` → clock starts at first observation) |
| per-part phase | `surya_pillar` | part[1] (ring) has `phase`, part[0] (shaft) does not |
| transmission | `surya_basin` | part `transmission` → `makeTransmissionMaterial` |

## 走らせ方 (port=param, 既定8931, loopback)
```
cd ~/projects/gwe-merge-vishnu
GAIA_HOST=127.0.0.1 GAIA_PORT=${PORT:-8931} GAIA_WORLD=$PWD/worlds/surya-optin node server/index.js
# client (vite dev), same port injected:
GAIA_PORT=${PORT:-8931} npx vite
```
WebGPU backend required for the fluid: non-WebGPU → `[fluid] backend is not WebGPU — GPU fluid stays OFF`.

## 未測 (UNVERIFIED)
- Browser-observed drop→splat→re-gather in THIS world: not measured.
- fps / particle count: not measured.
