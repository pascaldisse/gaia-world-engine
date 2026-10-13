#!/usr/bin/env python3
"""Mock gaia-motion rt server: 24-body standing pose (Y-up m, quat xyzw) + sinusoidal bob @30 Hz. python3 tools/motion-rt-mock.py [port=8979]"""
import asyncio, json, math, sys, time, websockets
L = dict(Pelvis=(0,.95,0), Torso=(0,1.05,0), Spine=(0,1.17,0), Chest=(0,1.3,0), Neck=(0,1.5,0), Head=(0,1.6,0))
for s, k in (('L', 1), ('R', -1)):  # arms T-pose, legs straight; L = +x
    for n, (x, y, z) in dict(Hip=(.09,.92,0), Knee=(.09,.52,0), Ankle=(.09,.1,0), Toe=(.09,.05,.12), Thorax=(.08,1.45,0), Shoulder=(.18,1.45,0), Elbow=(.44,1.45,0), Wrist=(.68,1.45,0), Hand=(.76,1.45,0)).items(): L[f'{s}_{n}'] = (k*x, y, z)
clients, off, bob = set(), {}, 0.0
async def handler(ws):
    clients.add(ws)
    try:
        async for m in ws:
            c = json.loads(m); print('cmd', c, flush=True)
            if c.get('cmd') == 'impulse': off['x'] = .3 * (c.get('ns', 0) / 300)  # visible shove, decays below
            if c.get('cmd') == 'reset': off.clear()
    finally: clients.discard(ws)
async def main(port):
    async with websockets.serve(handler, '127.0.0.1', port):
        t0 = time.monotonic(); n = 0
        while True:
            t = n / 30; off['x'] = off.get('x', 0) * .97; dy = .03 * math.sin(2 * math.pi * .5 * t)
            f = json.dumps(dict(t=t, phase='stand', bodies=[dict(name=k, pos=[p[0] + off.get('x', 0), p[1] + dy, p[2]], quat=[0, 0, 0, 1]) for k, p in L.items()]))
            websockets.broadcast(clients, f); n += 1
            await asyncio.sleep(max(0, t0 + n / 30 - time.monotonic()))
asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 8979))
