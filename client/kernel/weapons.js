import { isTyping } from './dom.js';

// Clip names are the exported `characters.glb` names. The OG animator selects
// weapon families rather than a unique state per melee item; unmapped weapons
// deliberately retain EmptyHands.
export const WEAPON_ANIMATIONS = Object.freeze({
  Revolver: { idle: 'Idle_pistol', fire: 'Shootig_pistol', reload: 'Realoding_pistol' },
  TommyGun: { idle: 'Idle_thompson', fire: 'Shooting_thompson', reload: 'Realoding_thompson' },
  Shotgun: { idle: 'Character_Shotgun_Idle', fire: 'Shooting_shootgun' },
  Uzi: { idle: 'Character_Smg_Idle', fire: 'Character_Smg_Shoot' },
  Minigun: { idle: 'Character_MiniGun_Idle', fire: 'Character_MiniGun' },
  RocketLauncher: { idle: 'Character_RPG_Idle', fire: 'Character_RPG_Shoot' },
  Chainsaw: { idle: 'EmptyHands', fire: 'Character_Chainsaw_attack' },
  Fist: { idle: 'EmptyHands' }, Knife: { idle: 'EmptyHands' }, Katana: { idle: 'EmptyHands' },
  Bat: { idle: 'EmptyHands' }, Flamethrower: { idle: 'EmptyHands' }, Molotov: { idle: 'EmptyHands' },
  Shocker: { idle: 'EmptyHands' }, Grenade: { idle: 'EmptyHands' },
});

const EMPTY = Object.freeze({ idle: 'EmptyHands' });
// A Vite public asset: this stays same-origin in development and is copied
// unchanged into the client build for the world server.
const WEAPONS_URL = '/assets/weapons.json';

