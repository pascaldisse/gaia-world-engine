import * as THREE from 'three/webgpu';

// Positional, fully synthesized audio — sounds are component data, not files.
export class AudioEngine {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    document.addEventListener('click', () => {
      const ctx = this.listener.context;
      if (ctx.state === 'suspended') ctx.resume();
    });
  }

  blip(freq = 740, level = 0.16) {
    const ctx = this.listener.context;
    if (ctx.state !== 'running') return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(level, ctx.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  }

  attach(group, spec) {
    const ctx = this.listener.context;
    const audio = new THREE.PositionalAudio(this.listener);
    audio.setRefDistance(spec.refDistance ?? 4);
    group.add(audio);

    const nodes = [];
    const timers = [];
    const level = spec.level ?? 0.25;

    if (spec.kind === 'hum') {
      const osc1 = ctx.createOscillator();
      osc1.type = spec.wave ?? 'sine';
      osc1.frequency.value = spec.freq ?? 110;
      const osc2 = ctx.createOscillator();
      osc2.type = spec.wave ?? 'sine';
      osc2.frequency.value = (spec.freq ?? 110) * 1.006;
      const gain = ctx.createGain();
      gain.gain.value = level;
      osc1.connect(gain);
      osc2.connect(gain);
      osc1.start();
      osc2.start();
      audio.setNodeSource(gain);
      nodes.push(osc1, osc2, gain);
    } else if (spec.kind === 'chime') {
      const gain = ctx.createGain();
      gain.gain.value = 1;
      audio.setNodeSource(gain);
      nodes.push(gain);
      const notes = spec.notes ?? [523.25, 659.25, 783.99];
      let step = 0;
      const ring = () => {
        if (ctx.state !== 'running') return;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = notes[step % notes.length];
        step++;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, ctx.currentTime);
        env.gain.linearRampToValueAtTime(level, ctx.currentTime + 0.02);
        env.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.8);
        osc.connect(env);
        env.connect(gain);
        osc.start();
        osc.stop(ctx.currentTime + 2);
      };
      timers.push(setInterval(ring, (spec.interval ?? 2.5) * 1000));
    }

    return {
      dispose: () => {
        timers.forEach(clearInterval);
        for (const node of nodes) {
          try {
            node.stop?.();
          } catch {
            // already stopped
          }
          node.disconnect();
        }
        group.remove(audio);
      },
    };
  }
}
