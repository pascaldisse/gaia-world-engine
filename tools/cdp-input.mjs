// REAL browser input over the DevTools protocol — the player path for agents.
// `gaia.player.keys.add(...)` pokes internal state; this dispatches the same
// events a keyboard/mouse produces, so DOM handlers (plugins, overlays) run.
//
// usage:
//   node tools/cdp-input.mjs key Digit2        press+release a key (e.code)
//   node tools/cdp-input.mjs click <x> <y>     move, press, release LMB at page px
//   node tools/cdp-input.mjs altclick <x> <y>  same, with Alt held (bloodline's far end)
//   node tools/cdp-input.mjs wheel <dy> [x y]  wheel notch (default: viewport centre;
//                                              give x/y to scroll a PANEL, not the camera)
//   node tools/cdp-input.mjs drag <dx> <dy>    right-button drag from the centre
//   node tools/cdp-input.mjs ldrag <x> <y> <dx> <dy>   left-button drag from a point
//   node tools/cdp-input.mjs move <x> <y>     hover (plugins pick at the cursor)
//   node tools/cdp-input.mjs type <text>      type into the focused field, char by char
//   node tools/cdp-input.mjs eval <expr>      read the page back (proof, not input)
import { connectCdp } from './cdp-lib.mjs';

const [, , cmd, a, b, c, d] = process.argv;
const { ws, send } = await connectCdp();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = {
  Digit0: { key: '0', code: 'Digit0', keyCode: 48, text: '0' },
  Digit1: { key: '1', code: 'Digit1', keyCode: 49, text: '1' },
  Digit2: { key: '2', code: 'Digit2', keyCode: 50, text: '2' },
  Digit3: { key: '3', code: 'Digit3', keyCode: 51, text: '3' },
  Digit4: { key: '4', code: 'Digit4', keyCode: 52, text: '4' },
  KeyW: { key: 'w', code: 'KeyW', keyCode: 87, text: 'w' },
  KeyA: { key: 'a', code: 'KeyA', keyCode: 65, text: 'a' },
  KeyS: { key: 's', code: 'KeyS', keyCode: 83, text: 's' },
  KeyD: { key: 'd', code: 'KeyD', keyCode: 68, text: 'd' },
  KeyM: { key: 'm', code: 'KeyM', keyCode: 77, text: 'm' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  // range-input keys: the honest way to set a slider to an exact value
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

if (cmd === 'key') {
  const k = KEYS[a];
  if (!k) {
    console.error(`unknown key ${a} — add it to tools/cdp-input.mjs`);
    process.exit(1);
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  await sleep(40);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...k, text: undefined, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
  console.log(`key ${a}`);
} else if (cmd === 'click') {
  const x = Number(a);
  const y = Number(b);
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(30);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  console.log(`click ${x},${y}`);
} else if (cmd === 'altclick') {
  const x = Number(a);
  const y = Number(b);
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse', modifiers: 1 }; // 1 = Alt
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, modifiers: 1, pointerType: 'mouse' });
  await sleep(30);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  console.log(`altclick ${x},${y}`);
} else if (cmd === 'wheel') {
  let x;
  let y;
  if (b !== undefined && c !== undefined) { x = Number(b); y = Number(c); } else {
    const { result } = await send('Runtime.evaluate', { expression: '[innerWidth/2, innerHeight/2]', returnByValue: true });
    [x, y] = result.result.value;
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Number(a), pointerType: 'mouse' });
  console.log(`wheel ${a} @ ${x},${y}`);
} else if (cmd === 'drag') {
  const { result } = await send('Runtime.evaluate', { expression: '[innerWidth/2, innerHeight/2]', returnByValue: true });
  const [x, y] = result.result.value;
  const dx = Number(a);
  const dy = Number(b);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 8; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 8, y: y + (dy * i) / 8, button: 'right', buttons: 2, pointerType: 'mouse' });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'right', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  console.log(`drag ${dx},${dy}`);
} else if (cmd === 'ldrag') {
  // the left button is the plugin's grab: press ON the target, then move in
  // steps so pointermove fires with real movementX/Y deltas
  const x = Number(a);
  const y = Number(b);
  const dx = Number(c);
  const dy = Number(d);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await sleep(30);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 12; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 12, y: y + (dy * i) / 12, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(16);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  console.log(`ldrag ${x},${y} +${dx},${dy}`);
} else if (cmd === 'type') {
  // per-character keyDown/char/keyUp: a field that listens for keydown (the
  // atlas search swallows Escape there) must see the same events a hand does
  for (const ch of String(a ?? '')) {
    // keyDown carries NO text (Chrome would insert it) — the 'char' event is
    // what actually types; sending text on both doubles every character
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch });
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch, unmodifiedText: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(25);
  }
  console.log(`type ${a}`);
} else if (cmd === 'move') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(a), y: Number(b), buttons: 0, pointerType: 'mouse' });
  console.log(`move ${a},${b}`);
} else if (cmd === 'eval') {
  const { result } = await send('Runtime.evaluate', { expression: a, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(result.result?.value ?? result.exceptionDetails?.exception?.description ?? result, null, 2));
} else {
  console.log('usage: cdp-input.mjs key <Code> | click <x> <y> | altclick <x> <y> | move <x> <y> | wheel <dy> [x y] | drag <dx> <dy> | ldrag <x> <y> <dx> <dy> | eval <expr>');
}
ws.close();
process.exit(0);
