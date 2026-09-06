import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hud, HUD_DEFAULT_ARMOR_MAX, HUD_DEFAULT_HEALTH_MAX } from '../client/kernel/hud.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.styleWrites = 0;
    this.style = new Proxy({}, { set: (target, key, value) => { this.styleWrites += 1; target[key] = value; return true; } });
    this.dataset = {};
    this.children = [];
    this._textContent = '';
    this.textWrites = 0;
    this.parentNode = null;
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this.textWrites += 1; this._textContent = value; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
}

let previousDocument;
let hud;
beforeEach(() => {
  previousDocument = globalThis.document;
  const body = new Element('body');
  globalThis.document = { body, createElement: (tag) => new Element(tag) };
  hud = new Hud({ presenceId: 'player', send() {}, player: { frozen: false, editorMode: false } });
});
afterEach(() => { hud?.dispose(); globalThis.document = previousDocument; });

describe('Hud core stats DOM', () => {
  test('authoritative health/current+max, armor, weapon/ammo and OG score suffix render', () => {
    hud.setStats({
      health: { hp: 73, max: 120 }, armor: { current: 25, max: 80 },
      weapon: { name: 'Shotgun', ammo: 4, maxAmmo: 8 }, score: { value: 900 },
    });
    expect(hud.statsEl.style.display).toBe('flex');
    expect(hud.healthEl.textContent).toBe('HEALTH  73/120');
    expect(hud.armorEl.textContent).toBe('ARMOR  25/80');
    expect(hud.scoreEl.textContent).toBe('SCORE  900$');
    expect(hud.weaponNameEl.textContent).toBe('SHOTGUN');
    expect(hud.ammoEl.textContent).toBe('AMMO  4/8');
  });

  test('documented defaults apply only when a present component omits max', () => {
    hud.setStats({ health: { hp: 50 }, armor: { current: 10 } });
    expect(HUD_DEFAULT_HEALTH_MAX).toBe(100);
    expect(HUD_DEFAULT_ARMOR_MAX).toBe(100);
    expect(hud.healthEl.textContent).toBe('HEALTH  50/100');
    expect(hud.armorEl.textContent).toBe('ARMOR  10/100');
  });

  test('component removal and missing stats hide empty sections and root', () => {
    hud.setStats({ health: { hp: 100, max: 100 }, weapon: { name: 'Pistol', ammo: 9 } });
    hud.setStats({ score: { value: 0 } });
    expect(hud.scoreEl.textContent).toBe('SCORE  0$');
    expect(hud.healthEl.style.display).toBe('none');
    expect(hud.weaponEl.style.display).toBe('none');
    hud.setStats(null);
    expect(hud.statsEl.style.display).toBe('none');
  });

  test('death, respawn and over-max authoritative values update without stale state or HUD formulas', () => {
    hud.setStats({ health: { hp: 0, max: 100 } });
    expect(hud.healthEl.textContent).toBe('HEALTH  0/100');
    hud.setStats({ health: { hp: 100, max: 100 } });
    expect(hud.healthEl.textContent).toBe('HEALTH  100/100');
    hud.setStats({ health: { hp: 125, max: 100 } });
    expect(hud.healthEl.textContent).toBe('HEALTH  125/100');
  });

  test('reload replaces ammo readout; null ammo never invents a count', () => {
    hud.setStats({ weapon: { name: 'Rifle', ammo: 3, maxAmmo: 30, reloading: 123 } });
    expect(hud.weaponNameEl.textContent).toBe('RIFLE');
    expect(hud.reloadEl.textContent).toBe('RELOADING');
    expect(hud.ammoEl.style.display).toBe('none');
    hud.setStats({ weapon: { name: 'Baseball Bat', ammo: null } });
    expect(hud.weaponNameEl.textContent).toBe('BASEBALL BAT');
    expect(hud.reloadEl.style.display).toBe('none');
    expect(hud.ammoEl.style.display).toBe('none');
  });

  test('mounted remains visible; title, frozen and editor contexts suppress it', () => {
    const stats = { health: { hp: 88, max: 100 } };
    hud.setStats(stats, { mounted: true });
    expect(hud.statsEl.style.display).toBe('flex');
    for (const key of ['title', 'frozen', 'editor']) {
      hud.setStats(stats, { [key]: true });
      expect(hud.statsEl.style.display, key).toBe('none');
    }
    hud.player.frozen = true; hud.setStats(stats);
    expect(hud.statsEl.style.display).toBe('none');
    hud.player.frozen = false; hud.player.editorMode = true; hud.setStats(stats);
    expect(hud.statsEl.style.display).toBe('none');
  });

  test('desktop/small viewport layout stays in bottom safe area, away from top HUD', () => {
    expect(hud.statsEl.style.inset).toBe('auto 12px 12px 12px');
    expect(hud.statsEl.style.fontSize).toContain('clamp(');
    expect(hud.vitalsEl.style.width).toBe('min(44vw, 22rem)');
    expect(hud.weaponEl.style.width).toBe('min(44vw, 22rem)');
    expect(hud.vitalsEl.style.maxWidth).toBe('44vw');
    expect(hud.vitalsEl.style.overflow).toBeUndefined();
    expect(hud.vitalsEl.style.textOverflow).toBeUndefined();
    expect(hud.vitalsEl.style.whiteSpace).toBeUndefined();
    expect(hud.vitalsEl.children.map((el) => el.dataset.field)).toEqual(['health', 'armor', 'score']);
    expect(hud.weaponEl.children.map((el) => el.dataset.field)).toEqual(['weapon', 'ammo', 'reserve', 'reloading']);
    expect(hud.starsEl.style.top).toBe('12px');
    expect(hud.countdownEl.style.top).toBe('12px');
    expect(hud.bannerEl.style.zIndex).toBe('25');
  });

  test('unchanged frame performs zero text-node or display-style writes', () => {
    const stats = {
      health: { hp: 73, max: 100 }, armor: { current: 20, max: 100 },
      weapon: { name: 'Shotgun', ammo: 4, maxAmmo: 8 }, score: { value: 50 },
    };
    hud.setStats(stats, { mounted: true });
    const elements = [
      hud.statsEl, hud.vitalsEl, hud.weaponEl, hud.healthEl, hud.armorEl,
      hud.scoreEl, hud.weaponNameEl, hud.ammoEl, hud.reloadEl,
    ];
    const writes = () => elements.reduce((sum, el) => sum + el.textWrites + el.styleWrites, 0);
    const before = writes();
    hud.setStats(structuredClone(stats), { mounted: true });
    expect(writes()).toBe(before);

    const textBefore = elements.reduce((sum, el) => sum + el.textWrites, 0);
    const styleBefore = elements.reduce((sum, el) => sum + el.styleWrites, 0);
    hud.setStats({ ...stats, weapon: { ...stats.weapon, ammo: 3 } }, { mounted: true });
    expect(elements.reduce((sum, el) => sum + el.textWrites, 0) - textBefore).toBe(1);
    expect(elements.reduce((sum, el) => sum + el.styleWrites, 0) - styleBefore).toBe(0);
    expect(hud.ammoEl.textContent).toBe('AMMO  3/8');
  });

  test('dispose clears timers and removes every owned DOM node', () => {
    const body = document.body;
    expect(body.children).toHaveLength(4);
    hud.dispose();
    expect(body.children).toHaveLength(0);
    expect(hud.countdownTimer).toBeNull();
    expect(hud.bannerTimer).toBeNull();
  });
});

