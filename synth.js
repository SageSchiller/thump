// Thump synth library: original sounds rendered offline with the Web Audio API.
// Every sound is a render function that returns an AudioBuffer. Pitched sounds
// are tuned to C so the Pitch control and Notes mode land on real notes.
// Tempo sounds (wobbles, risers) are rendered to the current BPM.
(function () {
  'use strict';
  let SR = 48000;
  const C2 = 65.406, C3 = 130.81, C4 = 261.63;
  const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const curves = new Map();
  function tanhCurve(k) {
    const key = 't' + k;
    if (!curves.has(key)) {
      const n = 2048, c = new Float32Array(n), norm = Math.tanh(k);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
      curves.set(key, c);
    }
    return curves.get(key);
  }
  function crushCurve(steps) {
    const key = 'c' + steps;
    if (!curves.has(key)) {
      const n = 4096, c = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.round(x * steps) / steps; }
      curves.set(key, c);
    }
    return curves.get(key);
  }

  // ---- graph helpers (all take an OfflineAudioContext) ----
  const H = {
    gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; },
    filter(ctx, type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; },
    drive(ctx, k) { const w = ctx.createWaveShaper(); w.curve = tanhCurve(k); w.oversample = '4x'; return w; },
    crush(ctx, steps) { const w = ctx.createWaveShaper(); w.curve = crushCurve(steps); return w; },
    osc(ctx, type, f, t0, t1) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t0); o.stop(t1); return o; },
    noise(ctx, t0, sec, seed = 7) {
      const len = Math.max(1, Math.ceil(sec * ctx.sampleRate));
      const b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0), r = rng(seed);
      for (let i = 0; i < len; i++) d[i] = r() * 2 - 1;
      const s = ctx.createBufferSource(); s.buffer = b; s.start(t0); return s;
    },
    // Envelope: points = [[time, value], ...]; values above 0 ramp exponentially.
    env(param, pts) {
      param.setValueAtTime(pts[0][1], pts[0][0]);
      for (let i = 1; i < pts.length; i++) {
        const [t, v] = pts[i];
        if (v <= 0.0001 || pts[i - 1][1] <= 0.0001) param.linearRampToValueAtTime(Math.max(v, 0), t);
        else param.exponentialRampToValueAtTime(v, t);
      }
    },
    perc(ctx, attack, decay, peak = 1, t = 0) {
      const g = ctx.createGain();
      H.env(g.gain, [[t, 0], [t + attack, peak], [t + attack + decay, 0.0005], [t + attack + decay + 0.01, 0]]);
      return g;
    },
    // Fill an AudioParam with fn(time) sampled at 400 points per second.
    curve(param, t0, sec, fn) {
      const n = Math.max(2, Math.ceil(sec * 400)), c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * sec);
      param.setValueCurveAtTime(c, t0, sec);
    },
    chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; },
  };

  async function offline(sec, build) {
    const ctx = new OfflineAudioContext(1, Math.ceil(sec * SR), SR);
    const out = ctx.createGain();
    out.connect(ctx.destination);
    build(ctx, out);
    return ctx.startRendering();
  }

  function direct(sec, fn) {
    const len = Math.ceil(sec * SR), b = new AudioBuffer({ length: len, sampleRate: SR, numberOfChannels: 1 });
    const d = b.getChannelData(0);
    fn(d, SR);
    return b;
  }

  function finish(buf, { loopSec = 0, reverse = false, xfSec = 0.04 } = {}) {
    let d = buf.getChannelData(0);
    if (loopSec) {
      const n = Math.round(loopSec * SR), xf = Math.min(d.length - n, Math.round(xfSec * SR));
      const out = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 1 });
      const o = out.getChannelData(0);
      o.set(d.subarray(0, n));
      for (let i = 0; i < xf; i++) {
        const a = i / xf;
        o[i] = d[i] * Math.sin(a * Math.PI / 2) + d[n + i] * Math.cos(a * Math.PI / 2);
      }
      buf = out; d = o;
    }
    if (reverse) d.reverse();
    let peak = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; if (v !== v) d[i] = 0; }
    if (peak > 0.0001) { const s = 0.89 / peak; for (let i = 0; i < d.length; i++) d[i] *= s; }
    if (!loopSec) {
      const f = Math.min(d.length, Math.round(0.004 * SR));
      for (let i = 0; i < f; i++) d[d.length - 1 - i] *= i / f;
    }
    return buf;
  }

  // ---- building blocks ----
  function kick(ctx, out, o) {
    const { t = 0, f0 = 160, f1 = 48, sweep = 0.06, decay = 0.5, click = 0.3, drive = 2, level = 1 } = o;
    const s = H.osc(ctx, 'sine', f0, t, t + decay + 0.1);
    H.env(s.frequency, [[t, f0], [t + sweep, f1], [t + decay, f1 * 0.85]]);
    const g = H.perc(ctx, 0.002, decay, level, t);
    const last = drive ? H.chain(s, g, H.drive(ctx, drive)) : H.chain(s, g);
    last.connect(out);
    if (click) {
      H.chain(H.noise(ctx, t, 0.03, 3), H.filter(ctx, 'highpass', 1800), H.perc(ctx, 0.0005, 0.012, click, t), out);
    }
  }
  function metal(ctx, out, { t = 0, decay = 0.08, hp = 7000, level = 1, base = 1 }) {
    const sum = H.gain(ctx, 0.25);
    HAT_FREQS.forEach(f => H.osc(ctx, 'square', f * base, t, t + decay + 0.2).connect(sum));
    H.chain(sum, H.filter(ctx, 'bandpass', 10000, 0.9), H.filter(ctx, 'highpass', hp), H.perc(ctx, 0.001, decay, level, t), out);
  }
  function snareBody(ctx, out, { t = 0, f = 190, decay = 0.12, level = 0.8 }) {
    const o = H.osc(ctx, 'triangle', f * 1.3, t, t + decay + 0.1);
    H.env(o.frequency, [[t, f * 1.3], [t + 0.03, f]]);
    H.chain(o, H.perc(ctx, 0.001, decay, level, t), out);
  }
  function noiseHit(ctx, out, { t = 0, decay = 0.2, type = 'bandpass', f = 3000, q = 0.8, level = 1, seed = 11, attack = 0.001 }) {
    H.chain(H.noise(ctx, t, decay + attack + 0.05, seed), H.filter(ctx, type, f, q), H.perc(ctx, attack, decay, level, t), out);
  }
  function saws(ctx, dest, f, t0, t1, cents = [-8, 8], type = 'sawtooth', level = 0.4) {
    return cents.map(c => {
      const o = H.osc(ctx, type, f * Math.pow(2, c / 1200), t0, t1);
      H.chain(o, H.gain(ctx, level), dest);
      return o;
    });
  }
  const wub = (phase) => (1 - Math.cos(2 * Math.PI * phase)) / 2;

  // ---- the library ----
  const S = [];
  const def = (id, name, cat, opts, render) => S.push(Object.assign({ id: 'syn:' + id, name, cat, pack: 'synth', render }, opts));
  const spb = bpm => 60 / bpm;

  // Kicks
  def('dub-kick', 'Dub kick', 'kick', {}, () => offline(0.7, (c, o) => kick(c, o, { f0: 190, f1: 50, sweep: 0.05, decay: 0.55, click: 0.35, drive: 4 })).then(b => finish(b)));
  def('sub-boom', 'Sub boom', 'kick', {}, () => offline(1.9, (c, o) => kick(c, o, { f0: 140, f1: 44, sweep: 0.09, decay: 1.7, click: 0.15, drive: 2.5 })).then(b => finish(b)));
  def('punch-kick', 'Punch kick', 'kick', {}, () => offline(0.45, (c, o) => kick(c, o, { f0: 240, f1: 56, sweep: 0.028, decay: 0.32, click: 0.5, drive: 3 })).then(b => finish(b)));
  def('dist-kick', 'Distorted kick', 'kick', {}, () => offline(0.8, (c, o) => {
    const lp = H.filter(c, 'lowpass', 5000); lp.connect(o);
    kick(c, lp, { f0: 320, f1: 52, sweep: 0.06, decay: 0.65, click: 0.4, drive: 28 });
  }).then(b => finish(b)));
  def('gabber-kick', 'Gabber kick', 'kick', {}, () => offline(0.5, (c, o) => {
    const pk = H.filter(c, 'peaking', 180, 2); pk.gain.value = 9;
    H.chain(pk, H.drive(c, 60), H.filter(c, 'lowpass', 7000), o);
    kick(c, pk, { f0: 420, f1: 62, sweep: 0.035, decay: 0.38, click: 0.6, drive: 0 });
  }).then(b => finish(b)));

  // Snares and claps
  def('dub-snare', 'Dub snare', 'snare', {}, () => offline(0.9, (c, o) => {
    const bus = H.gain(c); H.chain(bus, H.drive(c, 3), o);
    snareBody(c, bus, { f: 185, decay: 0.16, level: 0.9 });
    noiseHit(c, bus, { decay: 0.32, f: 3200, q: 0.6, level: 1 });
    noiseHit(c, bus, { decay: 0.75, type: 'lowpass', f: 5000, level: 0.25, seed: 5, attack: 0.01 });
  }).then(b => finish(b)));
  def('crack-snare', 'Crack snare', 'snare', {}, () => offline(0.3, (c, o) => {
    const bus = H.gain(c); H.chain(bus, H.drive(c, 5), o);
    snareBody(c, bus, { f: 330, decay: 0.05, level: 0.7 });
    noiseHit(c, bus, { decay: 0.13, type: 'highpass', f: 2200, level: 1 });
  }).then(b => finish(b)));
  def('ind-snare', 'Industrial snare', 'snare', {}, () => offline(0.5, (c, o) => {
    const bus = H.gain(c); H.chain(bus, H.crush(c, 6), H.drive(c, 6), H.filter(c, 'highpass', 180), o);
    noiseHit(c, bus, { decay: 0.26, f: 2400, q: 0.5, level: 1 });
    [540, 845, 1210].forEach(f => H.chain(H.osc(c, 'square', f, 0, 0.4), H.perc(c, 0.001, 0.18, 0.18), bus));
    snareBody(c, bus, { f: 160, decay: 0.09, level: 0.8 });
  }).then(b => finish(b)));
  def('gated-snare', 'Gated snare', 'snare', {}, () => offline(0.45, (c, o) => {
    const bus = H.gain(c); const gate = c.createGain();
    H.env(gate.gain, [[0, 1], [0.27, 1], [0.3, 0]]);
    H.chain(bus, gate, H.drive(c, 2), o);
    snareBody(c, bus, { f: 200, decay: 0.12, level: 0.8 });
    noiseHit(c, bus, { decay: 0.5, f: 2600, q: 0.5, level: 0.9, attack: 0.002 });
  }).then(b => finish(b)));
  def('clap-stack', 'Clap stack', 'clap', {}, () => offline(0.6, (c, o) => {
    const bus = H.gain(c); H.chain(bus, H.filter(c, 'bandpass', 1300, 1.2), H.drive(c, 2), o);
    [0, 0.011, 0.023, 0.036].forEach((t, i) => noiseHit(c, bus, { t, decay: 0.012, type: 'highpass', f: 600, seed: 20 + i }));
    noiseHit(c, bus, { t: 0.04, decay: 0.32, type: 'highpass', f: 700, level: 0.7, seed: 31 });
  }).then(b => finish(b)));
  def('snap', 'Finger snap', 'clap', {}, () => offline(0.25, (c, o) => {
    noiseHit(c, o, { decay: 0.06, f: 2600, q: 2, level: 1 });
    H.chain(H.osc(c, 'sine', 1800, 0, 0.05), H.perc(c, 0.0005, 0.01, 0.4), o);
  }).then(b => finish(b)));

  // Hats and cymbals
  def('hat-closed', 'Metal hat', 'hat', {}, () => offline(0.15, (c, o) => metal(c, o, { decay: 0.055 })).then(b => finish(b)));
  def('hat-open', 'Metal open hat', 'hat', {}, () => offline(0.6, (c, o) => metal(c, o, { decay: 0.42 })).then(b => finish(b)));
  def('tick-hat', 'Tick hat', 'hat', {}, () => offline(0.06, (c, o) => noiseHit(c, o, { decay: 0.022, type: 'highpass', f: 8500 })).then(b => finish(b)));
  def('shaker', 'Shaker', 'perc', {}, () => offline(0.2, (c, o) => noiseHit(c, o, { decay: 0.09, f: 6500, q: 1.2, attack: 0.025 })).then(b => finish(b)));
  function crash(c, o) {
    noiseHit(c, o, { decay: 1.9, type: 'highpass', f: 4500, level: 0.8, attack: 0.002 });
    metal(c, o, { decay: 1.4, hp: 3500, level: 0.6, base: 1.6 });
  }
  def('crash-wash', 'Crash wash', 'cymbal', {}, () => offline(2.1, crash).then(b => finish(b)));
  def('rev-crash', 'Reverse crash', 'cymbal', {}, () => offline(1.6, crash).then(b => finish(b, { reverse: true })));

  // Metal and noise (industrial)
  function fmHit(c, o, { t = 0, f, ratio, index, decay, level = 1 }) {
    const car = H.osc(c, 'sine', f, t, t + decay + 0.1), mod = H.osc(c, 'sine', f * ratio, t, t + decay + 0.1);
    const mg = c.createGain(); H.env(mg.gain, [[t, index], [t + decay, 1]]);
    H.chain(mod, mg, car.frequency);
    H.chain(car, H.perc(c, 0.001, decay, level, t), o);
  }
  def('clang', 'Clang', 'metal', {}, () => offline(1.4, (c, o) => {
    const bus = H.gain(c); H.chain(bus, H.filter(c, 'highpass', 150), H.drive(c, 2), o);
    fmHit(c, bus, { f: 180, ratio: 2.76, index: 900, decay: 1.1 });
    fmHit(c, bus, { f: 451, ratio: 1.41, index: 600, decay: 0.7, level: 0.6 });
  }).then(b => finish(b)));
  def('anvil', 'Anvil', 'metal', {}, () => offline(1.2, (c, o) => {
    [[523, 1.0, 1], [1371, 0.7, 0.6], [2210, 0.5, 0.45], [3277, 0.35, 0.3]].forEach(([f, d, l]) =>
      H.chain(H.osc(c, 'sine', f, 0, d + 0.1), H.perc(c, 0.0008, d, l), o));
    noiseHit(c, o, { decay: 0.008, type: 'highpass', f: 3000, level: 0.8 });
  }).then(b => finish(b)));
  def('pipe', 'Pipe hit', 'metal', {}, () => offline(0.9, (c, o) => {
    const ex = H.chain(H.noise(c, 0, 0.01, 9), H.perc(c, 0.0005, 0.004, 1));
    [[380, 40], [1041, 35], [2030, 25]].forEach(([f, q]) => H.chain(ex, H.filter(c, 'bandpass', f, q), H.gain(c, 18), o));
    H.chain(H.osc(c, 'sine', 380, 0, 0.8), H.perc(c, 0.001, 0.7, 0.35), o);
  }).then(b => finish(b)));
  def('stomp', 'Machine stomp', 'metal', {}, () => offline(0.45, (c, o) => {
    kick(c, o, { f0: 110, f1: 42, sweep: 0.05, decay: 0.28, click: 0.2, drive: 6 });
    noiseHit(c, o, { decay: 0.08, type: 'lowpass', f: 2000, level: 0.6 });
    fmHit(c, o, { t: 0.012, f: 300, ratio: 2.3, index: 700, decay: 0.16, level: 0.4 });
  }).then(b => finish(b)));
  def('grinder', 'Grinder', 'metal', {}, () => offline(1.3, (c, o) => {
    const saw = H.osc(c, 'sawtooth', 55, 0, 1.3), ring = c.createGain(); ring.gain.value = 0;
    H.noise(c, 0, 1.3, 4).connect(ring.gain);
    const bp = H.filter(c, 'bandpass', 400, 3);
    H.env(bp.frequency, [[0, 400], [0.5, 3200], [1.2, 700]]);
    H.chain(saw, ring, bp, H.drive(c, 8), H.perc(c, 0.02, 1.15, 1), o);
  }).then(b => finish(b)));
  def('static', 'Static burst', 'metal', {}, () => Promise.resolve(finish(direct(0.55, (d, sr) => {
    const r = rng(77); let hold = 0, v = 0, gate = 1;
    for (let i = 0; i < d.length; i++) {
      if (hold-- <= 0) { v = r() * 2 - 1; hold = 1 + Math.floor(r() * 18); }
      if (i % Math.round(sr * 0.035) === 0) gate = r() > 0.3 ? 1 : 0.15;
      const env = Math.exp(-3.2 * i / sr);
      d[i] = Math.round(v * 5) / 5 * gate * env;
    }
  }))));
  def('steam', 'Steam hiss', 'metal', {}, () => offline(1.3, (c, o) => {
    const trem = c.createGain(); trem.gain.value = 0.8;
    const lfo = H.osc(c, 'sine', 17, 0, 1.3), depth = H.gain(c, 0.2); H.chain(lfo, depth, trem.gain);
    H.chain(H.noise(c, 0, 1.3, 12), H.filter(c, 'highpass', 2600), trem, H.perc(c, 0.05, 1.1, 1), o);
  }).then(b => finish(b)));
  def('scrape', 'Metal scrape', 'metal', {}, () => offline(1.2, (c, o) => {
    const dl = c.createDelay(0.05); dl.delayTime.value = 0.0023;
    const fb = H.gain(c, 0.86); dl.connect(fb); fb.connect(dl);
    const src = H.chain(H.noise(c, 0, 1.2, 15), H.filter(c, 'bandpass', 1800, 0.8), H.perc(c, 0.15, 0.9, 0.5));
    src.connect(dl); src.connect(o);
    H.chain(dl, H.filter(c, 'highpass', 300), o);
  }).then(b => finish(b)));

  // Bass (C2, loopable ones sustain while held)
  function wobbleBass(bpm, rate) {
    const bar = spb(bpm) * 4, sec = bar + 0.06, period = rate * spb(bpm);
    return offline(sec, (c, o) => {
      const lp = H.filter(c, 'lowpass', 300, 9);
      H.curve(lp.frequency, 0, sec, t => 90 * Math.pow(26, Math.pow(wub((t / period) % 1), 1.3)));
      saws(c, lp, C2, 0, sec, [-9, 9], 'sawtooth', 0.45);
      saws(c, lp, C2 * 2, 0, sec, [0], 'square', 0.2);
      H.chain(lp, H.drive(c, 6), H.filter(c, 'lowpass', 6500), o);
      H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, 0.5), o);
    }).then(b => finish(b, { loopSec: bar }));
  }
  const loopBass = { pitched: true, loop: true, hold: true, tempo: true };
  def('wobble', 'Wobble bass', 'bass', loopBass, bpm => wobbleBass(bpm, 0.5));
  def('wobble-slow', 'Slow wobble', 'bass', loopBass, bpm => wobbleBass(bpm, 1));
  def('wobble-fast', 'Triplet wobble', 'bass', loopBass, bpm => wobbleBass(bpm, 1 / 3));
  def('wobble-stutter', 'Stutter wobble', 'bass', loopBass, bpm => wobbleBass(bpm, 0.25));
  def('growl', 'Growl bass', 'bass', loopBass, bpm => {
    const bar = spb(bpm) * 4, sec = bar + 0.06, period = 0.5 * spb(bpm);
    return offline(sec, (c, o) => {
      const car = H.osc(c, 'sawtooth', C2, 0, sec), mod = H.osc(c, 'sine', C2 * 2, 0, sec), mg = c.createGain();
      H.curve(mg.gain, 0, sec, t => 20 + C2 * 7 * wub((t / period) % 1));
      H.chain(mod, mg, car.frequency);
      const f1 = H.filter(c, 'bandpass', 500, 5), f2 = H.filter(c, 'bandpass', 1200, 6), mix = H.gain(c);
      H.curve(f1.frequency, 0, sec, t => 300 + 600 * wub((t / period) % 1));
      H.curve(f2.frequency, 0, sec, t => 900 + 1500 * wub(((t / period) + 0.15) % 1));
      car.connect(f1); car.connect(f2); f1.connect(mix); f2.connect(mix);
      H.chain(car, H.filter(c, 'lowpass', 400), H.gain(c, 0.5), mix);
      H.chain(mix, H.drive(c, 12), H.filter(c, 'lowpass', 7500), o);
      H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, 0.45), o);
    }).then(b => finish(b, { loopSec: bar }));
  });
  def('reese', 'Reese bass', 'bass', loopBass, bpm => {
    const len = spb(bpm) * 8, sec = len + 0.06;
    return offline(sec, (c, o) => {
      const lp = H.filter(c, 'lowpass', 900, 1.6);
      H.curve(lp.frequency, 0, sec, t => 500 + 700 * wub((t / (spb(bpm) * 4)) % 1));
      saws(c, lp, C2, 0, sec, [-14, 0, 14], 'sawtooth', 0.35);
      H.chain(lp, H.drive(c, 3), o);
      H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, 0.35), o);
    }).then(b => finish(b, { loopSec: len }));
  });
  def('sub-bass', 'Sub bass', 'bass', { pitched: true, loop: true, hold: true }, () => {
    const len = Math.round(2 * C2) / C2;
    return offline(len + 0.06, (c, o) => {
      H.chain(H.osc(c, 'sine', C2, 0, len + 0.06), H.gain(c, 0.85), H.drive(c, 1.5), o);
      H.chain(H.osc(c, 'sine', C2 * 2, 0, len + 0.06), H.gain(c, 0.12), o);
    }).then(b => finish(b, { loopSec: len }));
  });
  def('pluck-bass', 'Pluck bass', 'bass', { pitched: true }, () => offline(0.7, (c, o) => {
    const lp = H.filter(c, 'lowpass', 3000, 5);
    H.env(lp.frequency, [[0, 3200], [0.28, 180]]);
    saws(c, lp, C2, 0, 0.7, [-7, 7], 'sawtooth', 0.45);
    H.chain(lp, H.perc(c, 0.002, 0.6, 1), H.drive(c, 3), o);
    H.chain(H.osc(c, 'sine', C2, 0, 0.7), H.perc(c, 0.002, 0.5, 0.5), o);
  }).then(b => finish(b)));
  def('808-bass', '808 bass', 'bass', { pitched: true }, () => offline(2.4, (c, o) => {
    const s = H.osc(c, 'sine', C2 * 2.2, 0, 2.4);
    H.env(s.frequency, [[0, C2 * 2.2], [0.06, C2], [2.3, C2 * 0.98]]);
    H.chain(s, H.perc(c, 0.002, 2.2, 1), H.drive(c, 3.5), o);
    H.chain(H.noise(c, 0, 0.02, 2), H.filter(c, 'highpass', 2000), H.perc(c, 0.0005, 0.008, 0.25), o);
  }).then(b => finish(b)));
  def('yoi-bass', 'Yoi bass', 'bass', { pitched: true }, () => offline(0.7, (c, o) => {
    const bp = H.filter(c, 'bandpass', 400, 7);
    H.env(bp.frequency, [[0, 350], [0.18, 1900], [0.55, 500]]);
    saws(c, bp, C3, 0, 0.7, [-6, 6], 'sawtooth', 0.5);
    H.chain(bp, H.gain(c, 3), H.drive(c, 9), H.perc(c, 0.005, 0.6, 1), o);
    H.chain(H.osc(c, 'sine', C2, 0, 0.7), H.perc(c, 0.005, 0.55, 0.4), o);
  }).then(b => finish(b)));

  // Stabs and keys (tuned to C)
  function chordStab(c, o, notes, { decay = 0.5, cutoff = 5000, floor = 500, type = 'sawtooth', drive = 2 } = {}) {
    const lp = H.filter(c, 'lowpass', cutoff, 3);
    H.env(lp.frequency, [[0, cutoff], [decay * 0.7, floor]]);
    notes.forEach(f => saws(c, lp, f, 0, decay + 0.1, [-10, 10], type, 0.22));
    H.chain(lp, H.perc(c, 0.003, decay, 1), H.drive(c, drive), o);
  }
  const semi = n => C3 * Math.pow(2, n / 12);
  def('dark-stab', 'Dark stab', 'stab', { pitched: true }, () => offline(0.65, (c, o) => chordStab(c, o, [semi(0), semi(3), semi(7), semi(12)])).then(b => finish(b)));
  def('rave-stab', 'Rave stab', 'stab', { pitched: true }, () => offline(0.45, (c, o) => chordStab(c, o, [semi(0), semi(7), semi(12), semi(19)], { decay: 0.35, cutoff: 7000, floor: 900, type: 'square', drive: 3 })).then(b => finish(b)));
  def('horn', 'Horn blast', 'stab', { pitched: true }, () => offline(1.1, (c, o) => {
    const lp = H.filter(c, 'lowpass', 2800, 1.2), g = c.createGain();
    H.env(g.gain, [[0, 0], [0.04, 1], [0.7, 0.85], [1.05, 0]]);
    [-14, -6, 0, 6, 14].forEach(ct => {
      const s = H.osc(c, 'sawtooth', C4 * Math.pow(2, ct / 1200), 0, 1.1);
      s.detune.setValueAtTime(-250, 0); s.detune.linearRampToValueAtTime(0, 0.06);
      s.detune.setValueAtTime(0, 0.78); s.detune.linearRampToValueAtTime(-900, 1.05);
      H.chain(s, H.gain(c, 0.2), lp);
    });
    H.chain(lp, g, H.drive(c, 2), o);
  }).then(b => finish(b)));
  def('bell', 'Glass bell', 'stab', { pitched: true }, () => offline(2.6, (c, o) => {
    fmHit(c, o, { f: C4 * 2, ratio: 3.5, index: 1400, decay: 2.4, level: 1 });
    fmHit(c, o, { f: C4 * 4, ratio: 1.0, index: 300, decay: 0.8, level: 0.25 });
  }).then(b => finish(b)));

  // FX
  def('riser', 'Riser (2 bars)', 'fx', { tempo: true }, bpm => {
    const sec = spb(bpm) * 8;
    return offline(sec, (c, o) => {
      const bp = H.filter(c, 'bandpass', 200, 3); H.env(bp.frequency, [[0, 200], [sec, 9000]]);
      const g = c.createGain(); H.env(g.gain, [[0, 0.02], [sec * 0.98, 1], [sec, 0]]);
      H.chain(H.noise(c, 0, sec, 21), bp, g, o);
      const s = H.osc(c, 'sawtooth', 110, 0, sec); H.env(s.frequency, [[0, 110], [sec, 1760]]);
      const g2 = c.createGain(); H.env(g2.gain, [[0, 0.01], [sec * 0.98, 0.35], [sec, 0]]);
      H.chain(s, H.filter(c, 'lowpass', 4000), g2, o);
    }).then(b => finish(b));
  });
  def('downsweep', 'Down sweep', 'fx', {}, () => offline(2.1, (c, o) => {
    const bp = H.filter(c, 'bandpass', 9000, 2.5); H.env(bp.frequency, [[0, 9000], [2, 150]]);
    H.chain(H.noise(c, 0, 2.1, 22), bp, H.perc(c, 0.01, 2, 1), o);
  }).then(b => finish(b)));
  function impact(c, o) {
    const bus = H.gain(c); H.chain(bus, H.drive(c, 4), o);
    kick(c, bus, { f0: 90, f1: 28, sweep: 1.1, decay: 2.6, click: 0.4, drive: 0 });
    const lp = H.filter(c, 'lowpass', 3500); H.env(lp.frequency, [[0, 3500], [1.5, 250]]);
    H.chain(H.noise(c, 0, 1.8, 23), lp, H.perc(c, 0.002, 1.6, 0.8), bus);
    fmHit(c, bus, { f: 140, ratio: 2.76, index: 500, decay: 0.5, level: 0.3 });
  }
  def('impact', 'Impact', 'fx', {}, () => offline(3, impact).then(b => finish(b)));
  def('sub-drop', 'Sub drop', 'fx', {}, () => offline(2.2, (c, o) => {
    const s = H.osc(c, 'sine', 120, 0, 2.2); H.env(s.frequency, [[0, 120], [1.8, 26]]);
    H.chain(s, H.perc(c, 0.005, 2.1, 1), H.drive(c, 2.5), o);
  }).then(b => finish(b)));
  def('zap', 'Laser zap', 'fx', {}, () => offline(0.8, (c, o) => {
    const s = H.osc(c, 'square', 2500, 0, 0.3); H.env(s.frequency, [[0, 2500], [0.22, 110]]);
    const d = c.createDelay(0.2); d.delayTime.value = 0.09; const fb = H.gain(c, 0.35);
    const src = H.chain(s, H.filter(c, 'lowpass', 6000), H.perc(c, 0.001, 0.24, 0.8));
    src.connect(o); src.connect(d); d.connect(fb); fb.connect(d); H.chain(d, H.gain(c, 0.6), o);
  }).then(b => finish(b)));
  def('siren', 'Siren', 'fx', {}, () => offline(3, (c, o) => {
    const s = H.osc(c, 'sawtooth', 700, 0, 3), lfo = H.osc(c, 'sine', 1.1, 0, 3), dep = H.gain(c, 180);
    H.chain(lfo, dep, s.frequency);
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.2, 1], [2.6, 1], [3, 0]]);
    H.chain(s, H.filter(c, 'bandpass', 1300, 1), H.drive(c, 4), g, o);
  }).then(b => finish(b)));
  def('crackle', 'Vinyl crackle', 'fx', { loop: true, hold: true }, () => Promise.resolve(finish(direct(4.06, (d, sr) => {
    const r = rng(99); let lp = 0;
    for (let i = 0; i < d.length; i++) {
      lp += 0.08 * ((r() * 2 - 1) - lp);
      d[i] = lp * 0.08;
      if (r() < 0.0009) { const amp = 0.3 + r() * 0.7, n = 6 + Math.floor(r() * 30); for (let j = 0; j < n && i + j < d.length; j++) d[i + j] += amp * (r() * 2 - 1) * (1 - j / n); }
    }
  }), { loopSec: 4 })));
  def('noise-burst', 'Noise burst', 'fx', {}, () => offline(0.35, (c, o) => {
    H.chain(H.noise(c, 0, 0.35, 24), H.crush(c, 4), H.filter(c, 'highpass', 500), H.perc(c, 0.001, 0.28, 1), o);
  }).then(b => finish(b)));
  def('glitch', 'Glitch blip', 'fx', {}, () => Promise.resolve(finish(direct(0.24, (d, sr) => {
    const r = rng(5); const seg = Math.round(sr * 0.02);
    for (let s = 0; s * seg < d.length; s++) {
      const f = 200 + Math.floor(r() * 12) * 250, on = r() > 0.25;
      for (let i = 0; i < seg && s * seg + i < d.length; i++) {
        const k = s * seg + i; d[k] = on ? (((k * f / sr) % 1) < 0.5 ? 0.6 : -0.6) : 0;
      }
    }
  }))));

  // ---- added in round two ----
  // Kicks
  def('hard-kick', 'Hardstyle kick', 'kick', {}, () => offline(0.75, (c, o) => {
    const pk = H.filter(c, 'peaking', 120, 1.5); pk.gain.value = 6;
    H.chain(pk, H.drive(c, 18), H.filter(c, 'lowpass', 3500), o);
    const s = H.osc(c, 'sine', 300, 0, 0.75);
    H.env(s.frequency, [[0, 300], [0.04, 70], [0.6, 48]]);
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.002, 1], [0.45, 0.6], [0.7, 0]]);
    H.chain(s, g, pk);
    noiseHit(c, pk, { decay: 0.01, type: 'highpass', f: 2000, level: 0.5 });
  }).then(b => finish(b)));
  def('tight-kick', 'Tight kick', 'kick', {}, () => offline(0.2, (c, o) => kick(c, o, { f0: 260, f1: 70, sweep: 0.02, decay: 0.13, click: 0.6, drive: 4 })).then(b => finish(b)));

  // Snares
  def('riddim-snare', 'Riddim snare', 'snare', {}, () => offline(0.4, (c, o) => {
    const bus = H.gain(c), pk = H.filter(c, 'peaking', 2500, 1); pk.gain.value = 8;
    H.chain(bus, pk, H.drive(c, 8), H.filter(c, 'highpass', 160), o);
    snareBody(c, bus, { f: 240, decay: 0.07, level: 1 });
    noiseHit(c, bus, { decay: 0.18, f: 4000, q: 0.5, level: 1 });
    [0, 0.008, 0.017].forEach((t, i) => noiseHit(c, bus, { t, decay: 0.01, type: 'highpass', f: 900, level: 0.6, seed: 40 + i }));
  }).then(b => finish(b)));
  def('rev-snare', 'Reverse snare', 'snare', {}, () => offline(1.3, (c, o) => {
    snareBody(c, o, { f: 190, decay: 0.15, level: 0.9 });
    noiseHit(c, o, { decay: 0.35, f: 3000, q: 0.6, level: 1 });
    noiseHit(c, o, { decay: 1.2, type: 'lowpass', f: 6000, level: 0.35, seed: 6, attack: 0.01 });
  }).then(b => finish(b, { reverse: true })));
  def('rim-click', 'Rim click', 'snare', {}, () => offline(0.12, (c, o) => {
    H.chain(H.osc(c, 'triangle', 1700, 0, 0.1), H.perc(c, 0.0005, 0.03, 0.8), o);
    H.chain(H.osc(c, 'sine', 520, 0, 0.1), H.perc(c, 0.0005, 0.05, 0.5), o);
    noiseHit(c, o, { decay: 0.006, type: 'highpass', f: 3000, level: 0.6 });
  }).then(b => finish(b)));

  // Hats and cymbals
  def('trap-hat', 'Trap hat', 'hat', {}, () => offline(0.08, (c, o) => metal(c, o, { decay: 0.028, hp: 8500, base: 1.3 })).then(b => finish(b)));
  def('ride-ping', 'Metal ride', 'cymbal', {}, () => offline(2.2, (c, o) => {
    metal(c, o, { decay: 1.8, hp: 3000, level: 0.5, base: 2.1 });
    fmHit(c, o, { f: 3100, ratio: 1.47, index: 1500, decay: 1.5, level: 0.3 });
    noiseHit(c, o, { decay: 0.02, type: 'highpass', f: 6000, level: 0.5 });
  }).then(b => finish(b)));

  // Toms and percussion
  def('synth-tom', 'Synth tom', 'tom', {}, () => offline(0.6, (c, o) => {
    const s = H.osc(c, 'sine', 220, 0, 0.6); H.env(s.frequency, [[0, 220], [0.35, 85]]);
    H.chain(s, H.perc(c, 0.002, 0.5, 1), H.drive(c, 2), o);
    noiseHit(c, o, { decay: 0.02, f: 1500, level: 0.3 });
  }).then(b => finish(b)));
  def('laser-tom', 'Laser tom', 'tom', {}, () => offline(0.5, (c, o) => {
    const s = H.osc(c, 'triangle', 900, 0, 0.5); H.env(s.frequency, [[0, 900], [0.3, 90]]);
    H.chain(s, H.perc(c, 0.001, 0.42, 1), o);
  }).then(b => finish(b)));
  def('dist-tom', 'Distorted tom', 'tom', {}, () => offline(0.7, (c, o) => {
    const s = H.osc(c, 'sine', 170, 0, 0.7); H.env(s.frequency, [[0, 170], [0.4, 95]]);
    H.chain(s, H.perc(c, 0.002, 0.6, 1), H.drive(c, 14), H.filter(c, 'lowpass', 3000), o);
    noiseHit(c, o, { decay: 0.05, f: 1200, level: 0.4 });
  }).then(b => finish(b)));
  def('data-click', 'Data click', 'perc', {}, () => Promise.resolve(finish(direct(0.03, d => {
    for (let i = 0; i < d.length; i++) d[i] = (i < 12 ? (i % 2 ? -1 : 1) : 0) + Math.exp(-i / 60) * Math.sin(i * 0.9) * 0.6;
  }))));

  // Metal and noise
  def('hammer', 'Hammer', 'metal', {}, () => offline(0.9, (c, o) => {
    kick(c, o, { f0: 160, f1: 70, sweep: 0.02, decay: 0.12, click: 0.5, drive: 4, level: 0.8 });
    [[2400, 0.5, 0.5], [3620, 0.35, 0.35], [5130, 0.25, 0.25]].forEach(([f, d, l]) =>
      H.chain(H.osc(c, 'sine', f, 0, d + 0.1), H.perc(c, 0.0005, d, l), o));
  }).then(b => finish(b)));
  def('chain', 'Chain rattle', 'metal', {}, () => offline(0.8, (c, o) => {
    const r = rng(31);
    for (let k = 0; k < 14; k++) {
      const t = 0.02 + 0.55 * r() * Math.sqrt(r()), f = 2500 + r() * 4000;
      H.chain(H.osc(c, 'square', f, t, t + 0.07), H.filter(c, 'bandpass', f, 6), H.perc(c, 0.0005, 0.03 + r() * 0.03, 0.4 + r() * 0.6, t), o);
      noiseHit(c, o, { t, decay: 0.008, type: 'highpass', f: 4000, level: 0.3, seed: 50 + k });
    }
  }).then(b => finish(b)));
  def('sheet', 'Sheet metal', 'metal', {}, () => offline(2.2, (c, o) => {
    const ex = H.chain(H.noise(c, 0, 0.05, 61), H.perc(c, 0.001, 0.03, 1));
    [0.0031, 0.0047, 0.0071].forEach((dt, i) => {
      const d = c.createDelay(0.05); d.delayTime.value = dt;
      H.chain(H.osc(c, 'sine', 3 + i * 1.7, 0, 2.2), H.gain(c, dt * 0.08), d.delayTime);
      const fb = H.gain(c, 0.985); d.connect(fb); fb.connect(d);
      ex.connect(d);
      H.chain(d, H.filter(c, 'highpass', 400), H.gain(c, 0.4), o);
    });
    ex.connect(o);
  }).then(b => finish(b)));
  def('press', 'Hydraulic press', 'metal', {}, () => offline(1.6, (c, o) => {
    const lp = H.filter(c, 'lowpass', 200, 2); H.env(lp.frequency, [[0, 120], [0.9, 900], [1.0, 200]]);
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.85, 1], [1.0, 0]]);
    H.chain(H.noise(c, 0, 1.0, 62), lp, g, H.drive(c, 3), o);
    kick(c, o, { t: 0.95, f0: 120, f1: 45, sweep: 0.05, decay: 0.3, click: 0.4, drive: 5 });
    noiseHit(c, o, { t: 1.0, decay: 0.5, type: 'highpass', f: 3000, level: 0.5, attack: 0.02, seed: 63 });
  }).then(b => finish(b)));
  def('servo', 'Servo whine', 'metal', {}, () => offline(0.9, (c, o) => {
    const s = H.osc(c, 'sawtooth', 280, 0, 0.9); H.env(s.frequency, [[0, 280], [0.7, 900], [0.85, 860]]);
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.05, 0.8], [0.75, 0.8], [0.88, 0]]);
    H.chain(s, H.filter(c, 'bandpass', 1500, 2), g, H.drive(c, 3), o);
  }).then(b => finish(b)));
  def('radio', 'Radio static', 'metal', {}, () => offline(1.5, (c, o) => {
    const bp = H.filter(c, 'bandpass', 800, 4);
    H.curve(bp.frequency, 0, 1.5, t => 600 + 2500 * (0.5 + 0.5 * Math.sin(t * 9) * Math.sin(t * 2.3)));
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.05, 1], [1.3, 0.8], [1.5, 0]]);
    H.chain(H.noise(c, 0, 1.5, 70), H.crush(c, 8), bp, g, o);
  }).then(b => finish(b)));

  // Bass
  def('neuro', 'Neuro bass', 'bass', loopBass, bpm => {
    const bar = spb(bpm) * 4, sec = bar + 0.06, period = 0.5 * spb(bpm);
    return offline(sec, (c, o) => {
      const mix = H.gain(c), sum = H.gain(c);
      saws(c, mix, C2, 0, sec, [-12, -4, 4, 12], 'sawtooth', 0.3);
      const d = c.createDelay(0.02);
      H.curve(d.delayTime, 0, sec, t => 0.0007 + 0.006 * wub((t / period) % 1));
      const fb = H.gain(c, 0.7); d.connect(fb); fb.connect(d);
      mix.connect(d); mix.connect(sum); d.connect(sum);
      const lp = H.filter(c, 'lowpass', 1200, 4);
      H.curve(lp.frequency, 0, sec, t => 400 + 3000 * wub(((t / period) + 0.25) % 1));
      H.chain(sum, lp, H.drive(c, 10), H.filter(c, 'lowpass', 7000), o);
      H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, 0.45), o);
    }).then(b => finish(b, { loopSec: bar }));
  });
  const VOWELS = [[570, 840], [730, 1090], [270, 2290], [530, 1840], [300, 870]];
  def('talk', 'Talking bass', 'bass', loopBass, bpm => {
    const bar = spb(bpm) * 4, sec = bar + 0.06, step = 0.5 * spb(bpm), order = [0, 1, 2, 1, 4, 1, 3, 1];
    const vowelAt = (t, k) => {
      const x = t / step, i = Math.floor(x), f = x - i, sm = f * f * (3 - 2 * f);
      const a = VOWELS[order[i % 8]][k], b = VOWELS[order[(i + 1) % 8]][k];
      return a + (b - a) * sm;
    };
    return offline(sec, (c, o) => {
      const src = H.gain(c), mix = H.gain(c);
      saws(c, src, C2, 0, sec, [-7, 7], 'sawtooth', 0.5);
      const f1 = H.filter(c, 'bandpass', 500, 6), f2 = H.filter(c, 'bandpass', 1500, 8);
      H.curve(f1.frequency, 0, sec, t => vowelAt(t, 0));
      H.curve(f2.frequency, 0, sec, t => vowelAt(t, 1));
      src.connect(f1); src.connect(f2);
      H.chain(f1, H.gain(c, 2), mix); H.chain(f2, H.gain(c, 1.5), mix);
      H.chain(src, H.filter(c, 'lowpass', 300), H.gain(c, 0.4), mix);
      H.chain(mix, H.drive(c, 7), o);
      H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, 0.4), o);
    }).then(b => finish(b, { loopSec: bar }));
  });
  def('riddim', 'Riddim bass', 'bass', loopBass, bpm => {
    const bar = spb(bpm) * 4, sec = bar + 0.06, step = 0.25 * spb(bpm);
    const pat = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0];
    const gateAt = t => { const i = Math.floor(t / step), x = t / step - i; return pat[i % 16] ? Math.min(1, x * 40) * Math.min(1, (1 - x) * 12) : 0; };
    return offline(sec, (c, o) => {
      const src = H.gain(c);
      saws(c, src, C2, 0, sec, [-5, 5], 'square', 0.35);
      saws(c, src, C2, 0, sec, [0], 'sawtooth', 0.35);
      const lp = H.filter(c, 'lowpass', 900, 6);
      H.curve(lp.frequency, 0, sec, t => 300 + 1600 * Math.exp(-((t / step) % 1) * 5));
      const gate = c.createGain(); H.curve(gate.gain, 0, sec, gateAt);
      H.chain(src, lp, H.drive(c, 9), gate, o);
      const sub = c.createGain(); H.curve(sub.gain, 0, sec, t => 0.5 * gateAt(t));
      H.chain(H.osc(c, 'sine', C2, 0, sec), sub, o);
    }).then(b => finish(b, { loopSec: bar }));
  });
  def('sub-wobble', 'Sub wobble', 'bass', loopBass, bpm => {
    const bar = spb(bpm) * 4, sec = bar + 0.06, period = 0.5 * spb(bpm);
    return offline(sec, (c, o) => {
      const g = c.createGain(); H.curve(g.gain, 0, sec, t => 0.15 + 0.85 * wub((t / period) % 1));
      H.chain(H.osc(c, 'sine', C2, 0, sec), g, H.drive(c, 2.5), o);
    }).then(b => finish(b, { loopSec: bar }));
  });
  def('donk', 'Donk', 'bass', { pitched: true }, () => offline(0.35, (c, o) => {
    const s = H.osc(c, 'sine', C3, 0, 0.35); H.env(s.frequency, [[0, C3 * 3], [0.015, C3], [0.3, C3]]);
    H.chain(s, H.perc(c, 0.001, 0.25, 1), H.drive(c, 3), o);
    H.chain(H.osc(c, 'triangle', C3 * 2, 0, 0.35), H.perc(c, 0.001, 0.08, 0.4), o);
  }).then(b => finish(b)));

  // Stabs, leads and pads
  def('screech', 'Screech lead', 'stab', { pitched: true, loop: true, hold: true }, () => {
    const len = 1, sec = len + 0.06;
    return offline(sec, (c, o) => {
      const car = H.osc(c, 'sawtooth', C4, 0, sec), mod = H.osc(c, 'sine', C4 * 1.5, 0, sec);
      H.chain(mod, H.gain(c, C4 * 2.5), car.frequency);
      H.chain(H.osc(c, 'sine', 7, 0, sec), H.gain(c, 18), car.detune);
      H.chain(car, H.filter(c, 'bandpass', 2200, 3), H.drive(c, 10), H.filter(c, 'lowpass', 6000), o);
    }).then(b => finish(b, { loopSec: len }));
  });
  def('hoover', 'Hoover', 'stab', { pitched: true, hold: true }, () => offline(3, (c, o) => {
    const mix = H.gain(c), g = c.createGain();
    [-25, -12, 0, 12, 25].forEach(ct => {
      const s = H.osc(c, 'sawtooth', C3 * Math.pow(2, ct / 1200), 0, 3);
      s.detune.setValueAtTime(-500, 0); s.detune.linearRampToValueAtTime(0, 0.12);
      H.chain(s, H.gain(c, 0.2), mix);
    });
    H.chain(H.osc(c, 'sawtooth', C2, 0, 3), H.gain(c, 0.25), mix);
    H.env(g.gain, [[0, 1], [2.6, 0.85], [3, 0]]);
    H.chain(mix, H.filter(c, 'lowpass', 3500, 1), g, H.drive(c, 2.5), o);
  }).then(b => finish(b)));
  def('dark-pad', 'Dark pad', 'stab', { pitched: true, loop: true, hold: true }, () => {
    const len = 4, sec = len + 0.3;
    return offline(sec, (c, o) => {
      const lp = H.filter(c, 'lowpass', 900, 2);
      H.curve(lp.frequency, 0, sec, t => 500 + 700 * wub((t / len) % 1));
      [0, 3, 7, 12].forEach(n => saws(c, lp, C3 * Math.pow(2, n / 12), 0, sec, [-11, 0, 9], 'sawtooth', 0.12));
      H.chain(lp, H.drive(c, 1.5), o);
    }).then(b => finish(b, { loopSec: len, xfSec: 0.25 }));
  });
  def('choir', 'Ghost choir', 'stab', { pitched: true, loop: true, hold: true }, () => {
    const len = 3, sec = len + 0.3;
    return offline(sec, (c, o) => {
      const src = H.gain(c), mix = H.gain(c), trem = c.createGain();
      [0, 7, 12].forEach(n => saws(c, src, C3 * Math.pow(2, n / 12), 0, sec, [-9, 0, 8], 'sawtooth', 0.15));
      [[700, 8, 1], [1150, 10, 0.6], [2800, 12, 0.25]].forEach(([f, q, l]) => H.chain(src, H.filter(c, 'bandpass', f, q), H.gain(c, l * 3), mix));
      H.curve(trem.gain, 0, sec, t => 0.85 + 0.15 * Math.sin(2 * Math.PI * 5 * t));
      H.chain(mix, trem, o);
      H.chain(H.noise(c, 0, sec, 80), H.filter(c, 'bandpass', 3000, 1), H.gain(c, 0.03), o);
    }).then(b => finish(b, { loopSec: len, xfSec: 0.25 }));
  });
  def('orch-hit', 'Orchestra hit', 'stab', { pitched: true }, () => offline(1.2, (c, o) => {
    chordStab(c, o, [semi(-12), semi(0), semi(3), semi(7), semi(12)], { decay: 0.9, cutoff: 6000, floor: 1200, drive: 2 });
    noiseHit(c, o, { decay: 0.25, f: 2000, q: 0.5, level: 0.5 });
    kick(c, o, { f0: 120, f1: 50, sweep: 0.08, decay: 0.6, click: 0, drive: 0, level: 0.6 });
  }).then(b => finish(b)));
  def('pluck', 'Synth pluck', 'stab', { pitched: true }, () => offline(0.6, (c, o) => {
    const lp = H.filter(c, 'lowpass', 6000, 6); H.env(lp.frequency, [[0, 7000], [0.2, 400]]);
    saws(c, lp, C4, 0, 0.6, [-8, 8], 'sawtooth', 0.4);
    H.chain(lp, H.perc(c, 0.001, 0.5, 1), o);
  }).then(b => finish(b)));

  // FX: builds, drops and transitions
  def('uplifter', 'Noise riser (1 bar)', 'fx', { tempo: true }, bpm => {
    const sec = spb(bpm) * 4;
    return offline(sec, (c, o) => {
      const hp = H.filter(c, 'highpass', 300, 1); H.env(hp.frequency, [[0, 300], [sec, 6000]]);
      const g = c.createGain(); H.env(g.gain, [[0, 0.02], [sec * 0.97, 1], [sec, 0]]);
      H.chain(H.noise(c, 0, sec, 81), hp, g, o);
    }).then(b => finish(b));
  });
  def('snare-roll', 'Snare build (2 bars)', 'fx', { tempo: true }, bpm => {
    const s = spb(bpm), sec = s * 8 + 0.3, hits = [];
    for (let b = 0; b < 4; b += 0.5) hits.push(b);
    for (let b = 4; b < 6; b += 0.25) hits.push(b);
    for (let b = 6; b < 8 - 1e-9; b += 0.125) hits.push(b);
    return offline(sec, (c, o) => {
      const bus = H.gain(c); H.chain(bus, H.drive(c, 3), o);
      hits.forEach((b, k) => {
        const t = b * s, prog = b / 8, lvl = 0.25 + 0.75 * prog;
        snareBody(c, bus, { t, f: 180 + 140 * prog, decay: 0.06, level: 0.8 * lvl });
        noiseHit(c, bus, { t, decay: 0.09, f: 2500 + 2500 * prog, q: 0.6, level: lvl, seed: 90 + (k % 7) });
      });
    }).then(b => finish(b));
  });
  def('drop-hit', 'Drop hit', 'fx', {}, () => offline(3.2, (c, o) => {
    impact(c, o);
    crash(c, o);
    H.chain(H.osc(c, 'sine', 50, 0, 3), H.perc(c, 0.01, 2.8, 0.7), o);
  }).then(b => finish(b)));
  def('rev-impact', 'Reverse impact', 'fx', {}, () => offline(2.4, impact).then(b => finish(b, { reverse: true })));
  def('tape-stop', 'Tape stop', 'fx', {}, () => offline(1.0, (c, o) => {
    const mix = H.gain(c), g = c.createGain();
    [0, 3, 7].forEach(n => {
      const f = C3 * Math.pow(2, n / 12), s = H.osc(c, 'sawtooth', f, 0, 1);
      H.env(s.frequency, [[0, f], [0.9, 3]]);
      H.chain(s, H.gain(c, 0.25), mix);
    });
    const sub = H.osc(c, 'sine', C2, 0, 1); H.env(sub.frequency, [[0, C2], [0.9, 2]]);
    H.chain(sub, H.gain(c, 0.5), mix);
    H.env(g.gain, [[0, 1], [0.7, 0.8], [0.95, 0]]);
    H.chain(mix, H.filter(c, 'lowpass', 2500), g, H.drive(c, 2), o);
  }).then(b => finish(b)));
  def('whoosh', 'Whoosh', 'fx', {}, () => offline(1.2, (c, o) => {
    const bp = H.filter(c, 'bandpass', 300, 2); H.env(bp.frequency, [[0, 300], [0.6, 5000], [1.15, 400]]);
    const g = c.createGain(); H.env(g.gain, [[0, 0], [0.6, 1], [1.2, 0]]);
    H.chain(H.noise(c, 0, 1.2, 83), bp, g, o);
  }).then(b => finish(b)));
  def('laser', 'Laser shot', 'fx', {}, () => offline(0.4, (c, o) => {
    const s = H.osc(c, 'sawtooth', 4000, 0, 0.4); H.env(s.frequency, [[0, 4000], [0.15, 300], [0.35, 200]]);
    H.chain(H.osc(c, 'sine', 70, 0, 0.4), H.gain(c, 600), s.frequency);
    H.chain(s, H.filter(c, 'lowpass', 8000), H.perc(c, 0.001, 0.3, 1), H.drive(c, 3), o);
  }).then(b => finish(b)));
  def('power-down', 'Power down', 'fx', {}, () => offline(1.4, (c, o) => {
    const s = H.osc(c, 'sawtooth', 420, 0, 1.4), s2 = H.osc(c, 'square', 210, 0, 1.4);
    H.env(s.frequency, [[0, 420], [1.3, 28]]); H.env(s2.frequency, [[0, 210], [1.3, 14]]);
    const lp = H.filter(c, 'lowpass', 3000); H.env(lp.frequency, [[0, 3000], [1.3, 200]]);
    const g = c.createGain(); H.env(g.gain, [[0, 0.9], [1.0, 0.6], [1.35, 0]]);
    s.connect(lp); H.chain(s2, H.gain(c, 0.5), lp); H.chain(lp, g, H.drive(c, 3), o);
  }).then(b => finish(b)));
  def('alarm', 'Alarm', 'fx', {}, () => offline(1.6, (c, o) => {
    const s = H.osc(c, 'square', 880, 0, 1.6), g = c.createGain();
    for (let k = 0; k < 8; k++) s.frequency.setValueAtTime(k % 2 ? 660 : 880, k * 0.2);
    H.env(g.gain, [[0, 0], [0.01, 0.6], [1.55, 0.6], [1.6, 0]]);
    H.chain(s, H.filter(c, 'lowpass', 4000), g, o);
  }).then(b => finish(b)));
  def('beeps', 'Data beeps', 'fx', {}, () => Promise.resolve(finish(direct(0.8, (d, sr) => {
    const r = rng(17), seg = Math.round(sr * 0.05);
    for (let s = 0; s * seg < d.length; s++) {
      const on = r() > 0.35, f = [1200, 1800, 2400, 3000][Math.floor(r() * 4)];
      for (let i = 0; i < seg && s * seg + i < d.length; i++) {
        const k = s * seg + i, env = i < 40 ? i / 40 : i > seg - 80 ? Math.max(0, (seg - i) / 80) : 1;
        d[k] = on ? Math.sin(2 * Math.PI * f * k / sr) * env * 0.7 : 0;
      }
    }
  }))));

  // ---- wobble designer: one bar of bass, looped, from user settings ----
  const SHAPES = {
    sine: wub,
    tri: x => 1 - Math.abs(2 * x - 1),
    saw: x => x,
    ramp: x => 1 - x,
    square: x => x < 0.02 ? x / 0.02 : x < 0.5 ? 1 : x < 0.52 ? 1 - (x - 0.5) / 0.02 : 0,
  };
  function renderWobble(p, bpm) {
    const b = spb(bpm), bar = b * 4, sec = bar + 0.06;
    const shape = SHAPES[p.shape] || wub, low = Math.max(20, p.low), high = Math.max(low + 10, p.high);
    const lfo = t => {
      const bt = (t / b) % 4, second = p.rate2 && bt >= 2;
      const r = second ? p.rate2 : p.rate, from = second ? 2 : 0;
      return shape(((bt - from) / r) % 1);
    };
    return offline(sec, (c, o) => {
      const lp = H.filter(c, 'lowpass', low, p.reso);
      H.curve(lp.frequency, 0, sec, t => low * Math.pow(high / low, Math.pow(lfo(t), 1.2)));
      const w = p.width;
      const oscs = [];
      if (p.wave !== 'square') oscs.push(...saws(c, lp, C2, 0, sec, [-w, w], 'sawtooth', 0.45));
      if (p.wave !== 'saw') oscs.push(...saws(c, lp, p.wave === 'square' ? C2 : C2 * 2, 0, sec, p.wave === 'square' ? [-w, w] : [0], 'square', p.wave === 'square' ? 0.4 : 0.2));
      if (p.growl > 0.01) {
        const mod = H.osc(c, 'sine', C2 * 2, 0, sec), mg = c.createGain();
        H.curve(mg.gain, 0, sec, t => p.growl * C2 * 6 * lfo(t));
        mod.connect(mg);
        oscs.forEach(x => mg.connect(x.frequency));
      }
      H.chain(lp, H.drive(c, 1 + p.grit * 30), H.filter(c, 'lowpass', 7000), o);
      if (p.sub > 0.01) H.chain(H.osc(c, 'sine', C2, 0, sec), H.gain(c, p.sub * 0.6), o);
    }).then(buf => finish(buf, { loopSec: bar }));
  }

  window.ThumpSynth = {
    sounds: S,
    renderWobble,
    setSampleRate(sr) { SR = sr; },
    render(id, bpm) {
      const s = S.find(x => x.id === id);
      if (!s) return Promise.reject(new Error('unknown synth sound ' + id));
      return s.render(bpm);
    },
  };
})();
