// The wanted stars + busted/wasted flow — GTA's read on "you got caught".
// Builds its own DOM (fixed elements appended to <body>) rather than reusing
// index.html markup, so it stays a drop-in kernel object like weapons/panel.

export class Hud {
  constructor({ presenceId, send, player }) {
    this.presenceId = presenceId;
    this.send = send;
    this.player = player;
    this.showing = false; // banner guard: not re-triggerable while up
    this.buildStars();
    this.buildBanner();
    this.buildCountdown();
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
    setInterval(() => this.renderCountdown(), 250);
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
    setTimeout(() => {
      this.respawn();
      this.bannerEl.style.display = 'none';
      this.showing = false;
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
