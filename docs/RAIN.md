# rain — how to see (operator's manual for agents)

You are an agent working in this world. Screenshots cannot show you motion
bugs: a still frame looks identical walking forwards or backwards, and pixels
don't carry foot-vs-terrain distance. **rain** is the engine's machine-native
perception — aligned integer token grids sampled straight from the world's
substrate. A column read downward IS a motion. Use it for *every* claim about
movement, placement, or facing. "It looks right" is not evidence; `OK` is.

Everything below is verified live — the sample outputs are real captures.

`fov` works for any rendered entity. `proprio` is specifically a VRM body
sense: it requires an entity whose mounted mesh has a `vrm` body, and returns
`!NOBODY` for any other entity. The hub world does not seed a VRM avatar;
choose one in a world that provides it.

## Prerequisites (once per session)

1. Dev stack running: `npm run dev` (server :8420, vite :5173).
2. A Chromium browser on the client with CDP **and** anti-throttling flags —
   without the last three, macOS pauses rAF when the window is covered and
   every sample freezes:

   ```bash
   open -na "Brave Browser" --args http://localhost:5173 \
     --remote-debugging-port=9222 \
     --disable-backgrounding-occluded-windows \
     --disable-background-timer-throttling \
     --disable-renderer-backgrounding
   ```

3. Run tools from the repo root.

## The two organs

### proprio — body sense (am *I* moving right?)

```bash
node tools/rain.mjs proprio <entityId> [--ticks N] [--hz N]   # default 20 ticks @ 10 Hz
```

```
#rain proprio nyari-avatar hz=10 q=cm|deg|cm/s OK
t  px   pz spd hdg fac err hipY LFy RFy LFf RFf
0 343 1771   0   ·  -5   ·   93   9   9   ·   ·
1 341 1781 103 -13  -5   8   93  42  22 -65  54
2 338 1791 106 -14  -8   6   93  21  14 -48  43
3 335 1802 113 -16 -12   4   93   7   4  24 -12
4 331 1814 124 -18 -16   2   93  22  42  54 -64
```

Channels (units in the header: cm, deg, cm/s — integers only, `·` = no data):

| chan | meaning |
|---|---|
| `t` | tick index |
| `px pz` | world position, cm |
| `spd` | ground speed, cm/s |
| `hdg` | direction of travel, deg (atan2(dx,dz)) |
| `fac` | direction the SKELETON faces — measured from the shoulder line, never from the animator's rotation variables, so it cannot inherit the body's bugs |
| `err` | wrap180(fac − hdg): 0 = walking where you look |
| `hipY` | hips above terrain, cm |
| `LFy RFy` | foot **soles** above terrain (toe bones, not ankles) |
| `LFf RFf` | each foot's forward offset from hips along heading — alternating sign = a real stride |

**Read the header first.** rain lints its own grid and convicts:

| flag | meaning | it caught this once already |
|---|---|---|
| `!BACK` | mean \|err\| > 135° — walking backwards | yes: err=178, fixed with +π (VRM0 meshes face −Z) |
| `!SKEW` | mean \|err\| > 45° — crabbing | |
| `!FLOAT` | min foot > 6 cm off the ground | yes: orbit without `ground:true` → footmin=76 |
| `!SINK` | min foot < −6 cm into terrain | |
| `!STIFF` | moving but stride columns dead — gliding statue | yes: server impulses read as speed 0 |
| `OK` | no conviction | |

### fov — eyes (what's around me, where do I go?)

```bash
node tools/rain.mjs fov <entityId> [--fov DEG] [--range M]    # default 120° / 40 m
```

```
#rain fov agent-nyari fac=2 fov=180 range=40 n=14 q=deg|cm
brg  dst ele kind     id
-18  176   4 mesh     spooky-tree-4
 46  349  -7 mesh     spooky-tree-5
 21  570   0 avatar   nyari-avatar
 55  912 127 presence agent-claude
```

Rows are FOV-culled, range-culled, **nearest first**. `brg` = bearing relative
to your facing (negative = left), `dst`/`ele` in cm, `kind` ∈
presence | avatar | light | mesh.

**Navigate by numbers, no renderer needed:**

```
worldDir = fac + brg                      (degrees)
dx = (dst/100) · sin(worldDir·π/180)
dz = (dst/100) · cos(worldDir·π/180)
node tools/agent.mjs walk <dx> <dz> <seconds>     # GAIA_AGENT env picks your body
```

Turn until `brg → 0`, advance until `dst` shrinks. That loop is walking.

## In-page API (CDP / console)

`window.gaia.rain.proprio(id, {ticks, hz})` (async) and
`window.gaia.rain.fov(id, {fov, range})` return the same grids as strings.
When evaluating over CDP, wrap in an IIFE — `(() => { ... })()` — or repeated
evals collide on re-declared consts.

## Codebook & source

- Codebook (channel + conviction definitions as data): `shared/schema.js → SENSES.rain`
- Organ: `client/kernel/rain.js` · Optic nerve: `tools/rain.mjs`

## Gotchas that already cost a debugging session each

- **Toes, not ankles.** The humanoid `leftFoot` bone is the ankle (~10 cm up on
  a standing body). rain prefers `leftToes`/`rightToes`; if you measure ground
  contact yourself anywhere else, do the same or you'll convict phantom floats.
- **Orbit behaviors fly by default.** `{type:"orbit"}` without `ground:true`
  is a flat circle at `center[1]` — over sunken terrain that's a float. See
  `shared/motion.js`.
- **Ops merge-clobber.** When fixing a behavior via `set`, send the FULL
  object, not a patch.
- **Server-driven motion is impulsive.** Positions arrive as jumps with still
  frames between; per-frame velocity reads as 0. The engine smooths with a
  0.45 s sliding window (`updateVrms`); if you sample velocity yourself, window
  it too.

## The standing regression check (VRM worlds)

```bash
node tools/rain.mjs proprio <vrm-avatar-id>
```

For a world that supplies a walking VRM avatar (for example `nyari-avatar` in
the Naruko worktree), the header must say `OK`. If you touched anything near
locomotion, VRM mounting, terrain, or behaviors and this convicts — you broke
it. It saw `!BACK !FLOAT !STIFF` before any human did; trust it over your
eyes.
