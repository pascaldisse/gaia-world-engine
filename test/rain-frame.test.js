import { test, expect } from 'bun:test';
import { makeRain, frameSymbol } from '../client/kernel/rain.js';

const base = { store: { entities: new Map() }, view: { getGroup: () => null, ownPresence: null, animatedModels: new Map() } };
// 8×4 image in TOP-LEFT order: row 0 white, rows 1-3 left half red / right half blue
function image(origin, Ctor = Uint8Array) {
  const width = 8, height = 4;
  const rgba = new Ctor(width * height * 4);
  const put = (x, y, r, g, b) => { const sy = origin === 'top-left' ? y : height - 1 - y; const k = (sy * width + x) * 4; rgba[k] = r; rgba[k + 1] = g; rgba[k + 2] = b; rgba[k + 3] = 255; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (y === 0) put(x, y, 255, 255, 255);
    else if (x < 4) put(x, y, 255, 0, 0);
    else put(x, y, 0, 0, 255);
  }
  return { width, height, rgba, source: 'fixture', origin };
}
const withPx = (fn, extra = {}) => makeRain({ ...base, readPixels: fn, ...extra });

test('frame: no callback / null → !NO_PIXEL_TARGET; throwing callback → bounded !READ_FAILED', async () => {
  expect(await makeRain(base).frame()).toBe('#rain frame !NO_PIXEL_TARGET no readPixels callback');
  expect(await withPx(async () => null).frame()).toBe('#rain frame !NO_PIXEL_TARGET');
  const out = await withPx(async () => { throw new Error('GPU  lost\n' + 'x'.repeat(200)); }).frame();
  expect(out.startsWith('#rain frame !READ_FAILED GPU lost x')).toBe(true);
  expect(out.length).toBeLessThanOrEqual('#rain frame !READ_FAILED '.length + 80);
});

test('frame: colours + orientation — rows y-down from either declared origin (WebGPU = top-left), one read per call, clamped arrays accepted', async () => {
  let reads = 0;
  for (const [origin, Ctor] of [['top-left', Uint8Array], ['bottom-left', Uint8Array], ['top-left', Uint8ClampedArray]]) {
    const out = await withPx(async () => { reads++; return image(origin, Ctor); }).frame({ cols: 2, rows: 4 });
    const [head, ...lines] = out.split('\n');
    expect(head).toContain('src=fixture frame=? px=8x4 grid=2x4 cell=4.0x1.0 aspect=2.00 rows=y-down');
    expect(lines).toEqual(['##', 'rb', 'rb', 'rb']);
  }
  expect(reads).toBe(3);
});

test('frame: strict contract — origin enum, integer dims, uint8 family, exact length; nothing silently flips', async () => {
  const img = image('top-left');
  expect(await withPx(async () => ({ ...img, origin: undefined })).frame()).toBe('#rain frame !BAD_ORIGIN undefined need=top-left|bottom-left');
  expect(await withPx(async () => ({ ...img, origin: 'upper-left' })).frame()).toBe('#rain frame !BAD_ORIGIN upper-left need=top-left|bottom-left');
  expect(await withPx(async () => ({ ...img, width: 8.5 })).frame()).toBe('#rain frame !BAD_DIMENSIONS 8.5x4');
  expect(await withPx(async () => ({ ...img, height: 0 })).frame()).toBe('#rain frame !BAD_DIMENSIONS 8x0');
  expect(await withPx(async () => ({ ...img, rgba: Array.from(img.rgba) })).frame()).toBe('#rain frame !BAD_BUFFER type=Array need=Uint8Array');
  expect(await withPx(async () => ({ ...img, rgba: new Float32Array(128) })).frame()).toBe('#rain frame !BAD_BUFFER type=Float32Array need=Uint8Array');
  expect(await withPx(async () => ({ ...img, rgba: new Uint8Array(3) })).frame()).toBe('#rain frame !BAD_BUFFER len=3 need=128');
  expect(await withPx(async () => ({ ...img, rgba: new Uint8Array(129) })).frame()).toBe('#rain frame !BAD_BUFFER len=129 need=128');
});

test('frame: symbol table — dim reads black/dots, saturated hue letters by luminance', () => {
  expect(frameSymbol(0, 0, 0)).toBe(' ');
  expect(frameSymbol(0.04, 0.04, 0.04)).toBe(' ');
  expect(frameSymbol(0.2, 0.2, 0.2)).toBe('.');
  expect(frameSymbol(1, 1, 1)).toBe('#');
  expect(frameSymbol(1, 0, 0)).toBe('r');
  expect(frameSymbol(1, 0.6, 0.6)).toBe('R');
  expect(frameSymbol(0, 1, 0)).toBe('G');
  expect(frameSymbol(1, 1, 0)).toBe('Y');
  expect(frameSymbol(0, 1, 1)).toBe('C');
  expect(frameSymbol(1, 0, 1)).toBe('m'); // lum 0.285 → dim by the legend's own rule
  expect(frameSymbol(1, 0.7, 1)).toBe('M');
  expect(frameSymbol(0, 0, 1)).toBe('b');
});

test('frame: strict bounds — never larger than source, maxCells shrinks, non-finite falls back', async () => {
  const rain = withPx(async () => image('top-left'));
  expect((await rain.frame({ cols: 999, rows: 999 })).split('\n')[0]).toContain('grid=8x4');
  expect((await rain.frame({ cols: NaN, rows: 'x' })).split('\n')[0]).toContain('grid=8x4');
  const big = { width: 400, height: 200, rgba: new Uint8Array(400 * 200 * 4), source: 'fixture', origin: 'top-left' };
  const head = (await withPx(async () => big, { maxCells: 200 }).frame({ cols: 100, rows: 50 })).split('\n')[0];
  const [c, r] = head.match(/grid=(\d+)x(\d+)/).slice(1).map(Number);
  expect(c * r).toBeLessThanOrEqual(200);
  expect(c).toBe(Math.floor(100 * Math.sqrt(200 / 5000)));
});

test('frame: top-left pixel crop preserves both readback origins; invalid crop refuses', async () => {
  for (const origin of ['top-left', 'bottom-left']) {
    const rain = withPx(async () => image(origin));
    const out = await rain.frame({ cols: 1, rows: 3, crop: { x: 4, y: 1, width: 4, height: 3 } });
    expect(out.split('\n').slice(1)).toEqual(['b', 'b', 'b']);
    expect(out.split('\n')[0]).toContain('crop=4,1,4,3');
    for (const crop of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 4, y: 1, width: 5, height: 3 }, { x: 0, y: 0, width: 0, height: 1 }]) expect(await rain.frame({ crop })).toContain('!BAD_CROP');
  }
});
