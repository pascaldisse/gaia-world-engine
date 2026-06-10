import * as THREE from 'three/webgpu';

const SERVER = `http://${location.hostname}:8420`;

// Fully data-driven audio: synth patches (layered noise/osc → filter → LFO →
// reverb send), sample files served from world/assets/, world buses (master →
// compressor, generated convolver reverb), positional or ambient, plus
// one-shot SFX and thunder. Sounds are documents; nothing is hardcoded.
export class AudioEngine {
  constructor(camera) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    this.buffers = new Map();
    this.master = null;
    document.addEventListener('click', () => {
      const ctx = this.listener.context;
      if (ctx.state === 'suspended') ctx.resume();
      this.ensureGraph();
    });
  }

  ensureGraph() {
    if (this.master) return;
    const ctx = this.listener.context;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -22;
    this.compressor.ratio.value = 6;
    // everything — including positional audio — routes master → compressor
    this.listener.gain.disconnect();
    this.listener.gain.connect(this.master);
    this.master.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    const ir = ctx.createBuffer(2, ctx.sampleRate * 3.2, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.6);
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.5;
    this.reverb.connect(this.reverbGain);
    this.reverbGain.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;
  }

  applyBus({ level, reverb, compressor } = {}) {
    this.ensureGraph();
    if (level !== undefined) this.master.gain.value = level;
    if (reverb !== undefined) this.reverbGain.gain.value = reverb;
    if (compressor?.threshold !== undefined) this.compressor.threshold.value = compressor.threshold;
    if (compressor?.ratio !== undefined) this.compressor.ratio.value = compressor.ratio;
  }

  loadBuffer(url) {
    const full = /^https?:/.test(url) ? url : `${SERVER}/${url}`;
    if (!this.buffers.has(full)) {
      this.buffers.set(
        full,
        fetch(full)
          .then((res) => res.arrayBuffer())
          .then((buf) => this.listener.context.decodeAudioData(buf))
          .catch((err) => {
            console.warn(`[gaia] sample failed: ${url}`, err);
            return null;
          }),
      );
    }
    return this.buffers.get(full);
  }

  attach(group, spec) {
    this.ensureGraph();
    const ctx = this.listener.context;

    // ambient sounds get a zone gain so the current zone's mood can fade
    // them in and out (positional sounds attenuate by distance on their own)
    const makeFade = (gainNode) => (mul, seconds = 1.5) => {
      const g = gainNode.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(mul, ctx.currentTime + Math.max(0.01, seconds));
    };

    if (spec.kind === 'sample') {
      const audio = spec.ambient ? new THREE.Audio(this.listener) : new THREE.PositionalAudio(this.listener);
      if (!spec.ambient) {
        audio.setRefDistance(spec.refDistance ?? 4);
        group.add(audio);
      }
      let disposed = false;
      this.loadBuffer(spec.url ?? '').then((buffer) => {
        if (disposed || !buffer) return;
        audio.setBuffer(buffer);
        audio.setLoop(spec.loop ?? true);
        audio.setVolume(spec.level ?? 0.6);
        audio.setPlaybackRate(spec.rate ?? 1);
        audio.play();
      });
      return {
        ambient: !!spec.ambient,
        fade: spec.ambient ? (mul, seconds = 1.5) => audio.gain && makeFade(audio.gain)(mul, seconds) : null,
        dispose: () => {
          disposed = true;
          try {
            if (audio.isPlaying) audio.stop();
          } catch {
            // not started yet
          }
          group.remove(audio);
        },
      };
    }

    const nodes = [];
    const timers = [];
    let sink;
    let audio = null;
    let zoneGain = null;
    if (spec.ambient) {
      sink = ctx.createGain();
      zoneGain = ctx.createGain();
      sink.connect(zoneGain);
      zoneGain.connect(this.master);
      nodes.push(sink, zoneGain);
    } else {
      audio = new THREE.PositionalAudio(this.listener);
      audio.setRefDistance(spec.refDistance ?? 4);
      group.add(audio);
      sink = ctx.createGain();
      audio.setNodeSource(sink);
    }
    const level = spec.level ?? 0.25;

    if (spec.kind === 'hum') {
      this.buildLayer({ source: spec.wave ?? 'sine', freq: spec.freq ?? 110, gain: level }, sink, nodes);
      this.buildLayer({ source: spec.wave ?? 'sine', freq: (spec.freq ?? 110) * 1.006, gain: level }, sink, nodes);
    } else if (spec.kind === 'chime') {
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
        env.connect(sink);
        osc.start();
        osc.stop(ctx.currentTime + 2);
      };
      timers.push(setInterval(ring, (spec.interval ?? 2.5) * 1000));
    } else if (spec.kind === 'patch') {
      for (const layer of spec.layers ?? []) this.buildLayer(layer, sink, nodes);
    }

    return {
      ambient: !!spec.ambient,
      fade: zoneGain ? makeFade(zoneGain) : null,
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
        if (audio) group.remove(audio);
      },
    };
  }

  buildLayer(layer, out, nodes) {
    const ctx = this.listener.context;
    let src;
    if ((layer.source ?? 'sine') === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
    } else {
      src = ctx.createOscillator();
      src.type = layer.source ?? 'sine';
      src.frequency.value = layer.freq ?? 220;
      if (layer.detune) src.detune.value = layer.detune;
    }
    let chain = src;
    let filter = null;
    if (layer.filter) {
      filter = ctx.createBiquadFilter();
      filter.type = layer.filter.type ?? 'lowpass';
      filter.frequency.value = layer.filter.freq ?? 800;
      filter.Q.value = layer.filter.Q ?? 0.7;
      chain.connect(filter);
      chain = filter;
    }
    const gain = ctx.createGain();
    gain.gain.value = layer.gain ?? 0.2;
    chain.connect(gain);
    gain.connect(out);
    if (layer.reverb) {
      const tap = ctx.createGain();
      tap.gain.value = layer.reverb;
      gain.connect(tap);
      tap.connect(this.reverb);
      nodes.push(tap);
    }
    if (layer.lfo) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = layer.lfo.rate ?? 0.2;
      const depth = ctx.createGain();
      depth.gain.value = layer.lfo.depth ?? 0.05;
      lfo.connect(depth);
      const target =
        layer.lfo.target === 'freq' && src.frequency
          ? src.frequency
          : layer.lfo.target === 'filter' && filter
            ? filter.frequency
            : gain.gain;
      depth.connect(target);
      lfo.start();
      nodes.push(lfo, depth);
    }
    src.start();
    nodes.push(src, gain);
    if (filter) nodes.push(filter);
  }

  // one-shot synth burst, optionally positional at a group
  oneShot(spec = {}, group = null) {
    this.ensureGraph();
    const ctx = this.listener.context;
    if (ctx.state !== 'running') return;
    let out = this.master;
    let audio = null;
    if (group) {
      audio = new THREE.PositionalAudio(this.listener);
      audio.setRefDistance(spec.refDistance ?? 5);
      group.add(audio);
      out = ctx.createGain();
      audio.setNodeSource(out);
    }
    const t0 = ctx.currentTime + (spec.delay ?? 0);
    const attack = spec.attack ?? 0.01;
    const decay = spec.decay ?? 0.6;
    let src;
    if (spec.wave === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
    } else {
      src = ctx.createOscillator();
      src.type = spec.wave ?? 'sine';
      src.frequency.setValueAtTime(spec.freq ?? 440, t0);
      if (spec.freqEnd) src.frequency.exponentialRampToValueAtTime(spec.freqEnd, t0 + decay);
    }
    let chain = src;
    if (spec.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(spec.lowpass, t0);
      if (spec.sweep) lp.frequency.exponentialRampToValueAtTime(spec.sweep, t0 + decay);
      chain.connect(lp);
      chain = lp;
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(spec.level ?? 0.3, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    chain.connect(env);
    env.connect(out);
    const tap = ctx.createGain();
    tap.gain.value = spec.reverb ?? 0.3;
    env.connect(tap);
    tap.connect(this.reverb);
    src.start(t0);
    src.stop(t0 + attack + decay + 0.5);
    if (audio) setTimeout(() => group.remove(audio), ((spec.delay ?? 0) + attack + decay + 1) * 1000);
  }

  blip(freq = 740, level = 0.16) {
    this.oneShot({ freq, level, attack: 0.015, decay: 0.5, reverb: 0.15 });
  }

  splash(level = 1) {
    this.oneShot({ wave: 'noise', lowpass: 1400, sweep: 220, attack: 0.02, decay: 0.9, level: 0.4 * level, reverb: 0.4 });
    this.oneShot({ freq: 180, freqEnd: 60, attack: 0.01, decay: 0.35, level: 0.18 * level, reverb: 0.2 });
  }

  thunder(intensity = 0.7, delay = 1.6) {
    this.ensureGraph();
    const ctx = this.listener.context;
    if (ctx.state !== 'running') return;
    this.oneShot({
      wave: 'noise',
      lowpass: 900,
      sweep: 48,
      attack: 0.06,
      decay: 3.2 + intensity * 2,
      level: 0.5 * intensity,
      reverb: 0.8,
      delay,
    });
    this.oneShot({
      freq: 46,
      freqEnd: 26,
      attack: 0.05,
      decay: 1.5,
      level: 0.22 * intensity,
      reverb: 0.3,
      delay,
    });
  }
}
