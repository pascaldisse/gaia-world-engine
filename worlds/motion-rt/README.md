# motion-rt — live ragdoll client for gaia-motion's rt server
Kernel: `client/kernel/motion-rt.js` (default extension, URL-gated by `?motion=`; no param = no-op).
- run mock: `python3 tools/motion-rt-mock.py [port=8979]` (24-body T-pose, 30 Hz bob; impulse shoves +x, reset clears; logs cmds)
- run world: `GAIA_PORT=8462 GAIA_WORLD=$PWD/worlds/motion-rt node server/index.js` + `GAIA_PORT=8462 GAIA_CLIENT_PORT=5262 node_modules/.bin/vite`
- open: `http://localhost:5262/?level=stage&mute=1&motion=1` (`motion=ws://host:port` overrides ws://127.0.0.1:8979)
- wire in: `{t,phase?,behaviour?,bodies:[{name,pos:[x,y,z],quat:[x,y,z,w]}]}`
- wire out: `{cmd:impulse,body:Pelvis,ns:300,axis:[1,0,0]}` I · `{cmd:reset}` R · `{cmd:behaviour,name}` 1 bodyBalance 2 catchFall 3 staggerFall 4 shot 5 protectHead
- coords: real server = MuJoCo Z-up RH metres → Ragdoll group rot -90° X (default). `?motionUp=y` = identity (mock/Y-up server). `?motionQuat=wxyz` flips quat order; `?motionAt=x,y,z` offsets the group. Proof: docs/motion-rt-proof.md
- pos = body ORIGIN (joint): capsule spans origin→child (SMPL chain table), leaf bodies = sphere. If server sends COM instead, shapes offset along bone.
- HUD `#motion-hud`: status · measured Hz (1 s window) · phase · behaviour · body count · t. State: `gaia.motionRt.state`.
- proof: `proof/motion-rt-standing.png`, `proof/motion-rt-impulse.png` (Pelvis shoved +x)