export class Weapons {
  constructor({ store, player, send, domElement }) {
    this.store = store;
    this.player = player;
    this.send = send;
    this.domElement = domElement;
    this.presence = null;
    this.list = [];
    this.byName = new Map();
    this.firing = false;
    this.nextFireAt = 0;
    this.returnIdleAt = 0;
    this.lastWeapon = null;
    this.lastFire = null;
    this.handledKeys = new Set();

    // The OG PcMotionInput fires from mouse button 0. Weapon choice is its UI,
    // so GAIA supplies ordered number/scroll selection over the extracted table.
    this.onPointerDown = (e) => {
      if (e.button !== 0 || !this.controlsActive() || isTyping()) return;
      // First shot must use this click, not a stale prior mousemove.
      if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        this.player.pointerClient = { x: e.clientX, y: e.clientY };
      }
      this.firing = true;
      this.player.aimHeld = true;
    };
    this.onPointerUp = (e) => {
      if (e.button !== 0) return;
      this.firing = false;
      this.player.aimHeld = false;
    };
    const live = () => this.controlsActive();
    this.onWheel = (e) => {
      if (!live() || isTyping() || !this.list.length) return;
      e.preventDefault();
      this.cycle(e.deltaY > 0 ? 1 : -1);
    };
    this.onKeyDown = (e) => {
      if (!live() || isTyping()) return;
      if (e.code === 'KeyR') { e.preventDefault(); this.reload(); return; }
      const n = Number(e.code.slice(5));
      if (e.code.startsWith('Digit') && n >= 1 && n <= 9) { e.preventDefault(); this.equipIndex(n - 1); }
    };
    // focus loss must never leave the trigger stuck down (pointerup can be missed)
    this.onPointerCancel = () => this.releaseTrigger();
    this.onInputBlock = () => this.releaseTrigger();
    this.onBlur = () => this.releaseTrigger();
    this.onVisibility = () => { if (document.hidden) this.releaseTrigger(); };
    domElement?.addEventListener('pointerdown', this.onPointerDown);
    domElement?.addEventListener('wheel', this.onWheel, { passive: false });
    // Release may happen outside the canvas; window owns the terminal edge.
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.player.inputBlockListeners?.add(this.onInputBlock);
    fetch(WEAPONS_URL).then((r) => r.ok ? r.json() : Promise.reject(new Error(`GET ${WEAPONS_URL}: ${r.status}`)))
      .then((data) => { this.list = data.weapons ?? []; this.byName = new Map(this.list.map((w) => [w.name, w])); })
      .catch((err) => console.warn('[gaia] weapon data unavailable', err));
  }

  setPresence(id) { this.presence = id; }

  ownEntity() { return this.presence ? this.store.get(this.presence) : null; }
  controlsActive() {
    const health = this.ownEntity()?.health;
    const alive = !health || (health.hp ?? health.max ?? 0) > 0;
    const playerActive = this.player.inputActive?.()
      ?? this.player.controlsActive?.()
      ?? (!this.player.frozen && !this.player.editorMode && (this.player.locked || this.player.pointerAimActive?.()));
    return alive && playerActive;
  }
  releaseTrigger() {
    this.firing = false;
    this.player.aimHeld = false;
  }

  ownWeapon() { return this.presence ? this.store.get(this.presence)?.weapon ?? null : null; }
  animationFor(name) { return WEAPON_ANIMATIONS[name] ?? EMPTY; }
  auto(name) { return { idle: this.animationFor(name).idle, walk: 'Walking', run: 'Running', idleBelow: 0.1, runAbove: 2.5 }; }

  equipIndex(index) { if (this.list[index]) this.equip(this.list[index].name); }
  cycle(direction) {
    const index = this.list.findIndex((w) => w.name === this.ownWeapon()?.name);
    this.equipIndex((Math.max(index, 0) + direction + this.list.length) % this.list.length);
  }
  equip(name) {
    if (!this.controlsActive() || !this.byName.has(name) || !this.presence) return;
    this.send([{ op: 'equip', by: this.presence, weapon: name }]);
  }
  reload() {
    const weapon = this.ownWeapon();
    if (!this.controlsActive() || !weapon || !this.presence) return;
    this.send([{ op: 'reload', by: this.presence }]);
    const seconds = this.byName.get(weapon.name)?.realodTime ?? 0;
    this.play('reload', weapon.name, seconds);
  }
  fire() {
    const weapon = this.ownWeapon();
    if (!this.controlsActive() || !weapon || !this.presence || this.player.vehicle) return;
    const now = performance.now() / 1000;
    const spec = this.byName.get(weapon.name);
    if (now < this.nextFireAt) return;
    this.nextFireAt = now + (spec?.fireRate ?? 0);
    this.send([{ op: 'fire', by: this.presence, yaw: this.player.bodyYaw }]);
    this.play('fire', weapon.name, Math.max(spec?.fireRate ?? 0.12, 0.12));
  }
  play(kind, name, seconds) {
    const clip = this.animationFor(name)[kind];
    if (!clip || !this.presence) return;
    this.send([{ op: 'set', id: this.presence, component: 'animation', value: { clip, loop: 'once', speed: 1, fade: 0.08, auto: this.auto(name) } }]);
    this.returnIdleAt = performance.now() / 1000 + seconds;
  }
  idle(name) {
    if (!this.presence) return;
    this.send([{ op: 'set', id: this.presence, component: 'animation', value: { auto: this.auto(name), fade: 0.12 } }]);
  }

  update() {
    const controlsActive = this.controlsActive();
    // The Set is the testable input path used by player movement; listeners
    // above provide the real DOM path. Edge-detect only while controls live.
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'KeyR']) {
      const down = controlsActive && this.player.keys.has(code);
      if (down && !this.handledKeys.has(code)) {
        if (code === 'KeyR') this.reload(); else this.equipIndex(Number(code.slice(5)) - 1);
      }
      if (down) this.handledKeys.add(code); else this.handledKeys.delete(code);
    }
    if (!controlsActive) this.releaseTrigger();
    const weapon = this.ownWeapon();
    const name = weapon?.name;
    this.player.weaponSpeedMultiplier = this.byName.get(name)?.speedPenaltyMultiplier ?? 1;
    if (name && name !== this.lastWeapon) { this.lastWeapon = name; this.idle(name); }
    if (!name) this.lastWeapon = null;
    if (weapon?.lastFire !== undefined && weapon.lastFire !== this.lastFire) {
      this.lastFire = weapon.lastFire;
      // server acceptance is authoritative; mirror remote/synthetic fires too
      if (name) this.play('fire', name, Math.max(this.byName.get(name)?.fireRate ?? 0.12, 0.12));
    }
    // fire under pointer-lock (FPS) OR a visible-cursor pointer-aim rig (top-down)
    if (this.firing && controlsActive && !isTyping()) this.fire();
    if (this.returnIdleAt && performance.now() / 1000 >= this.returnIdleAt) {
      this.returnIdleAt = 0;
      if (name) this.idle(name);
    }
  }

  dispose() {
    this.domElement?.removeEventListener('pointerdown', this.onPointerDown);
    this.domElement?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.player.inputBlockListeners?.delete(this.onInputBlock);
  }
}
