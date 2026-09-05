// The wanted stars + busted/wasted flow — GTA's read on "you got caught".
// Builds its own DOM (fixed elements appended to <body>) rather than reusing
// index.html markup, so it stays a drop-in kernel object like weapons/panel.

export const HUD_DEFAULT_HEALTH_MAX = 100;
export const HUD_DEFAULT_ARMOR_MAX = 100;

const finite = (value) => Number.isFinite(value);

export class Hud {
  constructor({ presenceId, send, player }) {
    this.presenceId = presenceId;
    this.send = send;
    this.player = player;
    this.showing = false; // banner guard: not re-triggerable while up
    this.buildStars();
    this.buildBanner();
    this.buildCountdown();
    this.buildStats();
  }

  // Generic countdown readout: a world that puts a `countdown`
  // ({label, endsAt}) component on the presence gets a mission timer.
  buildCountdown() {
    this.countdownEl = document.createElement('div');
    Object.assign(this.countdownEl.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'none',
      color: '#e8f0ff',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: '20px',
      letterSpacing: '2px',
      textShadow: '0 1px 4px rgba(0, 0, 0, 0.85)',
      zIndex: '15',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    document.body.appendChild(this.countdownEl);
    this.countdown = null;
    this.countdownTimer = setInterval(() => this.renderCountdown(), 250);
  }

  // {label, endsAt} — endsAt is server epoch seconds (Date.now()/1000)
  setCountdown(countdown) {
    this.countdown = countdown?.endsAt ? countdown : null;
    this.renderCountdown();
  }

  renderCountdown() {
    if (!this.countdownEl) return;
    if (!this.countdown) { this.countdownEl.style.display = 'none'; return; }
    const remain = Math.max(0, this.countdown.endsAt - Date.now() / 1000);
    const mm = String(Math.floor(remain / 60)).padStart(2, '0');
    const ss = String(Math.floor(remain % 60)).padStart(2, '0');
    this.countdownEl.textContent = `${this.countdown.label ?? ''} ${mm}:${ss}`.trim();
    this.countdownEl.style.color = remain <= 10 ? '#ff6b57' : '#e8f0ff';
    this.countdownEl.style.display = 'block';
  }

  buildStats() {
    this.statsEl = document.createElement('div');
    this.statsEl.dataset.gaiaHud = 'stats';
    Object.assign(this.statsEl.style, {
      position: 'fixed', inset: 'auto 12px 12px 12px', display: 'none',
      alignItems: 'end', justifyContent: 'space-between', gap: '12px',
      zIndex: '15', pointerEvents: 'none', userSelect: 'none',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      color: '#f4f7ff', fontSize: 'clamp(12px, 2.6vw, 16px)',
      textShadow: '0 1px 4px rgba(0,0,0,.95)',
    });
    this.vitalsEl = document.createElement('div');
    this.weaponEl = document.createElement('div');
    for (const el of [this.vitalsEl, this.weaponEl]) Object.assign(el.style, {
      boxSizing: 'border-box', minWidth: '0', width: 'min(44vw, 22rem)',
      maxWidth: '44vw', padding: '7px 9px', background: 'rgba(6,10,18,.72)',
      borderRadius: '4px', display: 'none', flexDirection: 'column', gap: '3px',
    });
    const row = (parent, field) => {
      const el = document.createElement('div');
      el.dataset.field = field;
      Object.assign(el.style, { display: 'none', justifyContent: 'space-between', gap: '8px' });
      parent.appendChild(el);
      return el;
    };
    this.healthEl = row(this.vitalsEl, 'health');
    this.armorEl = row(this.vitalsEl, 'armor');
    this.scoreEl = row(this.vitalsEl, 'score');
    this.weaponNameEl = row(this.weaponEl, 'weapon');
    this.ammoEl = row(this.weaponEl, 'ammo');
    this.reloadEl = row(this.weaponEl, 'reloading');
    this.statsEl.appendChild(this.vitalsEl);
    this.statsEl.appendChild(this.weaponEl);
    document.body.appendChild(this.statsEl);
    this.stats = null;
    this.statsContext = {};
  }

  // Normalized authoritative view model. Callers map their ECS components;
  // this object never calculates armor, ammo capacity, score, or currency.
  setStats(stats, context = {}) {
    this.stats = stats && typeof stats === 'object' ? stats : null;
    this.statsContext = context ?? {};
    this.renderStats();
  }

  renderStats() {
    if (!this.statsEl) return;
    const context = this.statsContext ?? {};
    const suppressed = context.title || context.frozen || context.editor
      || this.player?.frozen || this.player?.editorMode;
    const health = this.stats?.health;
    const armor = this.stats?.armor;
    const weapon = this.stats?.weapon;
    const score = this.stats?.score;
    const healthCurrent = health?.current ?? health?.hp;
    const healthMax = health?.max ?? (finite(healthCurrent) ? HUD_DEFAULT_HEALTH_MAX : null);
    const armorCurrent = armor?.current;
    const armorMax = armor?.max ?? (finite(armorCurrent) ? HUD_DEFAULT_ARMOR_MAX : null);
    const setDisplay = (el, value) => {
      if (el.style.display !== value) el.style.display = value;
    };
    const show = (el, text) => {
      const nextText = text ?? '';
      if (el.textContent !== nextText) el.textContent = nextText;
      setDisplay(el, text === null ? 'none' : 'flex');
      return text !== null;
    };
    const hasHealth = show(this.healthEl, finite(healthCurrent) && finite(healthMax) && healthMax > 0
      ? `HEALTH  ${healthCurrent}/${healthMax}` : null);
    const hasArmor = show(this.armorEl, finite(armorCurrent) && finite(armorMax) && armorMax > 0
      ? `ARMOR  ${armorCurrent}/${armorMax}` : null);
    const scoreValue = score?.value ?? score;
    // Original ScoreView renders the score with a trailing dollar sign.
    const hasScore = show(this.scoreEl, finite(scoreValue) ? `SCORE  ${scoreValue}$` : null);
    const hasWeapon = show(this.weaponNameEl, weapon?.name ? String(weapon.name).toUpperCase() : null);
    const hasReload = show(this.reloadEl, weapon?.name && weapon.reloading ? 'RELOADING' : null);
    const hasAmmo = show(this.ammoEl, weapon?.name && !weapon.reloading && finite(weapon.ammo)
      ? `AMMO  ${finite(weapon.maxAmmo) ? `${weapon.ammo}/${weapon.maxAmmo}` : weapon.ammo}` : null);
    const left = hasHealth || hasArmor || hasScore;
    const right = hasWeapon || hasReload || hasAmmo;
    setDisplay(this.vitalsEl, left ? 'flex' : 'none');
    setDisplay(this.weaponEl, right ? 'flex' : 'none');
    setDisplay(this.statsEl, !suppressed && (left || right) ? 'flex' : 'none');
  }

  buildStars() {
    this.starsEl = document.createElement('div');
    Object.assign(this.starsEl.style, {
      position: 'fixed',
      top: '12px',
      right: '14px',
      display: 'none', // hidden entirely at 0 stars
      gap: '3px',
      zIndex: '15',
      fontSize: '22px',
      lineHeight: '1',
      textShadow: '0 1px 4px rgba(0, 0, 0, 0.8)',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    this.starEls = [];
    for (let i = 0; i < 5; i += 1) {
      const star = document.createElement('span');
      star.textContent = '★';
      star.style.opacity = '0.25';
      star.style.color = '#cfe3ff';
      this.starsEl.appendChild(star);
      this.starEls.push(star);
    }
    document.body.appendChild(this.starsEl);
  }

  // wanted.level runs in OG-style half-star steps (0..10) — 2 levels per star
  setWanted(wanted) {
    const filled = Math.round((wanted?.level ?? 0) / 2);
    this.starsEl.style.display = filled > 0 ? 'flex' : 'none';
    for (let i = 0; i < this.starEls.length; i += 1) {
      const on = i < filled;
      this.starEls[i].style.opacity = on ? '1' : '0.25';
      this.starEls[i].style.color = on ? '#ffd24a' : '#cfe3ff';
      this.starEls[i].style.textShadow = on ? '0 0 10px rgba(255, 210, 74, 0.85)' : 'none';
    }
  }

  buildBanner() {
    this.bannerEl = document.createElement('div');
    Object.assign(this.bannerEl.style, {
      position: 'fixed',
      inset: '0',
      display: 'none', // hidden by default
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(6, 10, 18, 0.72)', // same dark fade family as #overlay
      color: '#e8f0ff',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      zIndex: '25',
      pointerEvents: 'none',
      userSelect: 'none',
    });
    this.bannerTextEl = document.createElement('div');
    Object.assign(this.bannerTextEl.style, {
      fontSize: '64px',
      fontWeight: '700',
      letterSpacing: '0.4em',
      textIndent: '0.4em',
      textShadow: '0 2px 12px rgba(0, 0, 0, 0.8)',
    });
    this.bannerEl.appendChild(this.bannerTextEl);
    document.body.appendChild(this.bannerEl);
  }

  showBanner(text) {
    if (this.showing) return; // guard: ignore re-triggers while up
    this.showing = true;
    this.bannerTextEl.textContent = text;
    this.bannerEl.style.display = 'flex';
    this.bannerTimer = setTimeout(() => {
      this.respawn();
      this.bannerEl.style.display = 'none';
      this.showing = false;
      this.bannerTimer = null;
    }, 3000);
  }

  // OG: an arrest holds a 3s gameover delay before BUSTED shows, while death
  // cuts to WASTED immediately — we deviate and give death the same 3s banner
  // beat as arrest so the player actually gets to read the screen.
  busted() {
    this.showBanner('BUSTED');
  }

  wasted(hp0Time) {
    this.showBanner('WASTED');
  }

  dispose() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.countdownTimer = null;
    this.bannerTimer = null;
    for (const el of [this.statsEl, this.starsEl, this.countdownEl, this.bannerEl]) el?.remove?.();
    this.statsEl = this.starsEl = this.countdownEl = this.bannerEl = null;
    this.starEls = [];
  }

  respawn() {
    this.send([
      { op: 'carexit', by: this.presenceId },
      { op: 'set', id: this.presenceId, component: 'health', value: { hp: 100, max: 100 } },
      { op: 'set', id: this.presenceId, component: 'wanted', value: null },
      { op: 'set', id: this.presenceId, component: 'arrest', value: null },
      {
        op: 'set',
        id: this.presenceId,
        component: 'warp',
        value: {
          position: this.player.spawnPose?.position ?? [0, 2, 22],
          yaw: this.player.spawnPose?.yaw ?? 0,
          fade: 0.6,
        },
      },
    ]);
  }
}