test('finite inventory reserve has its own row, including zero; generic worlds stay unchanged', () => {
  hud.setStats({ weapon: { name: 'Revolver', ammo: 5, maxAmmo: 6, reserve: 154 } });
  expect(hud.reserveEl.textContent).toBe('RESERVE  154');
  expect(hud.ammoEl.textContent).toBe('AMMO  5/6');
  const writes = hud.reserveEl.textWrites + hud.reserveEl.styleWrites;
  hud.setStats({ weapon: { name: 'Revolver', ammo: 5, maxAmmo: 6, reserve: 154 } });
  expect(hud.reserveEl.textWrites + hud.reserveEl.styleWrites).toBe(writes);
  hud.setStats({ weapon: { name: 'Revolver', ammo: 1, reserve: 0 } });
  expect(hud.reserveEl.textContent).toBe('RESERVE  0');
  hud.setStats({ weapon: { name: 'Revolver', ammo: 1, reserve: -1 } });
  expect(hud.reserveEl.textContent).toBe('RESERVE  ∞');
  hud.setStats({ weapon: { name: 'Revolver', ammo: 1 } });
  expect(hud.reserveEl.style.display).toBe('none');
});

test('countdown uses injected simulation seconds instead of wall epoch', () => {
  let now = 100;
  hud.dispose();
  hud = new Hud({ presenceId: 'player', send() {}, player: {}, now: () => now });
  hud.setCountdown({ label: 'FIGHT', endsAt: 140 });
  expect(hud.countdownEl.textContent).toBe('FIGHT 00:40');
  now += 3; hud.renderCountdown();
  expect(hud.countdownEl.textContent).toBe('FIGHT 00:37');
});
