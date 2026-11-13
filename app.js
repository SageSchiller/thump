// Thump: a 16-pad drum machine for the m-vave SMC-PAD Pocket (USB or Bluetooth MIDI).
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (typeof v === 'boolean' && !k.includes('-')) e[k] = v;
      else e.setAttribute(k, String(v));
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  }
  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const SAMPLES = window.THUMP_SAMPLES, SYNTH = window.ThumpSynth, PRESETS = window.THUMP_PRESETS;
  const CATS = [
    ['kick', 'Kicks', '#ff5d5d'], ['snare', 'Snares', '#ffa83a'], ['clap', 'Claps', '#ffd23f'],
    ['hat', 'Hats', '#2ee6c0'], ['cymbal', 'Cymbals', '#5ad1ff'], ['tom', 'Toms', '#4d8bff'],
    ['perc', 'Percussion', '#b48cff'], ['world', 'Hand drums', '#d9a066'], ['metal', 'Metal & noise', '#9be15d'],
    ['bass', 'Bass', '#ff4fd8'], ['stab', 'Stabs & keys', '#ff9f6b'], ['fx', 'FX & risers', '#8f7bff'],
    ['user', 'Your sounds', '#e3e4ec'],
  ];
  const CAT = Object.fromEntries(CATS.map(([id, name, color]) => [id, { id, name, color }]));
  const KEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Digit4'];
  const KEY_LABEL = ['Z', 'X', 'C', 'V', 'A', 'S', 'D', 'F', 'Q', 'W', 'E', 'R', '1', '2', '3', '4'];
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALES = {
    minor: ['Minor', [0, 2, 3, 5, 7, 8, 10]], phrygian: ['Phrygian (dark)', [0, 1, 3, 5, 7, 8, 10]],
    penta: ['Minor pentatonic', [0, 3, 5, 7, 10]], major: ['Major', [0, 2, 4, 5, 7, 9, 11]],
    chromatic: ['Chromatic', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]],
  };
  const REPEATS = [[0, 'Off'], [0.5, '1/8'], [0.25, '1/16'], [1 / 6, '1/16T'], [0.125, '1/32']];
  const SNAPS = [[0, 'Off'], [0.5, '1/8'], [0.25, '1/16']];
  const BARS = [1, 2, 4];
  const PATS = 8, LETTERS = 'ABCDEFGH';
  const SPEEDS = [[2, '1/2'], [1, '1/4'], [0.5, '1/8'], [1 / 3, '1/8T'], [0.25, '1/16'], [1 / 6, '1/16T']];
  const PAD_DEFAULT = { sound: null, vol: 0.8, pitch: 0, len: 1, drive: 0, pan: 0, hold: false, rev: false, cut: 0 };
  const MASTER_DEFAULT = { vol: 0.8, filter: 0, space: 0.12, pump: 0, pumpMode: 'kick', swing: 0.5 };
  const WOB_DEFAULT = { rate: 0.5, rate2: 0, shape: 'sine', wave: 'both', low: 90, high: 2400, reso: 9, growl: 0, grit: 0.2, sub: 0.6, width: 9 };
  const LOOKAHEAD = 0.12;

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem('thump.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('thump.' + k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  const userMem = new Map(); // fallback when IndexedDB is unavailable
  const idb = {
    db: null,
    open() {
      if (this.db) return this.db;
      this.db = new Promise((res, rej) => {
        const r = indexedDB.open('thump', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('samples', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('samples', mode), req = fn(t.objectStore('samples'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    },
    all() { return this.run('readonly', s => s.getAll()); },
    get(id) { return this.run('readonly', s => s.get(id)); },
    put(rec) { return this.run('readwrite', s => s.put(rec)); },
  };

  // ---------------------------------------------------------------- library
  // kinds: smp (built-in sample), syn (built-in synth), usr (your file or mic),
  //        wob (your wobble design), chp (a slice of one of your files)
  const library = new Map();
  const packTitle = { synth: 'Thump synth', user: 'Your sounds', wobble: 'Your wobbles', chop: 'Your chops' };
  for (const p of SAMPLES.packs) packTitle[p.id] = p.title;
  for (const s of SAMPLES.sounds) library.set(s.id, { id: s.id, name: s.name, cat: s.cat, pack: s.pack, kind: 'smp', b64: s.layers });
  for (const s of SYNTH.sounds) library.set(s.id, { id: s.id, name: s.name, cat: s.cat, pack: 'synth', kind: 'syn', loop: !!s.loop, tempo: !!s.tempo, pitched: !!s.pitched, hold: !!s.hold });
  const wobbles = store.get('wobbles', {}); // id -> {name, params}
  const chops = store.get('chops', {});     // id -> {name, src, start, end}
  const addWobble = (id, w) => library.set(id, { id, name: w.name, cat: 'bass', pack: 'wobble', kind: 'wob', params: w.params, loop: true, tempo: true, pitched: true, hold: true });
  const addChop = (id, c) => library.set(id, { id, name: c.name, cat: 'user', pack: 'chop', kind: 'chp', src: c.src, start: c.start, end: c.end });
  const addUser = (id, name) => library.set(id, { id, name, cat: 'user', pack: 'user', kind: 'usr' });
  for (const [id, w] of Object.entries(wobbles)) addWobble(id, w);
  for (const [id, c] of Object.entries(chops)) addChop(id, c);
  const newId = p => p + ':' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------- sound buffers
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  SYNTH.setSampleRate(ctx.sampleRate);
  const ready = new Map(), pending = new Map(), renderedAt = new Map();
  function b64ToBuf(s) {
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function bufToB64(ab) {
    const u = new Uint8Array(ab); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function normalize(layers) {
    let peak = 0;
    for (const l of layers) for (let c = 0; c < l.buf.numberOfChannels; c++) {
      const d = l.buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    }
    if (peak < 0.02) return;
    const s = 0.89 / peak;
    for (const l of layers) for (let c = 0; c < l.buf.numberOfChannels; c++) {
      const d = l.buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= s;
    }
  }
  async function decodeLayers(list) {
    const layers = [];
    for (const l of list) {
      const data = l.data instanceof ArrayBuffer ? l.data.slice(0) : b64ToBuf(l.data);
      layers.push({ max: l.max, buf: await ctx.decodeAudioData(data) });
    }
    normalize(layers);
    return layers;
  }
  const userRecord = async id => userMem.get(id) || await idb.get(id).catch(() => null);
  function sliceBuffer(buf, start, end) {
    const sr = buf.sampleRate, a = clamp(Math.round(start * sr), 0, buf.length - 1), b = clamp(Math.round(end * sr), a + 1, buf.length);
    const out = new AudioBuffer({ length: b - a, sampleRate: sr, numberOfChannels: buf.numberOfChannels });
    const fade = Math.min(out.length, Math.round(0.004 * sr));
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c).slice(a, b);
      for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
      out.copyToChannel(d, c);
    }
    return out;
  }
  function loadSound(id) {
    const info = id && library.get(id);
    if (!info) return Promise.resolve(null);
    // Tempo sounds keep playing their old render until the new one is ready.
    const stale = info.tempo && renderedAt.get(id) !== state.bpm;
    if (ready.has(id) && !stale) return Promise.resolve(ready.get(id));
    const bpm = state.bpm, key = info.tempo ? id + '@' + bpm : id;
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      let layers;
      if (info.kind === 'smp') layers = await decodeLayers(info.b64);
      else if (info.kind === 'syn') layers = [{ max: 1, buf: await SYNTH.render(id, bpm) }];
      else if (info.kind === 'wob') layers = [{ max: 1, buf: await SYNTH.renderWobble(info.params, bpm) }];
      else if (info.kind === 'chp') {
        const src = await loadSound(info.src);
        if (!src) throw new Error('chop source missing');
        layers = [{ max: 1, buf: sliceBuffer(src.layers[0].buf, info.start, info.end) }];
        normalize(layers);
      } else {
        const rec = await userRecord(id);
        if (!rec) throw new Error('sound file missing');
        layers = await decodeLayers([{ max: 1, data: rec.data }]);
      }
      const entry = { layers, loop: !!info.loop, rev: null };
      if (!info.tempo || bpm === state.bpm) { ready.set(id, entry); if (info.tempo) renderedAt.set(id, bpm); }
      return entry;
    })().catch(err => { console.warn('Could not load', id, err); return null; })
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }
  function reversed(entry) {
    if (!entry.rev) entry.rev = entry.layers.map(l => {
      const b = new AudioBuffer({ length: l.buf.length, sampleRate: l.buf.sampleRate, numberOfChannels: l.buf.numberOfChannels });
      for (let c = 0; c < b.numberOfChannels; c++) { const d = new Float32Array(l.buf.getChannelData(c)); d.reverse(); b.copyToChannel(d, c); }
      return b;
    });
    return entry.rev;
  }
  const preloadKit = () => Promise.all(state.pads.map(p => loadSound(p.sound)));

  // ---------------------------------------------------------------- engine
  // One engine plays live; a second one on an OfflineAudioContext renders exports.
  const driveCurves = new Map();
  function driveCurve(amount) {
    const k = Math.round(amount * 20) / 20;
    if (!driveCurves.has(k)) {
      const n = 2048, c = new Float32Array(n), g = 1 + k * 30, norm = Math.tanh(g);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(g * x) / norm; }
      driveCurves.set(k, c);
    }
    return driveCurves.get(k);
  }
  const irs = new Map();
  function impulse(ac) {
    if (!irs.has(ac.sampleRate)) {
      const sr = ac.sampleRate, len = Math.round(2.6 * sr), b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 2 });
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch); let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          lp += ((rnd() * 2 - 1) - lp) * (0.85 - 0.7 * t);
          d[i] = lp * Math.pow(1 - t, 3) * Math.min(1, i / (0.003 * sr));
        }
      }
      irs.set(ac.sampleRate, b);
    }
    return irs.get(ac.sampleRate);
  }
  function makeEngine(ac) {
    const gain = v => { const g = ac.createGain(); g.gain.value = v; return g; };
    const M = {
      duckIn: gain(1), duck: gain(1), in: gain(1), lp: ac.createBiquadFilter(), hp: ac.createBiquadFilter(),
      send: gain(0), verb: ac.createConvolver(), comp: ac.createDynamicsCompressor(), out: gain(0.7), click: gain(0.3),
    };
    M.lp.type = 'lowpass'; M.lp.frequency.value = 20000;
    M.hp.type = 'highpass'; M.hp.frequency.value = 10;
    M.comp.threshold.value = -8; M.comp.knee.value = 8; M.comp.ratio.value = 6; M.comp.attack.value = 0.003; M.comp.release.value = 0.15;
    M.duckIn.connect(M.duck).connect(M.in);
    M.in.connect(M.lp).connect(M.hp);
    M.hp.connect(M.comp);
    M.hp.connect(M.send).connect(M.verb).connect(M.comp);
    M.comp.connect(M.out).connect(ac.destination);
    M.click.connect(M.out);
    M.verb.buffer = impulse(ac);
    const E = { ac, M, voices: new Set(), ducks: [], pump: { amount: 0, mode: 'kick', spb: 0.5 } };

    E.apply = (m, spbNow) => {
      const t = ac.currentTime;
      M.out.gain.setTargetAtTime(m.vol * m.vol * 1.1, t, 0.02);
      M.send.gain.setTargetAtTime(m.space * 0.55, t, 0.02);
      const f = m.filter, q = 0.7 + 4 * Math.abs(f);
      const lpF = f < -0.01 ? 20000 * Math.pow(110 / 20000, -f) : 20000, hpF = f > 0.01 ? 20 * Math.pow(5000 / 20, f) : 10;
      M.lp.frequency.setTargetAtTime(lpF, t, 0.02); M.hp.frequency.setTargetAtTime(hpF, t, 0.02);
      M.lp.Q.value = f < -0.01 ? q : 0.7; M.hp.Q.value = f > 0.01 ? q : 0.7;
      E.pump = { amount: m.pump, mode: m.pumpMode, spb: spbNow };
    };
    // Sidechain pump: everything except kicks dips and swells back.
    E.duckAt = when => {
      const { amount, spb } = E.pump;
      if (amount < 0.01) return;
      const t0 = Math.max(when, ac.currentTime), g = M.duck.gain, low = 1 - 0.88 * amount, tau = spb * 0.16;
      E.ducks = E.ducks.filter(t => t > ac.currentTime - 2);
      E.ducks.push(t0); E.ducks.sort((a, b) => a - b);
      g.cancelAndHoldAtTime(t0);
      for (const t of E.ducks) if (t >= t0) { g.setTargetAtTime(low, t, 0.003); g.setTargetAtTime(1, t + 0.015, tau); }
    };
    E.trigger = (pads, i, vel, opts = {}) => {
      const p = pads[i];
      if (!p || !p.sound) return null;
      const entry = ready.get(p.sound);
      if (!entry) { if (ac === ctx) loadSound(p.sound); return null; }
      const info = library.get(p.sound), when = Math.max(opts.when || 0, ac.currentTime);
      const n = clamp(vel / 127, 0.01, 1);
      let li = entry.layers.findIndex(l => n <= l.max + 1e-6);
      if (li < 0) li = entry.layers.length - 1;
      const buf = p.rev ? reversed(entry)[li] : entry.layers[li].buf;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const rate = Math.pow(2, (p.pitch + (opts.semis || 0)) / 12);
      src.playbackRate.value = rate;
      const hold = opts.hold ?? p.hold;
      if (hold && entry.loop && !p.rev) src.loop = true;
      let level = (entry.layers.length > 1 ? 0.4 + 0.6 * n : Math.pow(n, 1.25)) * p.vol;
      const g = ac.createGain();
      let node = src;
      if (p.drive > 0.01) {
        const ws = ac.createWaveShaper(); ws.curve = driveCurve(p.drive); ws.oversample = '2x';
        src.connect(ws); node = ws; level /= 1 + p.drive * 1.2;
      }
      const pan = ac.createStereoPanner(); pan.pan.value = p.pan;
      const isKick = info && info.cat === 'kick';
      node.connect(g); g.connect(pan); pan.connect(isKick ? M.in : M.duckIn);
      g.gain.setValueAtTime(level, when);
      // Cut groups stop older sounds in the group (never ones scheduled after this hit).
      if (p.cut) for (const v of E.voices) if (v.group === p.cut && v.start < when - 1e-4 && v.end > when) E.cut(v, when);
      src.start(when);
      let len = src.loop ? Infinity : buf.duration / rate;
      if (!src.loop && p.len < 0.999) len = Math.max(0.02, len * p.len);
      if (opts.maxDur) len = Math.min(len, opts.maxDur);
      if (len !== Infinity) {
        const fade = Math.min(0.06, len * 0.35);
        if (len < buf.duration / rate - 0.001) { g.gain.setValueAtTime(level, when + len - fade); g.gain.linearRampToValueAtTime(0, when + len); }
        src.stop(when + len + 0.01);
      }
      if (isKick && E.pump.mode === 'kick') E.duckAt(when);
      const v = { src, g, group: p.cut, pad: i, hold: hold && !opts.maxDur, released: false, start: when, end: when + len };
      src.onended = () => E.voices.delete(v);
      E.voices.add(v);
      return v;
    };
    E.release = (v, when = 0) => {
      if (!v || v.released) return;
      v.released = true;
      const t = Math.max(when, ac.currentTime);
      v.end = Math.min(v.end, t + 0.25);
      v.g.gain.cancelAndHoldAtTime(t);
      v.g.gain.setTargetAtTime(0, t, 0.03);
      try { v.src.stop(t + 0.25); } catch { }
    };
    E.cut = (v, when = 0) => {
      const t = Math.max(when, ac.currentTime);
      v.released = true;
      v.end = Math.min(v.end, t + 0.08);
      v.g.gain.cancelAndHoldAtTime(t);
      v.g.gain.setTargetAtTime(0, t, 0.01);
      try { v.src.stop(t + 0.08); } catch { }
    };
    E.click = (when, accent) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = accent ? 1760 : 1175;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(accent ? 1 : 0.6, when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      o.connect(g).connect(M.click);
      o.start(when); o.stop(when + 0.06);
    };
    return E;
  }
  const live = makeEngine(ctx);
  const applyMaster = () => live.apply(state.master, spb());

  // ---------------------------------------------------------------- state
  const normPad = entry => {
    const [id, opts] = Array.isArray(entry) ? entry : [entry, {}];
    const info = library.get(id);
    return Object.assign({}, PAD_DEFAULT, { sound: info ? id : null, hold: !!(info && info.hold) }, opts);
  };
  const emptyPattern = (bars = 2) => ({ bars, events: [] });
  function freshState() {
    const pre = PRESETS[0];
    return {
      name: '', kit: { id: pre.id, name: pre.name }, pads: pre.pads.map(normPad), bpm: pre.bpm, snap: 0.25,
      click: true, repeat: 0, master: Object.assign({}, MASTER_DEFAULT),
      patterns: Array.from({ length: PATS }, () => emptyPattern()), pat: 0,
      song: [], songMode: false, songLoop: false, mutes: Array(16).fill(false), notes: null,
    };
  }
  let state = freshState();
  let sel = 0, muteMode = false;
  const undoStack = [];
  const pat = () => state.patterns[state.pat];
  const spb = () => 60 / state.bpm;

  let saveTimer = null;
  function dirty() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('session', beatData()), 400);
  }
  const cleanEvents = evs => evs.map(({ pad, beat, vel, semis, dur }) => ({ pad, beat, vel, semis, dur }));
  function beatData() {
    return {
      v: 2, name: state.name, kit: state.kit, pads: state.pads, bpm: state.bpm, snap: state.snap, click: state.click,
      master: state.master, patterns: state.patterns.map(p => ({ bars: p.bars, events: cleanEvents(p.events) })),
      pat: state.pat, song: state.song, songMode: state.songMode, songLoop: state.songLoop, mutes: state.mutes,
    };
  }
  function cleanPattern(p) {
    const bars = BARS.includes(p && p.bars) ? p.bars : 2;
    const events = ((p && p.events) || []).filter(e => e && e.pad >= 0 && e.pad < 16 && e.beat >= 0)
      .map(e => ({ pad: e.pad, beat: +e.beat, vel: clamp(e.vel || 100, 1, 127), semis: e.semis || 0, dur: e.dur || 0.25 }));
    return { bars, events };
  }
  function loadBeat(d) {
    const s = freshState();
    if (!d || !Array.isArray(d.pads) || d.pads.length !== 16) return s;
    s.name = d.name || '';
    s.kit = d.kit || { id: 'custom', name: 'My kit' };
    s.pads = d.pads.map(p => Object.assign({}, PAD_DEFAULT, p, { sound: library.has(p.sound) ? p.sound : null }));
    s.bpm = clamp(+d.bpm || 140, 60, 200);
    s.snap = SNAPS.some(x => x[0] === d.snap) ? d.snap : 0.25;
    s.click = d.click !== false;
    s.master = Object.assign({}, MASTER_DEFAULT, d.master || {});
    if (Array.isArray(d.patterns)) d.patterns.slice(0, PATS).forEach((p, i) => { s.patterns[i] = cleanPattern(p); });
    else s.patterns[0] = cleanPattern({ bars: d.bars, events: d.events }); // version 1 beats had one loop
    s.pat = clamp(d.pat | 0, 0, PATS - 1);
    s.song = (d.song || []).filter(x => x && x.pat >= 0 && x.pat < PATS).map(x => ({ pat: x.pat, reps: [1, 2, 4, 8].includes(x.reps) ? x.reps : 1 }));
    s.songMode = !!d.songMode && s.song.length > 0;
    s.songLoop = !!d.songLoop;
    if (Array.isArray(d.mutes) && d.mutes.length === 16) s.mutes = d.mutes.map(Boolean);
    return s;
  }
  function setState(s) {
    stop();
    state = s; sel = 0; undoStack.length = 0;
    applyMaster(); preloadKit(); renderAll(); dirty();
  }

  // ---------------------------------------------------------------- sequencer
  // Playback runs through segments: one pass of one pattern. A segment's start is
  // in beats since Play. The next segment is the queued pattern, the next song
  // step, or the same pattern again.
  const seq = { playing: false, recording: false, start: 0, until: 0, seg: null, prev: null, queued: null, loopVoices: new Set(), lastSnap: null };
  const patLen = i => state.patterns[i].bars * 4;
  const posNow = () => (ctx.currentTime - seq.start) / spb();
  function firstSeg() {
    if (state.songMode && state.song.length) return { pat: state.song[0].pat, start: 0, len: patLen(state.song[0].pat), songIdx: 0, rep: 0 };
    return { pat: state.pat, start: 0, len: patLen(state.pat), songIdx: null, rep: 0 };
  }
  function nextSeg(s) {
    const start = s.start + s.len;
    if (seq.queued != null) {
      const p = seq.queued; seq.queued = null;
      return { pat: p, start, len: patLen(p), songIdx: null, rep: 0 };
    }
    if (s.songIdx != null) {
      let idx = s.songIdx, rep = s.rep + 1;
      if (!state.song[idx] || rep >= state.song[idx].reps) { idx++; rep = 0; }
      if (idx >= state.song.length) { if (!state.songLoop || !state.song.length) return null; idx = 0; }
      const p = state.song[idx].pat;
      return { pat: p, start, len: patLen(p), songIdx: idx, rep };
    }
    return { pat: s.pat, start, len: patLen(s.pat), songIdx: null, rep: 0 };
  }
  // Swing pushes every second 16th note late. 0.5 = straight, 0.75 = heavy.
  function swingOffset(beat) {
    const q = beat * 4, r = Math.round(q);
    return Math.abs(q - r) < 1e-3 && mod(r, 2) === 1 ? (state.master.swing - 0.5) * 0.5 : 0;
  }
  // Where a hit at `rel` beats into a pass of length L lands. A hit snapped forward
  // would play again moments later on this pass, so that one play is skipped.
  function placeHit(rel, L, snap) {
    let beat = snap ? Math.round(rel / snap) * snap : rel;
    const skip = beat > rel + 1e-9 ? beat : null;
    if (beat >= L - 1e-9) beat -= L;
    return { beat: Math.max(0, beat), skip };
  }

  function snapshot() {
    undoStack.push(JSON.stringify(state.patterns.map(p => p.events)));
    if (undoStack.length > 80) undoStack.shift();
  }
  function undo() {
    if (!undoStack.length) return toast('Nothing to undo');
    JSON.parse(undoStack.pop()).forEach((evs, i) => { state.patterns[i].events = evs; });
    drawLoop(); renderPatterns(); dirty();
  }

  function segAt(pos) {
    if (seq.seg && pos >= seq.seg.start) return seq.seg;
    if (seq.prev && pos >= seq.prev.start) return seq.prev;
    return seq.seg;
  }
  function recordHit(pad, vel, semis, time) {
    if (!seq.recording || !seq.playing) return null;
    let pos = (time - seq.start) / spb();
    if (pos < -0.5) return null;
    pos = Math.max(0, pos);
    const g = segAt(pos);
    if (!g) return null;
    const rel = Math.min(pos - g.start, g.len - 1e-6);
    const { beat, skip } = placeHit(rel, g.len, state.snap);
    if (seq.lastSnap !== g.start) { snapshot(); seq.lastSnap = g.start; }
    const ev = { pad, beat, vel, semis, dur: 0.25, skipAbs: skip == null ? null : g.start + skip, startPos: pos };
    state.patterns[g.pat].events.push(ev);
    drawLoop(); renderPatterns(); dirty();
    return ev;
  }
  function finishHit(ev) {
    if (!ev || ev.startPos == null) return;
    ev.dur = clamp(posNow() - ev.startPos, 0.05, 16);
    delete ev.startPos;
    dirty();
  }

  function play(countIn = false) {
    ctx.resume();
    for (const p of state.patterns) for (const e of p.events) { delete e.skipAbs; delete e.startPos; }
    const now = ctx.currentTime + 0.05;
    seq.start = countIn ? now + 4 * spb() : now;
    seq.until = countIn ? -4 : 0;
    seq.seg = firstSeg(); seq.prev = null; seq.queued = null;
    seq.playing = true;
    onSegment(seq.seg);
    applyMaster(); updateTransport();
    requestAnimationFrame(frame);
  }
  function silence() {
    for (const v of live.voices) live.cut(v, 0);
    for (const [k, h] of [...held]) padUp(h.grid, k[0]);
    repeats.clear();
  }
  function stop() {
    const was = seq.playing;
    seq.playing = false; seq.recording = false; seq.queued = null;
    for (const v of seq.loopVoices) live.cut(v, 0);
    seq.loopVoices.clear();
    if (was) silence();
    updateTransport(); renderPatterns(); renderSong(); drawLoop(); updateProgress();
  }
  function togglePlay() { seq.playing ? stop() : play(false); }
  function toggleRec() {
    if (!seq.playing) { seq.recording = true; seq.lastSnap = null; play(true); }
    else { seq.recording = !seq.recording; seq.lastSnap = null; }
    updateTransport();
  }
  function onSegment(g) {
    if (!g || !seq.playing) return;
    if (state.pat !== g.pat) { state.pat = g.pat; drawLoop(); updateProgressTicks(); }
    renderPatterns(); renderSong(); updateTransport();
  }

  function scheduleEvent(e, when) {
    const v = live.trigger(state.pads, e.pad, e.vel, { semis: e.semis, when });
    if (v) {
      seq.loopVoices.add(v);
      v.src.addEventListener('ended', () => seq.loopVoices.delete(v));
      if (v.hold) live.release(v, when + e.dur * spb());
    }
    later(when, () => flashPad(gridIndexFor(e.pad, e.semis), e.vel, true));
  }
  function later(when, fn) { setTimeout(fn, Math.max(0, (when - ctx.currentTime) * 1000)); }

  function tick() {
    if (seq.playing) {
      const s = spb(), from = seq.until, to = (ctx.currentTime + LOOKAHEAD - seq.start) / s;
      if (to > from) {
        for (let b = Math.ceil(from - 1e-9); b < to - 1e-9; b++) {
          const t = seq.start + b * s;
          if (b < 0 || state.click) live.click(t, mod(b, 4) === 0);
          if (b >= 0 && state.master.pumpMode === 'beat') live.duckAt(t);
        }
        const batch = [];
        while (seq.seg) {
          const g = seq.seg, end = g.start + g.len, a = Math.max(from, g.start), b = Math.min(to, end);
          if (b > a) for (const e of state.patterns[g.pat].events) {
            if (e.beat >= g.len) continue;
            const abs = g.start + e.beat;
            if (abs < a - 1e-9 || abs >= b - 1e-9) continue;
            if (e.skipAbs != null && Math.abs(e.skipAbs - abs) < 1e-6) { e.skipAbs = null; continue; }
            if (state.mutes[e.pad]) continue;
            batch.push({ e, abs });
          }
          if (to < end) break;
          const n = nextSeg(g);
          seq.prev = g; seq.seg = n;
          if (n) later(seq.start + n.start * s, () => onSegment(n));
          else later(seq.start + end * s, () => { if (seq.playing && !seq.seg) stop(); });
        }
        batch.sort((x, y) => x.abs - y.abs);
        for (const { e, abs } of batch) scheduleEvent(e, seq.start + (abs + swingOffset(e.beat)) * s);
        seq.until = to;
      }
    }
    for (const r of repeats) runRepeat(r);
  }

  // Note repeat: holding a pad retriggers it in time.
  const repeats = new Set();
  function startRepeat(h) {
    const r = { h, rate: state.repeat, nextAbs: null, nextTime: null };
    fireRepeat(r, ctx.currentTime);
    repeats.add(r);
    runRepeat(r);
    return r;
  }
  function fireRepeat(r, when) {
    live.trigger(state.pads, r.h.pad, r.h.vel, { semis: r.h.semis, when, hold: false, maxDur: r.rate * spb() * 0.92 });
    const ev = recordHit(r.h.pad, r.h.vel, r.h.semis, when);
    if (ev) { ev.dur = r.rate; delete ev.startPos; }
    later(when, () => flashPad(r.h.grid, r.h.vel));
  }
  function runRepeat(r) {
    const s = spb(), horizon = ctx.currentTime + 0.1;
    if (seq.playing) {
      r.nextTime = null;
      if (r.nextAbs == null) r.nextAbs = (Math.floor(posNow() / r.rate + 1e-6) + 1) * r.rate;
      while (seq.start + r.nextAbs * s <= horizon) {
        fireRepeat(r, seq.start + (r.nextAbs + swingOffset(r.nextAbs)) * s);
        r.nextAbs += r.rate;
      }
    } else {
      r.nextAbs = null;
      if (r.nextTime == null) r.nextTime = ctx.currentTime + r.rate * s;
      while (r.nextTime <= horizon) { fireRepeat(r, r.nextTime); r.nextTime += r.rate * s; }
    }
  }

  // ---------------------------------------------------------------- playing pads
  const held = new Map();
  function noteSemis(i) {
    const sc = SCALES[state.notes.scale][1];
    return state.notes.root + Math.floor(i / sc.length) * 12 + sc[i % sc.length];
  }
  function gridIndexFor(pad, semis) {
    if (state.notes && pad === state.notes.src) {
      for (let i = 0; i < 16; i++) if (noteSemis(i) === semis) return i;
      return -1;
    }
    return pad;
  }
  function toggleMute(i) {
    state.mutes[i] = !state.mutes[i];
    if (state.mutes[i]) for (const v of seq.loopVoices) if (v.pad === i) live.cut(v, 0);
    renderPads(); drawLoop(); dirty();
  }
  function padDown(i, vel, source) {
    if (ctx.state !== 'running') ctx.resume();
    if (lightPick) lightPick(i);
    if (muteMode && !state.notes) { toggleMute(i); flashPad(i, 60); return; }
    const key = source + i;
    if (held.has(key)) padUp(i, source);
    const notes = state.notes;
    const h = { pad: notes ? notes.src : i, semis: notes ? noteSemis(i) : 0, vel, grid: i };
    if (!notes && sel !== i) select(i);
    flashPad(i, vel);
    if (state.repeat > 0) h.repeat = startRepeat(h);
    else {
      h.voice = live.trigger(state.pads, h.pad, vel, { semis: h.semis });
      // You hit in time with what you hear, which reaches your ears outputLatency late.
      h.ev = recordHit(h.pad, vel, h.semis, ctx.currentTime - (ctx.outputLatency || 0));
    }
    held.set(key, h);
    padEls[i] && padEls[i].classList.add('held');
  }
  function padUp(i, source) {
    const key = source + i, h = held.get(key);
    if (!h) return;
    held.delete(key);
    if (![...held.values()].some(x => x.grid === i)) padEls[i] && padEls[i].classList.remove('held');
    if (h.voice && h.voice.hold) live.release(h.voice);
    if (h.ev) finishHit(h.ev);
    if (h.repeat) repeats.delete(h.repeat);
  }

  // ---------------------------------------------------------------- MIDI in
  let midi = null, usbPad = false;
  const lastMsg = new Map();
  const isPad = n => /smc|sinco|pad/i.test(n), isBt = n => /bluetooth/i.test(n);
  async function initMidi() {
    if (!navigator.requestMIDIAccess) return setStatus('warn', 'No MIDI in this browser');
    setStatus('', 'Waiting for MIDI permission…');
    try {
      // SysEx is only for the pad lights; without it everything else still works.
      try { midi = await navigator.requestMIDIAccess({ sysex: true }); sysexOk = true; } catch { midi = await navigator.requestMIDIAccess({ sysex: false }); }
      midi.onstatechange = bindMidi;
      bindMidi();
    } catch (err) {
      setStatus('warn', 'MIDI blocked: click to retry', initMidi);
    }
  }
  function bindMidi() {
    const names = [];
    const inputs = [...midi.inputs.values()].filter(i => i.state === 'connected');
    // With the pad on USB and Bluetooth at once, listen to USB only so hits don't double.
    usbPad = inputs.some(i => isPad(i.name) && !isBt(i.name));
    for (const inp of midi.inputs.values()) {
      const skip = /midi through/i.test(inp.name) || (usbPad && isPad(inp.name) && isBt(inp.name));
      inp.onmidimessage = skip ? null : onMidi;
      if (!skip && inp.state === 'connected') names.push(inp.name);
    }
    chooseLink();
    const pads = names.filter(isPad);
    if (!pads.length) for (const [k, h] of [...held]) if (k[0] === 'm') padUp(h.grid, 'm');
    if (pads.length) {
      const bt = pads.some(isBt), usb = pads.some(n => !isBt(n));
      setStatus('ok', 'Pad connected' + (usb && bt ? ' (USB + Bluetooth)' : bt ? ' (Bluetooth)' : ' (USB)'));
    } else if (names.length) setStatus('ok', names[0] + ' connected');
    else setStatus('', 'Plug in or switch on your pad');
  }
  function onMidi(e) {
    const [st, d1, d2] = e.data, cmd = st & 0xf0;
    if (st === 0xF0) return lights.onSysex(e.data);
    if (cmd !== 0x90 && cmd !== 0x80) return;
    const on = cmd === 0x90 && d2 > 0, k = (on ? 'on' : 'off') + d1, prev = lastMsg.get(k);
    if (prev !== undefined && e.timeStamp - prev < 15) return; // same hit arriving on a second port
    lastMsg.set(k, e.timeStamp);
    // With the lights session open, the pad's own note layout says which pad was hit.
    const i = (isPad(e.target.name || '') ? lights.padFor(st, d1) : null) ?? mod(d1 - 36, 16);
    on ? padDown(i, d2, 'm') : padUp(i, 'm');
  }
  function setStatus(kind, text, onclick) {
    const s = $('#status');
    s.className = 'chip' + (kind ? ' ' + kind : '');
    s.querySelector('span').textContent = text;
    s.onclick = onclick || null;
  }

  // ---------------------------------------------------------------- UI: pads
  const padEls = [];
  function buildPads() {
    const grid = $('#grid');
    for (const row of [12, 8, 4, 0]) for (let c = 0; c < 4; c++) {
      const i = row + c;
      const pad = el('button', { class: 'pad', 'aria-label': 'Pad ' + (i + 1) },
        el('span', { class: 'flash' }), el('span', { class: 'num' }, String(i + 1)), el('span', { class: 'key' }, KEY_LABEL[i]),
        el('span', { class: 'badges' }), el('span', { class: 'name' }), el('span', { class: 'cat' }));
      pad.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault(); pad.setPointerCapture(e.pointerId); padDown(i, 105, 'p');
      });
      const up = () => padUp(i, 'p');
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
      pad.addEventListener('dragover', e => { e.preventDefault(); pad.classList.add('drop'); });
      pad.addEventListener('dragleave', () => pad.classList.remove('drop'));
      pad.addEventListener('drop', async e => {
        e.preventDefault(); pad.classList.remove('drop');
        const f = [...e.dataTransfer.files].find(x => x.type.startsWith('audio') || /\.(wav|mp3|ogg|flac|aiff?|m4a|opus|webm)$/i.test(x.name));
        if (!f) return toast('Drop an audio file (WAV, MP3, OGG, FLAC)');
        const id = await addUserFile(f);
        if (id) { select(i); assignSound(i, id); }
      });
      padEls[i] = pad;
      grid.append(pad);
    }
  }
  // ---------------------------------------------------------------- pad lights
  // The SMC-PAD Pocket ignores MIDI notes for its lights. Its colours live in the
  // settings memory that M-VAVE's editor app changes (protocol reverse-engineered in
  // github.com/spectalive/smc-pad). A logical packet 00 59 <cmd> <length, 3 bytes LE>
  // <data> <~sum(data)> goes over USB as SysEx on the "Private" port, bit-packed
  // 8-to-7 least significant bit first between F0 and F7, or over Bluetooth raw to
  // GATT characteristic AE41 (service AE40), with answers on AE42. The pad only takes
  // writes after a full read of its settings, kept alive by reading its 12-byte global
  // block twice a second. Writes change live memory only (Thump never sends the save
  // command), so the pad's own colours come back when it is switched off, and Thump
  // puts them back when it closes or the lights are turned off.
  const SMC = {
    toMidi(bytes) {
      const out = [0xF0];
      let acc = 0, bits = 0;
      for (const b of bytes) {
        acc |= b << bits; bits += 8;
        while (bits >= 7) { out.push(acc & 0x7F); acc >>= 7; bits -= 7; }
      }
      if (bits) out.push(acc & 0x7F);
      out.push(0xF7);
      return out;
    },
    fromMidi(sx) {
      const out = [];
      let acc = 0, bits = 0;
      for (let i = 1; i < sx.length - 1; i++) {
        acc |= (sx[i] & 0x7F) << bits; bits += 7;
        while (bits >= 8) { out.push(acc & 0xFF); acc >>= 8; bits -= 8; }
      }
      return out;
    },
    sum: data => ~data.reduce((a, b) => a + b, 0) & 255,
    le: (v, n) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 255),
    packet(cmd, data) { const n = data.length; return [0x00, 0x59, cmd, n & 255, (n >> 8) & 255, (n >> 16) & 255, ...data, SMC.sum(data)]; },
    parse(b) {
      if (!b || b.length < 7 || b[0] !== 0 || b[1] !== 0x59) return null;
      const n = b[3] | b[4] << 8 | b[5] << 16, data = b.slice(6, 6 + n);
      return data.length === n && b[6 + n] === SMC.sum(data) ? { cmd: b[2], data } : null;
    },
    head: (region, addr, len) => [region, ...SMC.le(addr, 4), ...SMC.le(len, 3)],
    read: (region, addr, len) => SMC.packet(0x23, SMC.head(region, addr, len)),
    write: (region, addr, bytes) => SMC.packet(0x22, [...SMC.head(region, addr, bytes.length), ...bytes]),
    // Bluetooth notifications split long answers: join them back into packets.
    joiner(onPacket) {
      let buf = [];
      return bytes => {
        buf.push(...bytes);
        for (;;) {
          let s = 0; // skip to the next packet start (00 59)
          while (s < buf.length && !(buf[s] === 0 && (s + 1 === buf.length || buf[s + 1] === 0x59))) s++;
          if (s) buf = buf.slice(s);
          if (buf.length < 6) return;
          const n = buf[3] | buf[4] << 8 | buf[5] << 16;
          if (n > 2048) { buf = buf.slice(1); continue; } // not a real header
          if (buf.length < n + 7) return;
          const p = SMC.parse(buf.slice(0, n + 7));
          if (!p) { buf = buf.slice(1); continue; }
          buf = buf.slice(n + 7);
          onPacket(p);
        }
      };
    },
    // Chromium on Linux can hand over the same Bluetooth notification twice, a fraction of a
    // millisecond apart, which scrambles answers that span several notifications. The pad
    // never sends two identical pieces that close together, so a repeat like that is dropped.
    unrepeat(onBytes, now = () => performance.now()) {
      let last = null, at = 0;
      return bytes => {
        const t = now(), again = !!last && t - at < 4 && last.length === bytes.length && last.every((x, i) => x === bytes[i]);
        last = bytes; at = t;
        if (!again) onBytes(bytes);
      };
    },
  };
  // Settings memory of the Pocket: 4 presets of 2931 bytes, each 112 pad records
  // (7 banks of 16) of 26 bytes, `00 <channel> <note> <min> <max> R G B FF ...`.
  const POCKET = { preset: 2931, rec: 26, rgb: 5, records: 112, size: 0x2E24 };
  const sameRgb = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgbHex = c => '#' + c.map(x => x.toString(16).padStart(2, '0')).join('');

  // A link carries logical packets to the pad and hands the pad's packets to onPacket.
  function usbLink(out) {
    return { kind: 'usb', id: 'usb:' + out.id, send: b => out.send(SMC.toMidi(b)), close() { } };
  }
  async function btLink(device) {
    const gatt = await device.gatt.connect(), svc = await gatt.getPrimaryService(0xae40);
    const tx = await svc.getCharacteristic(0xae41), rx = await svc.getCharacteristic(0xae42);
    const link = {
      kind: 'bt', id: 'bt:' + device.id, onPacket: null, onClose: null,
      send: b => { tx.writeValueWithoutResponse(new Uint8Array(b)).catch(() => { }); },
      close() { try { gatt.disconnect(); } catch { } },
    };
    const feed = SMC.unrepeat(SMC.joiner(p => link.onPacket && link.onPacket(p)));
    rx.addEventListener('characteristicvaluechanged', e => { const v = e.target.value; feed(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))); });
    await rx.startNotifications();
    device.addEventListener('gattserverdisconnected', () => link.onClose && link.onClose(), { once: true });
    return link;
  }

  function makeLights({ enabled, key, onState = () => { } }) {
    let link = null, ready = false, running = false, wake = null, waiter = null, failures = 0, lastPoll = 0;
    let glob = null, preset = 0, group = 2, model = '', status = 'nopad', saveTimer = 0;
    let recs = null; // the current preset's 112 pad records, as read at the last unlock
    let notes = new Map(); // (channel << 8 | note) -> record numbers in the current preset
    const want = new Map(), flashT = [];
    let pads = Array.from({ length: 16 }, () => ({ rgb: null, level: 0, own: false }));
    // shown: what the pad holds, as far as Thump knows. orig: the pad's own colours.
    const saved = key ? store.get(key, {}) : {};
    const load = o => new Map(Object.entries(o || {}).map(([a, h]) => [+a, hexRgb(h)]));
    const orig = load(saved.orig), shown = load(saved.shown);
    const persist = () => {
      if (!key) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => store.set(key, {
        orig: Object.fromEntries([...orig].map(([a, c]) => [a, rgbHex(c)])),
        shown: Object.fromEntries([...shown].map(([a, c]) => [a, rgbHex(c)])),
      }), 1500);
    };
    const setStatus = s => { if (s !== status) { status = s; onState(s); } };
    const addr = i => preset * POCKET.preset + (group * 16 + i) * POCKET.rec + POCKET.rgb;
    const kick = () => { if (wake) wake(); else if (!running) run(); };
    const idleOf = i => { const p = pads[i]; return p.own ? orig.get(addr(i)) || [0, 0, 0] : p.rgb ? p.rgb.map(x => Math.round(x * p.level)) : [0, 0, 0]; };

    function request(logical, cmd, ms, match) {
      return new Promise(res => {
        const timer = setTimeout(() => { if (waiter && waiter.res === res) waiter = null; res(null); }, ms);
        waiter = { cmd, match, res, timer };
        try { link.send(logical); } catch { clearTimeout(timer); waiter = null; res(null); }
      });
    }
    function receive(p) {
      if (!p || !waiter || p.cmd !== waiter.cmd || (waiter.match && !waiter.match(p.data))) return;
      const w = waiter;
      waiter = null; clearTimeout(w.timer); w.res(p.data);
    }
    async function readRegion(region, a, len) {
      const head = SMC.head(region, a, len);
      const d = await request(SMC.read(region, a, len), 0x23, 1500, d => d.length === len + 8 && head.every((b, i) => d[i] === b));
      return d && d.slice(8);
    }
    async function unlock() {
      const id = await request(SMC.packet(0x11, []), 0x11, 1500);
      if (!id) return false;
      model = String.fromCharCode(...id.filter(b => b > 31 && b < 127)).trim();
      if (!/pocket/i.test(model)) return null; // only the Pocket's memory layout is known
      const g = await readRegion(4, 0, 12);
      if (!g) return false;
      const mem = new Uint8Array(POCKET.size);
      for (let a = 0; a < mem.length; a += 1009) {
        const d = await readRegion(5, a, Math.min(1009, mem.length - a));
        if (!d) return false;
        mem.set(d, a);
      }
      const p = g[10] < 4 ? g[10] : 0, base = p * POCKET.preset;
      for (let r = 0; r < POCKET.records; r++) if (mem[base + r * POCKET.rec] !== 0 || mem[base + r * POCKET.rec + 8] !== 0xFF) return null;
      glob = g; preset = p; recs = mem.slice(base, base + POCKET.records * POCKET.rec);
      notes = new Map();
      for (let r = 0; r < POCKET.records; r++) {
        const o = base + r * POCKET.rec, k = (mem[o + 1] & 15) << 8 | mem[o + 2];
        notes.set(k, [...(notes.get(k) || []), r]);
        const a = o + POCKET.rgb, cur = [...mem.slice(a, a + 3)];
        // A colour Thump didn't put there is the pad's own (first run, or the pad was switched off since).
        if (!orig.has(a) || !sameRgb(cur, shown.get(a))) orig.set(a, cur);
        shown.set(a, cur);
      }
      persist();
      return true;
    }
    function paintAll() { for (let i = 0; i < 16; i++) if (!flashT[i]) want.set(addr(i), idleOf(i)); }
    async function run() {
      if (running) return;
      running = true;
      try {
        while (link && (enabled() || want.size)) {
          if (!ready) {
            setStatus('connecting');
            const ok = await unlock();
            if (ok === null) { setStatus('unsupported'); break; }
            if (!ok) { if (++failures >= 3) { setStatus('noreply'); break; } await sleep(500); continue; }
            ready = true; failures = 0; lastPoll = performance.now();
            if (enabled()) { want.clear(); paintAll(); }
            setStatus(enabled() ? 'on' : 'off');
            continue;
          }
          if (want.size) {
            const [a, rgb] = want.entries().next().value;
            want.delete(a);
            if (sameRgb(shown.get(a), rgb)) continue;
            const ack = await request(SMC.write(5, a, rgb), 0x00, 1000);
            if (!ack || ack[0] !== 0) { ready = false; if (!want.has(a)) want.set(a, rgb); continue; }
            shown.set(a, rgb); persist();
            continue;
          }
          if (!enabled()) break;
          if (performance.now() - lastPoll > 450) {
            const g = await readRegion(4, 0, 12);
            lastPoll = performance.now();
            // No answer: the session lapsed. A different answer: preset or bank changed on the pad.
            if (!g || g.some((b, i) => b !== glob[i])) ready = false;
            continue;
          }
          await new Promise(r => { wake = r; setTimeout(r, 120); });
          wake = null;
        }
      } finally {
        running = false;
        if (link && !enabled() && status !== 'unsupported' && status !== 'noreply') setStatus('off');
      }
    }
    function queue(i, rgb) {
      if (!link || !enabled() || !ready) return;
      want.set(addr(i), rgb);
      kick();
    }
    return {
      attach(l) {
        if ((l && l.id) === (link && link.id)) return;
        if (link && link !== l) link.onPacket = null;
        link = l; ready = false; failures = 0; want.clear();
        if (waiter) { clearTimeout(waiter.timer); waiter.res(null); waiter = null; }
        if (l) l.onPacket = receive;
        setStatus(l ? (enabled() ? 'connecting' : 'off') : 'nopad');
        if (l && enabled()) kick();
      },
      onSysex(bytes) { if (link && link.kind === 'usb') receive(SMC.parse(SMC.fromMidi(bytes))); },
      // pads: 16 entries of { base: '#rrggbb' or null, level: 0-1, own: use the pad's own colour }
      setPads(list) {
        pads = list.map(c => ({ rgb: c.base ? hexRgb(c.base).map(x => 255 * (x / 255) ** 2.2) : null, level: c.level, own: !!c.own })); // gamma keeps LED colours saturated
        for (let i = 0; i < 16; i++) if (!flashT[i]) queue(i, idleOf(i));
      },
      flash(i, vel, white) {
        const p = pads[i];
        if (!ready || !enabled() || !(p.rgb || p.own)) return;
        const k = white || p.own ? 1 : 0.35 * Math.max(0, (vel - 64) / 63); // hard hits go whiter
        queue(i, (p.rgb || [250, 250, 250]).map(x => Math.round(x + (250 - x) * k)));
        clearTimeout(flashT[i]);
        flashT[i] = setTimeout(() => { flashT[i] = 0; queue(i, idleOf(i)); }, 90);
      },
      // Which of the 16 pads sent this note, from the pad's own note layout. It also
      // follows the pad to another bank. null when the note isn't in the current preset.
      padFor(ch, n) {
        const rs = notes.get((ch & 15) << 8 | n);
        if (!rs) return null;
        const r = rs.find(x => x >> 4 === group) ?? rs[0];
        if (r >> 4 !== group) { group = r >> 4; if (ready && enabled()) { paintAll(); kick(); } onState(status); }
        return r & 15;
      },
      // The pad's own colours for the 16 pads on show (null if not known yet).
      own: () => Array.from({ length: 16 }, (_, i) => orig.has(addr(i)) ? rgbHex(orig.get(addr(i))) : null),
      // Put the pad's own colours back (the lights were turned off).
      restore() {
        want.clear();
        for (const [a, c] of orig) if (!sameRgb(shown.get(a), c)) want.set(a, c);
        if (want.size && link) kick();
      },
      // The page is closing and can't wait for answers. The pad drops messages that arrive
      // while it is busy, so the pad's own colours go back as whole records in one message.
      // shown is left alone, so if this is lost the next start still knows the originals.
      restoreNow() {
        if (!link || !ready || !recs) return false;
        const base = preset * POCKET.preset, at = r => base + r * POCKET.rec + POCKET.rgb, touched = [];
        for (let r = 0; r < POCKET.records; r++) if (orig.has(at(r)) && !sameRgb(shown.get(at(r)), orig.get(at(r)))) touched.push(r);
        if (!touched.length) return false;
        const lo = touched[0], hi = touched[touched.length - 1], block = recs.slice(lo * POCKET.rec, (hi + 1) * POCKET.rec);
        for (let r = lo; r <= hi; r++) if (orig.has(at(r))) block.set(orig.get(at(r)), (r - lo) * POCKET.rec + POCKET.rgb);
        const step = (link.kind === 'bt' ? 18 : 38) * POCKET.rec; // a Bluetooth packet must fit one 512-byte write
        for (let o = 0; o < block.length; o += step) {
          try { link.send(SMC.write(5, base + lo * POCKET.rec + o, [...block.slice(o, o + step)])); } catch { }
        }
        return true;
      },
      get status() { return status; },
      get model() { return model; },
      get kind() { return link && link.kind; },
      get busy() { return running && (want.size > 0 || !ready); },
      get where() { return { preset, group }; },
    };
  }

  const LIGHTS_DEFAULT = { on: true, mode: 'sound', bright: 0.25, flash: true, white: false, beat: true, mine: null };
  const lightOpts = Object.assign({}, LIGHTS_DEFAULT, store.get('lights', {}));
  if (store.get('lights') == null && store.get('padLights', true) === false) lightOpts.on = false;
  const saveLights = () => store.set('lights', lightOpts);
  let sysexOk = false, btDevice = null, bt = null, btBusy = false, btError = '', lightPick = null;
  const lights = makeLights({ enabled: () => lightOpts.on, key: 'padColors', onState: () => lightsUi() });
  let lightsUi = () => { };
  // USB when the pad is plugged in, Bluetooth otherwise.
  function chooseLink() {
    const usb = sysexOk && midi && [...midi.outputs.values()].find(o => o.state === 'connected' && isPad(o.name) && /private/i.test(o.name));
    if (usb) { lights.attach(usbLink(usb)); if (bt) { bt.onClose = null; bt.close(); bt = null; } return; }
    if (bt) return lights.attach(bt);
    lights.attach(null);
    const btPad = midi && [...midi.inputs.values()].some(i => i.state === 'connected' && isPad(i.name) && isBt(i.name));
    if (lightOpts.on && btPad) connectBt(false);
  }
  async function connectBt(ask) {
    if (!navigator.bluetooth || btBusy) return;
    btBusy = true; btError = ''; lightsUi();
    try {
      if (!btDevice && navigator.bluetooth.getDevices) btDevice = (await navigator.bluetooth.getDevices()).find(d => /smc-pad/i.test(d.name || '')) || null;
      if (!btDevice && ask) btDevice = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'SMC-PAD' }], optionalServices: [0xae40] });
      if (!btDevice) return;
      bt = await btLink(btDevice);
      bt.onClose = () => { bt = null; chooseLink(); };
    } catch (e) {
      if (ask && !/cancel/i.test(e.message)) btError = 'Bluetooth: ' + e.message;
    } finally {
      btBusy = false;
      if (bt) chooseLink();
      lightsUi();
    }
  }
  function lightsText() {
    const btPad = midi && [...midi.inputs.values()].some(i => i.state === 'connected' && isPad(i.name) && isBt(i.name));
    if (!lightOpts.on) return 'Off. Your pad shows its own colors.';
    if (btError) return btError;
    if (btBusy) return 'Connecting over Bluetooth…';
    const where = `preset ${lights.where.preset + 1}, bank ${lights.where.group + 1}`;
    return {
      nopad: btPad ? (navigator.bluetooth ? 'Pad found over Bluetooth. Press Connect to light it wirelessly (once; Thump remembers it).' : 'Plug the pad in with USB to use its lights.')
        : sysexOk ? 'Switch the pad on, or plug it in with USB.' : 'Thump needs permission to control MIDI devices for USB. Close Thump, open it again and choose Allow.',
      connecting: 'Connecting to the pad…',
      on: `Working over ${lights.kind === 'bt' ? 'Bluetooth' : 'USB'}: ${where}.`,
      off: 'Off. Your pad shows its own colors.',
      unsupported: `This pad (${lights.model || 'unknown'}) isn't supported. Only the SMC-PAD Pocket is.`,
      noreply: 'The pad didn\'t answer. Switch it off and on, or unplug it and plug it back in.',
    }[lights.status] || '';
  }
  // What the pad's own lights show at rest: dim colours, dark when muted (or empty).
  function padLightList() {
    const notes = state.notes;
    return padEls.map((_, i) => {
      if (lightOpts.mode === 'own') return { own: true, level: 1 };
      const p = notes ? state.pads[notes.src] : state.pads[i], info = p.sound && library.get(p.sound);
      const root = notes && mod(noteSemis(i) - notes.root, 12) === 0;
      const level = Math.min(1, notes ? lightOpts.bright * (root ? 1.8 : 0.7) : state.mutes[i] ? 0 : lightOpts.bright);
      const base = lightOpts.mode === 'mine' ? lightOpts.mine && lightOpts.mine[i] : info && CAT[info.cat].color;
      return { base: base && base !== '#000000' ? base : null, level };
    });
  }
  function renderPads() {
    const notes = state.notes;
    for (let i = 0; i < 16; i++) {
      const pad = padEls[i], p = notes ? state.pads[notes.src] : state.pads[i];
      const info = p.sound && library.get(p.sound);
      pad.style.setProperty('--c', info ? CAT[info.cat].color : '#555');
      pad.classList.toggle('empty', !info);
      pad.classList.toggle('sel', !notes && i === sel);
      pad.classList.toggle('note', !!notes);
      pad.classList.toggle('muted', !notes && state.mutes[i]);
      if (notes) {
        const semis = noteSemis(i) + p.pitch;
        pad.querySelector('.name').textContent = NOTE_NAMES[mod(semis, 12)];
        pad.querySelector('.cat').textContent = i === 0 ? info?.name || '' : '';
        pad.querySelector('.badges').replaceChildren();
      } else {
        pad.querySelector('.name').textContent = info ? info.name : 'Empty';
        pad.querySelector('.cat').textContent = info ? CAT[info.cat].name : 'Click, then Change sound';
        const b = [];
        if (p.hold) b.push(el('b', { title: 'Hold: plays while held' }, 'H'));
        if (p.rev) b.push(el('b', { title: 'Reversed' }, 'R'));
        if (p.cut) b.push(el('b', { title: 'Cut group ' + p.cut }, 'G' + p.cut));
        pad.querySelector('.badges').replaceChildren(...b);
      }
    }
    lights.setPads(padLightList());
  }
  function flashPad(i, vel, beat) {
    const pad = padEls[i];
    if (!pad) return;
    if (beat ? lightOpts.beat : lightOpts.flash) lights.flash(i, vel, lightOpts.white);
    const v = Math.max(0.3, vel / 127), c = pad.style.getPropertyValue('--c') || '#888';
    pad.querySelector('.flash').animate([{ opacity: v }, { opacity: 0 }], { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)' });
    pad.animate([
      { transform: 'scale(.955)', boxShadow: `0 0 ${10 + 40 * v}px ${2 + 8 * v}px ${c}77` },
      { transform: 'scale(1)', boxShadow: '0 8px 18px #0006' },
    ], { duration: 380, easing: 'cubic-bezier(.2,.7,.3,1)' });
  }
  function select(i) {
    sel = i;
    renderPads(); renderPanel();
    if (!$('#browser').hidden) renderBrowser();
  }
  const target = () => state.notes ? state.notes.src : sel;

  // ---------------------------------------------------------------- UI: panel
  const pct = v => Math.round(v * 100) + '%';
  const padCtrlDefs = [
    ['vol', 'Volume', 0, 1, 0.01, pct],
    ['pitch', 'Pitch', -24, 24, 1, v => (v > 0 ? '+' : '') + v + ' st'],
    ['len', 'Length', 0.05, 1, 0.01, v => v >= 0.999 ? 'Full' : pct(v)],
    ['drive', 'Drive', 0, 1, 0.01, v => v < 0.01 ? 'Off' : pct(v)],
    ['pan', 'Pan', -1, 1, 0.01, v => Math.abs(v) < 0.01 ? 'Center' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)],
  ];
  const masterCtrlDefs = [
    ['vol', 'Volume', 0, 1, 0.01, pct, 0.8],
    ['filter', 'Filter', -1, 1, 0.01, v => Math.abs(v) < 0.01 ? 'Off' : (v < 0 ? 'Low ' : 'High ') + Math.round(Math.abs(v) * 100), 0],
    ['space', 'Space', 0, 1, 0.01, v => v < 0.01 ? 'Dry' : pct(v), 0.12],
    ['pump', 'Pump', 0, 1, 0.01, v => v < 0.01 ? 'Off' : pct(v), 0],
    ['swing', 'Swing', 0.5, 0.75, 0.01, v => v < 0.505 ? 'Straight' : pct(v), 0.5],
  ];
  const ctrlEls = { pad: {}, master: {} };
  function makeCtrl(where, [key, label, min, max, step, fmt, def], onChange) {
    const input = el('input', { type: 'range', min, max, step, id: where + '-' + key, class: min < 0 ? 'center' : null });
    const out = el('output', { title: 'Double-click to reset' });
    const setFill = () => input.style.setProperty('--p', ((input.value - min) / (max - min) * 100) + '%');
    input.addEventListener('input', () => { const v = +input.value; out.textContent = fmt(v); setFill(); onChange(key, v); });
    const reset = () => { input.value = def ?? PAD_DEFAULT[key]; input.dispatchEvent(new Event('input')); };
    out.addEventListener('dblclick', reset);
    input.addEventListener('dblclick', reset);
    ctrlEls[where][key] = { input, out, fmt, setFill };
    return el('div', { class: 'ctrl' }, el('label', { for: input.id }, label), input, out);
  }
  function setCtrl(where, key, v) {
    const c = ctrlEls[where][key];
    c.input.value = v; c.out.textContent = c.fmt(+v); c.setFill();
  }
  function buildPanel() {
    $('#padCtrls').append(...padCtrlDefs.map(d => makeCtrl('pad', d, (k, v) => {
      state.pads[target()][k] = v;
      if (k === 'pitch' && state.notes) renderPads();
      dirty();
    })));
    $('#masterCtrls').append(...masterCtrlDefs.map(d => makeCtrl('master', d, (k, v) => { state.master[k] = v; applyMaster(); dirty(); })));
    seg('#pumpSeg', [['kick', 'Kicks'], ['beat', 'Every beat']], () => state.master.pumpMode, v => { state.master.pumpMode = v; applyMaster(); dirty(); });
    $('#holdBtn').onclick = () => { const p = state.pads[target()]; p.hold = !p.hold; renderPanel(); renderPads(); dirty(); };
    $('#revBtn').onclick = () => { const p = state.pads[target()]; p.rev = !p.rev; renderPanel(); renderPads(); dirty(); };
    const cut = $('#cutSel');
    cut.append(el('option', { value: 0 }, 'None'), ...[1, 2, 3, 4].map(n => el('option', { value: n }, 'Group ' + n)));
    cut.onchange = () => { state.pads[target()].cut = +cut.value; renderPads(); dirty(); };
    $('#changeBtn').onclick = openBrowser;
    $('#editWobBtn').onclick = wobbleDialog;
    $('#notesBtn').onclick = () => {
      if (state.notes) state.notes = null;
      else if (!state.pads[sel].sound) return toast('Put a sound on this pad first');
      else { state.notes = { src: sel, scale: 'minor', root: 0 }; setMuteMode(false); }
      renderAll();
    };
    const sc = $('#scaleSel');
    sc.append(...Object.entries(SCALES).map(([k, [n]]) => el('option', { value: k }, n)));
    sc.onchange = () => { state.notes.scale = sc.value; renderPads(); };
    const rt = $('#rootSel');
    rt.append(...NOTE_NAMES.map((n, i) => el('option', { value: i }, n)));
    rt.onchange = () => { state.notes.root = +rt.value; renderPads(); };
  }
  function renderPanel() {
    const notes = state.notes, i = target(), p = state.pads[i];
    const info = p.sound && library.get(p.sound);
    $('#padTitle').textContent = `Pad ${i + 1} · key ${KEY_LABEL[i]}` + (notes ? ' · notes mode' : '');
    $('#soundName').textContent = info ? info.name : 'No sound yet';
    const meta = $('#soundMeta');
    meta.replaceChildren();
    if (info) {
      meta.append(el('i', { style: 'background:' + CAT[info.cat].color }), `${CAT[info.cat].name} · ${packTitle[info.pack] || ''}`);
      if (info.tempo) meta.append(' · follows tempo');
    }
    $('#editWobBtn').hidden = !(info && info.kind === 'wob');
    for (const [k] of padCtrlDefs) setCtrl('pad', k, p[k]);
    $('#holdBtn').setAttribute('aria-pressed', p.hold);
    $('#revBtn').setAttribute('aria-pressed', p.rev);
    $('#cutSel').value = p.cut;
    $('#notesBtn').textContent = notes ? 'Stop playing notes' : 'Play this sound as notes on all pads';
    $('#notesBtn').classList.toggle('primary', !!notes);
    $('#notesOpts').hidden = !notes;
    if (notes) { $('#scaleSel').value = notes.scale; $('#rootSel').value = notes.root; }
    const bn = $('#notesBanner');
    bn.hidden = !notes;
    if (notes) bn.replaceChildren(el('span', {}, `Notes mode: ${info ? info.name : ''} in ${NOTE_NAMES[notes.root]} ${SCALES[notes.scale][0].toLowerCase()}. Each pad is a pitch.`), el('div', { class: 'grow' }), el('button', { class: 'btn sm', onclick: () => { state.notes = null; renderAll(); } }, 'Back to drums'));
  }

  // ---------------------------------------------------------------- UI: sound browser
  let browserCat = 'all';
  function openBrowser() {
    const p = state.pads[target()], info = p.sound && library.get(p.sound);
    browserCat = info ? info.cat : 'all';
    $('#search').value = '';
    $('#browser').hidden = false;
    renderBrowser(true);
  }
  function closeBrowser() { $('#browser').hidden = true; }
  function renderBrowser(scroll) {
    const t = target(), p = state.pads[t];
    $('#browserPad').textContent = `Pad ${t + 1}`;
    const q = $('#search').value.trim().toLowerCase();
    const counts = {};
    for (const s of library.values()) counts[s.cat] = (counts[s.cat] || 0) + 1;
    $('#cats').replaceChildren(
      el('button', { 'aria-pressed': browserCat === 'all', onclick: () => { browserCat = 'all'; renderBrowser(); } }, 'All'),
      ...CATS.filter(([id]) => counts[id] || id === 'user').map(([id, name, color]) => el('button', {
        'aria-pressed': browserCat === id, onclick: () => { browserCat = id; renderBrowser(); },
      }, el('i', { style: 'background:' + color }), name)));
    const items = [...library.values()].filter(s => (browserCat === 'all' || s.cat === browserCat) &&
      (!q || (s.name + ' ' + (packTitle[s.pack] || '') + ' ' + CAT[s.cat].name).toLowerCase().includes(q)));
    const order = Object.fromEntries(CATS.map(([id], n) => [id, n]));
    const rank = s => s.kind === 'wob' || s.kind === 'usr' || s.kind === 'chp' ? 0 : s.kind === 'syn' ? 1 : 2;
    items.sort((a, b) => order[a.cat] - order[b.cat] || rank(a) - rank(b));
    const kids = [];
    let lastCat = null, cur = null;
    for (const s of items) {
      if (s.cat !== lastCat && browserCat === 'all') { kids.push(el('div', { class: 'grp' }, CAT[s.cat].name)); lastCat = s.cat; }
      const b = el('button', { class: s.id === p.sound ? 'cur' : null, onclick: () => { assignSound(t, s.id); renderBrowser(); } },
        el('i', { style: 'background:' + CAT[s.cat].color }), el('span', { class: 'n' }, s.name), el('span', { class: 'p' }, packTitle[s.pack] || ''));
      if (s.id === p.sound) cur = b;
      kids.push(b);
    }
    if (!kids.length) kids.push(el('div', { class: 'empty' }, browserCat === 'user' ? 'Nothing of your own yet. Record with the mic, chop a long sound or add files below.' : 'No sounds match.'));
    $('#list').replaceChildren(...kids);
    if (scroll && cur) cur.scrollIntoView({ block: 'center' });
  }
  async function assignSound(i, id) {
    const p = state.pads[i], info = library.get(id);
    Object.assign(p, { sound: id, pitch: 0, len: 1, drive: 0, rev: false, hold: !!info.hold });
    if (state.kit.id !== 'custom') state.kit = { id: 'custom', name: state.kit.name + ' (edited)' };
    renderKitSel(); renderPads(); renderPanel(); dirty();
    await loadSound(id);
    if (!seq.playing) {
      live.trigger(state.pads, i, 105, { maxDur: 2.5, hold: false, semis: state.notes ? noteSemis(0) : 0 });
      flashPad(state.notes ? 0 : i, 105);
    }
  }
  async function addUserData(name, data, quiet) {
    const id = newId('usr'), rec = { id, name: name.slice(0, 40), data };
    try { await idb.put(rec); } catch { userMem.set(id, rec); if (!quiet) toast('Saved for this session only (storage unavailable)'); }
    addUser(id, rec.name);
    return id;
  }
  async function addUserFile(file) {
    try {
      const data = await file.arrayBuffer();
      await ctx.decodeAudioData(data.slice(0));
      return await addUserData(file.name.replace(/\.[^.]+$/, ''), data);
    } catch {
      toast(`Could not read ${file.name}`);
      return null;
    }
  }
  async function loadUserSounds() {
    try { for (const rec of await idb.all()) addUser(rec.id, rec.name); } catch { }
  }

  // ---------------------------------------------------------------- UI: transport and song
  const segs = [];
  function seg(sel, opts, get, set) {
    const box = $(sel);
    const btns = opts.map(([v, label]) => el('button', { onclick: () => { set(v); refresh(); } }, label));
    const refresh = () => btns.forEach((b, n) => b.setAttribute('aria-pressed', opts[n][0] === get()));
    box.replaceChildren(...btns);
    segs.push(refresh);
    return refresh;
  }
  function buildTransport() {
    $('#playBtn').onclick = togglePlay;
    $('#recBtn').onclick = toggleRec;
    seg('#barsSeg', BARS.map(b => [b, b + (b === 1 ? ' bar' : ' bars')]), () => pat().bars, setBars);
    seg('#snapSeg', SNAPS, () => state.snap, v => { state.snap = v; dirty(); });
    seg('#repSeg', REPEATS, () => state.repeat, v => { state.repeat = v; });
    const inp = $('#bpmIn');
    inp.onchange = () => setBpm(+inp.value);
    $('#bpmDown').onclick = () => setBpm(state.bpm - 1);
    $('#bpmUp').onclick = () => setBpm(state.bpm + 1);
    const taps = [];
    $('#tapBtn').onclick = () => {
      const t = performance.now();
      if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
      taps.push(t);
      if (taps.length > 6) taps.shift();
      if (taps.length >= 3) setBpm(Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))));
    };
    $('#clickBtn').onclick = () => { state.click = !state.click; updateTransport(); dirty(); };
    $('#undoBtn').onclick = undo;
    $('#clearBtn').onclick = () => {
      if (!pat().events.length) return;
      snapshot(); pat().events = []; drawLoop(); renderPatterns(); dirty(); toast(`Pattern ${LETTERS[state.pat]} cleared. Undo brings it back.`);
    };
    $('#dupBtn').onclick = copyToNext;
    $('#songBtn').onclick = () => {
      if (!state.song.length) return toast('Add patterns to the song first with + Add');
      state.songMode = !state.songMode;
      if (seq.playing) { stop(); play(false); }
      renderSong(); dirty();
    };
    $('#songAdd').onclick = () => { state.song.push({ pat: state.pat, reps: 1 }); renderSong(); dirty(); };
    $('#songLoopBtn').onclick = () => { state.songLoop = !state.songLoop; renderSong(); dirty(); };
  }
  function choosePattern(i) {
    if (seq.playing) {
      const playing = seq.seg ? seq.seg.pat : state.pat;
      seq.queued = i === playing ? null : i;
      if (state.songMode && seq.queued != null) { state.songMode = false; renderSong(); }
    } else { state.pat = i; drawLoop(); updateProgressTicks(); renderSong(); }
    renderPatterns(); updateTransport(); dirty();
  }
  function renderPatterns() {
    const playing = seq.playing && seq.seg ? seq.seg.pat : -1;
    $('#patSeg').replaceChildren(...state.patterns.map((p, i) => el('button', {
      class: [p.events.length ? 'has' : '', i === playing ? 'playing' : '', i === seq.queued ? 'queued' : ''].join(' ').trim() || null,
      'aria-pressed': i === state.pat,
      title: `Pattern ${LETTERS[i]}: ${p.events.length} hits, ${p.bars} bar${p.bars > 1 ? 's' : ''}` + (seq.playing ? '. Click to switch at the end of this pass' : ''),
      onclick: () => choosePattern(i),
    }, LETTERS[i])));
    $('#loopTitle').textContent = `Pattern ${LETTERS[state.pat]}`;
  }
  function copyToNext() {
    const from = state.pat;
    for (let k = 1; k < PATS; k++) {
      const i = (from + k) % PATS;
      if (!state.patterns[i].events.length) {
        snapshot();
        state.patterns[i] = { bars: pat().bars, events: cleanEvents(pat().events) };
        choosePattern(i);
        toast(`Copied ${LETTERS[from]} to ${LETTERS[i]}. Change ${LETTERS[i]} to make a variation.`);
        return;
      }
    }
    toast('All 8 patterns have hits in them. Clear one first.');
  }
  function renderSong() {
    const box = $('#songChips'), now = seq.playing && seq.seg && seq.seg.songIdx != null ? seq.seg.songIdx : -1;
    $('#songBtn').setAttribute('aria-pressed', state.songMode);
    $('#songLoopBtn').setAttribute('aria-pressed', state.songLoop);
    $('#songAdd').textContent = `+ Add ${LETTERS[state.pat]}`;
    if (!state.song.length) { box.replaceChildren(el('span', { class: 'empty' }, 'Song: add patterns in the order you want them')); return; }
    const kids = [];
    state.song.forEach((s, i) => {
      if (i) kids.push(el('span', { class: 'arrow' }, '›'));
      kids.push(el('span', { class: 'chip2' + (i === now ? ' now' : '') },
        el('button', { title: 'Click to change how many times it plays', onclick: () => { s.reps = { 1: 2, 2: 4, 4: 8, 8: 1 }[s.reps]; renderSong(); dirty(); } }, `${LETTERS[s.pat]} ×${s.reps}`),
        el('button', { class: 'x', title: 'Remove from song', onclick: () => { state.song.splice(i, 1); if (!state.song.length) state.songMode = false; renderSong(); dirty(); } }, '✕')));
    });
    const beats = state.song.reduce((a, s) => a + patLen(s.pat) * s.reps, 0), sec = Math.round(beats * spb());
    kids.push(el('span', { class: 'empty' }, `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`));
    box.replaceChildren(...kids);
  }
  function setBars(b) {
    const p = pat(), old = p.bars;
    if (b === old) return;
    const oldL = old * 4, inside = p.events.filter(e => e.beat < oldL);
    if (b > old && inside.length && !p.events.some(e => e.beat >= oldL)) {
      snapshot();
      for (let k = 1; k < b / old; k++) for (const e of inside) p.events.push(Object.assign({}, e, { beat: e.beat + k * oldL, skipAbs: null }));
      toast('Copied your pattern to fill the new length');
    }
    p.bars = b;
    dirty(); drawLoop(); updateProgressTicks(); renderSong();
  }
  let tempoTimer = null;
  function setBpm(v) {
    v = clamp(Math.round(v) || 140, 60, 200);
    if (v === state.bpm) return updateTransport();
    if (seq.playing) { const pos = posNow(); state.bpm = v; seq.start = ctx.currentTime - pos * spb(); }
    else state.bpm = v;
    applyMaster(); updateTransport(); renderSong(); dirty();
    clearTimeout(tempoTimer);
    tempoTimer = setTimeout(() => state.pads.forEach(p => { const info = library.get(p.sound); if (info && info.tempo) loadSound(p.sound); }), 250);
  }
  function updateTransport() {
    $('#playBtn').classList.toggle('on', seq.playing);
    $('#playBtn span').textContent = seq.playing ? 'Stop' : 'Play';
    $('#playIcon').setAttribute('d', seq.playing ? 'M3.5 3h9v10h-9z' : 'M4 2.5v11l9-5.5z');
    $('#recBtn').classList.toggle('on', seq.recording);
    $('#recBtn span').textContent = 'Rec';
    $('#progress').classList.toggle('rec', seq.recording);
    $('#bpmIn').value = state.bpm;
    $('#clickBtn').setAttribute('aria-pressed', state.click);
    segs.forEach(f => f());
  }
  function updateProgressTicks() {
    const pr = $('#progress');
    pr.querySelectorAll('.tick').forEach(t => t.remove());
    const L = patLen(state.pat);
    for (let b = 1; b < L; b++) pr.append(el('div', { class: 'tick', style: `left:${b / L * 100}%;${b % 4 ? '' : 'background:#ffffff55'}` }));
  }
  function updateProgress() {
    const ph = $('#playhead'), g = seq.seg;
    if (!seq.playing || !g) { ph.style.width = '0'; return; }
    const pos = posNow();
    ph.style.width = pos < 0 ? '0' : (clamp((pos - g.start) / g.len, 0, 1) * 100) + '%';
  }
  function frame() {
    if (!seq.playing) return;
    const pos = posNow();
    $('#recBtn span').textContent = pos < 0 ? String(Math.ceil(-pos)) : 'Rec';
    $('#recBtn').classList.toggle('count', pos < 0);
    updateProgress(); drawLoop();
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- UI: loop view
  let allRows = false;
  const LABEL_W = 132, ROW_H = 22;
  function loopRows() {
    if (allRows) return [...Array(16).keys()];
    const L = patLen(state.pat), used = new Set(pat().events.filter(e => e.beat < L).map(e => e.pad));
    state.mutes.forEach((m, i) => { if (m) used.add(i); });
    return [...used].sort((a, b) => a - b);
  }
  function drawLoop() {
    const cv = $('#loopCanvas'), rows = loopRows(), L = patLen(state.pat), steps = L * 4;
    const w = cv.clientWidth || 800, h = Math.max(64, rows.length * ROW_H + 8), dpr = devicePixelRatio || 1;
    if (cv.height !== Math.round(h * dpr) || cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + 'px'; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = pat().events.filter(e => e.beat < L).length;
    $('#loopInfo').textContent = `${pat().bars} bar${pat().bars > 1 ? 's' : ''}` + (n ? ` · ${n} hit${n === 1 ? '' : 's'} · click a square to add or remove a hit, click a name to mute` : '');
    if (!rows.length) {
      g.fillStyle = '#5d6274'; g.font = '13px system-ui, sans-serif';
      g.fillText('Press Rec to record what you play, or turn on "All pads" to click hits in.', 14, 36);
      return;
    }
    const cw = (w - LABEL_W) / steps;
    for (let s = 0; s < steps; s++) {
      g.fillStyle = Math.floor(s / 4) % 2 ? '#181a22' : '#1d1f29';
      g.fillRect(LABEL_W + s * cw, 4, cw, rows.length * ROW_H);
      if (s % 16 === 0 && s) { g.fillStyle = '#3a3e50'; g.fillRect(LABEL_W + s * cw - 1, 4, 2, rows.length * ROW_H); }
    }
    g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle';
    rows.forEach((pad, r) => {
      const y = 4 + r * ROW_H, info = library.get(state.pads[pad].sound), m = state.mutes[pad];
      g.fillStyle = info ? CAT[info.cat].color : '#555';
      g.globalAlpha = m ? 0.35 : 1;
      g.fillRect(4, y + 7, 7, 7);
      g.fillStyle = m ? '#ffcf6b' : '#c9ccd8';
      g.fillText(m ? `${pad + 1}. MUTED` : `${pad + 1}. ${info ? info.name : 'Empty'}`.slice(0, 18), 16, y + ROW_H / 2);
      g.globalAlpha = 1;
      g.fillStyle = '#ffffff08'; g.fillRect(LABEL_W, y + ROW_H - 1, w - LABEL_W, 1);
    });
    for (const e of pat().events) {
      if (e.beat >= L) continue;
      const r = rows.indexOf(e.pad);
      if (r < 0) continue;
      const info = library.get(state.pads[e.pad].sound), x = LABEL_W + e.beat * 4 * cw, y = 4 + r * ROW_H + 4;
      const long = state.pads[e.pad].hold ? Math.max(cw - 2, e.dur * 4 * cw - 2) : Math.max(4, cw - 3);
      g.globalAlpha = (state.mutes[e.pad] ? 0.25 : 1) * (0.45 + 0.55 * (e.vel / 127));
      g.fillStyle = info ? CAT[info.cat].color : '#888';
      g.beginPath(); g.roundRect(x + 1, y, Math.min(long, w - x - 2), ROW_H - 8, 3); g.fill();
      g.globalAlpha = 1;
    }
    if (seq.playing && seq.seg && seq.seg.pat === state.pat) {
      const pos = posNow();
      if (pos >= seq.seg.start) {
        const x = LABEL_W + clamp(pos - seq.seg.start, 0, L) * 4 * cw;
        g.fillStyle = seq.recording ? '#ff3b4e' : '#ffffff'; g.fillRect(x, 2, 2, rows.length * ROW_H + 4);
      }
    }
  }
  function loopClick(e) {
    const cv = $('#loopCanvas'), rect = cv.getBoundingClientRect(), rows = loopRows();
    const x = e.clientX - rect.left, y = e.clientY - rect.top, L = patLen(state.pat), steps = L * 4;
    const r = Math.floor((y - 4) / ROW_H);
    if (r < 0 || r >= rows.length) return;
    if (x < LABEL_W) return toggleMute(rows[r]);
    const step = Math.floor((x - LABEL_W) / ((rect.width - LABEL_W) / steps));
    const pad = rows[r], b0 = step / 4, b1 = (step + 1) / 4;
    snapshot();
    const hits = pat().events.filter(ev => ev.pad === pad && ev.beat >= b0 - 1e-9 && ev.beat < b1 - 1e-9);
    if (hits.length) pat().events = pat().events.filter(ev => !hits.includes(ev));
    else { pat().events.push({ pad, beat: b0, vel: 100, semis: 0, dur: 0.25 }); if (!seq.playing) live.trigger(state.pads, pad, 100, { maxDur: 1, hold: false }); }
    drawLoop(); renderPatterns(); dirty();
  }
  function setMuteMode(on) {
    muteMode = on;
    $('#muteBtn').setAttribute('aria-pressed', on);
    $('#muteBanner').hidden = !on;
  }

  // ---------------------------------------------------------------- kits and beats
  function renderKitSel() {
    const s = $('#kitSel');
    s.replaceChildren(
      el('optgroup', { label: 'Ready-made kits' }, ...PRESETS.map(p => el('option', { value: p.id }, p.name))),
      state.kit.id === 'custom' ? el('option', { value: 'custom' }, state.kit.name) : null);
    s.value = state.kit.id;
  }
  function loadPreset(id) {
    const pre = PRESETS.find(p => p.id === id);
    if (!pre) return;
    state.kit = { id: pre.id, name: pre.name };
    state.pads = pre.pads.map(normPad);
    state.notes = null;
    if (!state.patterns.some(p => p.events.length)) setBpm(pre.bpm);
    preloadKit(); renderAll(); dirty();
  }
  const beats = () => store.get('beats', {});
  function buildBeatMenu() {
    const btn = $('#beatBtn'), menu = $('#beatMenu');
    btn.onclick = e => { e.stopPropagation(); menu.hidden ? openMenu() : (menu.hidden = true); };
    document.addEventListener('click', e => { if (!menu.contains(e.target)) menu.hidden = true; });
    function openMenu() {
      const saved = beats(), names = Object.keys(saved).sort();
      const item = (label, fn) => el('button', { onclick: () => { menu.hidden = true; fn(); } }, el('span', {}, label));
      menu.replaceChildren(
        item('New beat', newBeat),
        item('Save beat…', saveBeatDialog),
        el('hr'),
        el('div', { class: 'sub' }, names.length ? 'Your beats' : 'No saved beats yet'),
        ...names.map(n => el('button', { onclick: () => { menu.hidden = true; setState(loadBeat(saved[n])); toast(`Opened "${n}"`); } },
          el('span', {}, n),
          el('span', { class: 'del', title: 'Delete', onclick: ev => { ev.stopPropagation(); confirmDialog(`Delete "${n}"?`, 'Delete', () => { const b = beats(); delete b[n]; store.set('beats', b); toast('Deleted'); }); } }, '✕'))),
        el('hr'),
        item('Save as audio (MP3 or WAV)…', exportDialog),
        item('Export beat to a file…', exportBeat),
        item('Import beat from a file…', () => $('#importIn').click()));
      menu.hidden = false;
    }
    $('#importIn').onchange = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        for (const [id, s] of Object.entries(d.userSounds || {})) {
          const rec = { id, name: s.name, data: b64ToBuf(s.data) };
          try { await idb.put(rec); } catch { userMem.set(id, rec); }
          addUser(id, s.name);
        }
        for (const [id, w] of Object.entries(d.wobbles || {})) { wobbles[id] = w; addWobble(id, w); }
        for (const [id, c] of Object.entries(d.chops || {})) { chops[id] = c; addChop(id, c); }
        store.set('wobbles', wobbles); store.set('chops', chops);
        setState(loadBeat(d.beat || d));
        toast(`Imported "${state.name || f.name}"`);
      } catch { toast('That file is not a Thump beat'); }
    };
  }
  function newBeat() {
    const go = () => {
      snapshot(); stop();
      state.patterns = Array.from({ length: PATS }, () => emptyPattern());
      state.pat = 0; state.song = []; state.songMode = false; state.name = ''; state.mutes = Array(16).fill(false);
      renderAll(); dirty(); toast('New beat. Your kit is still loaded.');
    };
    state.patterns.some(p => p.events.length) ? confirmDialog('Start a new beat? This clears all patterns and the song (your sounds stay).', 'New beat', go) : go();
  }
  function saveBeatDialog() {
    const input = el('input', { type: 'text', value: state.name || `Beat ${Object.keys(beats()).length + 1}`, maxlength: 40 });
    const save = () => {
      const name = input.value.trim();
      if (!name) return;
      state.name = name;
      const b = beats(); b[name] = beatData();
      store.set('beats', b) ? toast(`Saved "${name}"`) : toast('Could not save (storage full)');
      closeModal(); dirty();
    };
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') closeModal(); });
    openModal(el('h2', {}, 'Save beat'), el('p', {}, 'Saves your sounds, pad settings, tempo, patterns and song.'), input,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn primary', onclick: save }, 'Save')));
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }
  async function exportBeat() {
    const data = { beat: beatData(), userSounds: {}, wobbles: {}, chops: {} };
    const addUserSound = async id => {
      if (data.userSounds[id]) return;
      const rec = await userRecord(id);
      if (rec) data.userSounds[id] = { name: rec.name, data: bufToB64(rec.data) };
    };
    for (const p of state.pads) {
      const info = p.sound && library.get(p.sound);
      if (!info) continue;
      if (info.kind === 'usr') await addUserSound(p.sound);
      if (info.kind === 'wob') data.wobbles[p.sound] = wobbles[p.sound];
      if (info.kind === 'chp') { data.chops[p.sound] = chops[p.sound]; await addUserSound(info.src); }
    }
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), fileBase() + '.thump.json');
  }
  const fileBase = () => (state.name || 'beat').replace(/[^\w -]+/g, '').trim() || 'beat';
  function download(blob, name) {
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Saved ${name} to your Downloads folder`);
  }

  // ---------------------------------------------------------------- export audio
  function exportSegments(what, loops) {
    const segsOut = [];
    let start = 0;
    const push = p => { segsOut.push({ pat: p, start, len: patLen(p) }); start += patLen(p); };
    if (what === 'song') for (const s of state.song) for (let r = 0; r < s.reps; r++) push(s.pat);
    else for (let r = 0; r < loops; r++) push(state.pat);
    return { segs: segsOut, beats: start };
  }
  async function renderOffline(segsList, totalBeats, sampleRate = 44100) {
    await preloadKit();
    const s = spb(), len = Math.ceil((totalBeats * s + 3) * sampleRate);
    const oc = new OfflineAudioContext(2, len, sampleRate);
    const E = makeEngine(oc);
    E.apply(state.master, s);
    if (state.master.pumpMode === 'beat') for (let b = 0; b < totalBeats; b++) E.duckAt(b * s);
    const items = [];
    for (const g of segsList) for (const e of state.patterns[g.pat].events) {
      if (e.beat < g.len && !state.mutes[e.pad]) items.push({ e, abs: g.start + e.beat });
    }
    items.sort((a, b) => a.abs - b.abs);
    for (const { e, abs } of items) {
      const when = (abs + swingOffset(e.beat)) * s;
      const v = E.trigger(state.pads, e.pad, e.vel, { semis: e.semis, when });
      if (v && v.hold) E.release(v, when + e.dur * s);
    }
    const buf = await oc.startRendering();
    // Trim the silent part of the reverb tail.
    let last = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > 0.0003) { last = i; break; }
    }
    const keep = Math.min(buf.length, Math.max(Math.round(totalBeats * s * sampleRate), last + Math.round(0.05 * sampleRate)));
    return { channels: [0, 1].map(c => buf.getChannelData(c).subarray(0, keep)), sampleRate };
  }
  function encodeWav(channels, sampleRate) {
    const n = channels[0].length, nc = channels.length, bytes = n * nc * 2;
    const ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      const s = clamp(channels[c][i], -1, 1);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
    return ab;
  }
  async function encodeMp3(channels, sampleRate, onProgress) {
    const toI16 = f => { const out = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = clamp(f[i], -1, 1); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return out; };
    const L = toI16(channels[0]), R = toI16(channels[1] || channels[0]);
    const enc = new lamejs.Mp3Encoder(2, sampleRate, 192), parts = [], block = 1152;
    for (let i = 0, k = 0; i < L.length; i += block, k++) {
      const m = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
      if (m.length) parts.push(new Int8Array(m));
      if (k % 300 === 0) { if (onProgress) onProgress(i / L.length); await sleep(0); }
    }
    const end = enc.flush();
    if (end.length) parts.push(new Int8Array(end));
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  function exportDialog() {
    const hasSong = state.song.length > 0;
    let what = hasSong && state.songMode ? 'song' : 'loop', loops = 4, fmt = 'mp3';
    const info = el('p', { class: 'status' }), status = el('p', { class: 'status' });
    const whatSeg = el('div', { class: 'seg' }), timesSeg = el('div', { class: 'seg' }), fmtSeg = el('div', { class: 'seg' });
    const timesRow = el('div', { class: 'form-row' }, el('span', {}, 'Times'), timesSeg);
    const refresh = () => {
      const { beats: b } = exportSegments(what, loops), sec = Math.round(b * spb());
      info.textContent = `About ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} long. Uses your current mix: mutes, swing, pump, filter and space.`;
      timesRow.hidden = what !== 'loop';
    };
    const mk = (box, opts, get, set) => {
      const btns = opts.map(([v, label, disabled]) => el('button', { disabled: !!disabled, onclick: () => { set(v); paint(); refresh(); } }, label));
      const paint = () => btns.forEach((b, n) => b.setAttribute('aria-pressed', opts[n][0] === get()));
      box.replaceChildren(...btns); paint();
    };
    mk(whatSeg, [['loop', `Pattern ${LETTERS[state.pat]}, repeated`], ['song', hasSong ? 'Whole song' : 'Whole song (add patterns first)', !hasSong]], () => what, v => { what = v; });
    mk(timesSeg, [1, 2, 4, 8].map(n => [n, '×' + n]), () => loops, v => { loops = v; });
    mk(fmtSeg, [['mp3', 'MP3 (small, plays anywhere)'], ['wav', 'WAV (best quality)']], () => fmt, v => { fmt = v; });
    const go = el('button', { class: 'btn primary' }, 'Save…');
    go.onclick = async () => {
      const name = `${fileBase()}.${fmt}`;
      let handle = null;
      if (window.showSaveFilePicker) {
        try {
          handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: fmt.toUpperCase() + ' audio', accept: { [fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav']: ['.' + fmt] } }] });
        } catch (err) { if (err.name === 'AbortError') return; handle = null; }
      }
      go.disabled = true;
      try {
        status.textContent = 'Rendering…';
        const { segs: sg, beats: b } = exportSegments(what, loops);
        const out = await renderOffline(sg, b);
        status.textContent = 'Encoding…';
        const blob = fmt === 'wav' ? new Blob([encodeWav(out.channels, out.sampleRate)], { type: 'audio/wav' })
          : await encodeMp3(out.channels, out.sampleRate, f => { status.textContent = `Encoding… ${Math.round(f * 100)}%`; });
        if (handle) {
          const w = await handle.createWritable(); await w.write(blob); await w.close();
          toast(`Saved ${handle.name}`);
        } else download(blob, name);
        closeModal();
      } catch (err) {
        console.error(err);
        status.textContent = 'Something went wrong: ' + err.message;
        go.disabled = false;
      }
    };
    openModal(el('h2', {}, 'Save as audio'),
      el('div', { class: 'form' },
        el('div', { class: 'form-row' }, el('span', {}, 'What'), whatSeg),
        timesRow,
        el('div', { class: 'form-row' }, el('span', {}, 'Format'), fmtSeg)),
      info, status,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), go));
    refresh();
  }

  // ---------------------------------------------------------------- record with the microphone
  function trimSilence(buf) {
    const sr = buf.sampleRate, n = buf.length, mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
    if (peak < 0.003) return null;
    let a = 0, b = n - 1;
    while (a < n && Math.abs(mono[a]) < peak * 0.05) a++;
    while (b > a && Math.abs(mono[b]) < peak * 0.015) b--;
    a = Math.max(0, a - Math.round(0.008 * sr)); b = Math.min(n, b + Math.round(0.06 * sr));
    const out = mono.slice(a, b), fade = Math.min(out.length, Math.round(0.01 * sr));
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
    return { data: out, sampleRate: sr };
  }
  async function micDialog() {
    const t = target();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch { return toast('The microphone is blocked or not available'); }
    const srcNode = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    an.fftSize = 1024; srcNode.connect(an);
    const meter = el('div', { class: 'meter' }, el('i')), status = el('p', { class: 'status' }, 'Ready. Up to 10 seconds.');
    const recBtn = el('button', { class: 'btn primary big bigrec' }, '● Record');
    let rec = null, chunks = [], raf = 0, timer = 0, t0 = 0;
    const level = new Float32Array(an.fftSize);
    const draw = () => {
      an.getFloatTimeDomainData(level);
      let pk = 0; for (const x of level) pk = Math.max(pk, Math.abs(x));
      meter.firstChild.style.width = Math.min(100, Math.sqrt(pk) * 100) + '%';
      if (rec && rec.state === 'recording') status.textContent = `Recording… ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      raf = requestAnimationFrame(draw);
    };
    draw();
    const reset = msg => { status.textContent = msg; rec = null; recBtn.textContent = '● Record'; recBtn.disabled = false; };
    const cleanup = () => {
      cancelAnimationFrame(raf); clearTimeout(timer);
      try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch { }
      stream.getTracks().forEach(x => x.stop()); srcNode.disconnect();
    };
    recBtn.onclick = () => {
      if (!rec) {
        chunks = [];
        rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        rec.ondataavailable = e => chunks.push(e.data);
        rec.onstop = async () => {
          try {
            status.textContent = 'Trimming…';
            const buf = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
            const trimmed = trimSilence(buf);
            if (!trimmed) return reset('That was silent. Try again, closer to the mic.');
            const count = [...library.values()].filter(s => /^Mic \d+$/.test(s.name)).length + 1;
            const id = await addUserData(`Mic ${count}`, encodeWav([trimmed.data], trimmed.sampleRate));
            closeModal();
            await assignSound(t, id);
            toast(`Mic ${count} is on pad ${t + 1}`);
          } catch (err) { reset('Could not use that recording: ' + err.message); }
        };
        rec.start(); t0 = performance.now();
        recBtn.textContent = '■ Stop';
        timer = setTimeout(() => rec && rec.state === 'recording' && rec.stop(), 10000);
      } else if (rec.state === 'recording') { rec.stop(); recBtn.textContent = 'Working…'; recBtn.disabled = true; }
    };
    openModal(el('h2', {}, `Record a sound for pad ${t + 1}`),
      el('p', {}, 'Press Record, make your sound, press Stop. Silence at the start and end is cut off. Bang on pots, pans and metal for industrial hits, or record your voice.'),
      meter, recBtn, status,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel')));
    modalCleanup = cleanup;
  }

  // ---------------------------------------------------------------- chop a long sound across the pads
  function findHits(buf, max = 16) {
    const sr = buf.sampleRate, d = buf.getChannelData(0), hop = Math.round(sr * 0.01), frames = Math.floor(d.length / hop);
    const energy = new Float32Array(frames);
    for (let f = 0; f < frames; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) s += d[i] * d[i]; energy[f] = Math.sqrt(s / hop); }
    const flux = energy.map((e, f) => f ? Math.max(0, e - energy[f - 1]) : e);
    let peak = 1e-9;
    for (const x of flux) peak = Math.max(peak, x);
    const cands = [];
    for (let f = 1; f < frames - 1; f++) if (flux[f] > peak * 0.12 && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) cands.push(f);
    cands.sort((a, b) => flux[b] - flux[a]);
    const picked = [];
    for (const f of cands) { if (picked.every(p => Math.abs(p - f) >= 8)) picked.push(f); if (picked.length >= max) break; }
    picked.sort((a, b) => a - b);
    let loud = 0;
    for (const x of energy) loud = Math.max(loud, x);
    let first = 0;
    while (first < frames && energy[first] < loud * 0.05) first++;
    if (!picked.length || picked[0] - first > 8) { picked.unshift(first); if (picked.length > max) picked.pop(); }
    return picked.map(f => Math.max(0, f * hop / sr - 0.005));
  }
  async function chopDialog(file) {
    let buf;
    try { buf = await ctx.decodeAudioData(await file.arrayBuffer()); } catch { return toast(`Could not read ${file.name}`); }
    const name = file.name.replace(/\.[^.]+$/, '').slice(0, 24);
    let mode = 'hits';
    const cv = el('canvas', { height: 140 }), info = el('p', { class: 'status' });
    const slicesFor = () => {
      const dur = buf.duration;
      const starts = mode === 'even' ? Array.from({ length: 16 }, (_, i) => i * dur / 16) : findHits(buf);
      return starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : dur]);
    };
    let slices = slicesFor();
    const draw = () => {
      const w = cv.clientWidth || 640, h = 140, dpr = devicePixelRatio || 1;
      cv.width = w * dpr; cv.height = h * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / w));
      g.fillStyle = '#7c6cff';
      for (let x = 0; x < w; x++) {
        let pk = 0; for (let i = x * step; i < (x + 1) * step && i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
        g.fillRect(x, h / 2 - pk * h * 0.45, 1, Math.max(1, pk * h * 0.9));
      }
      g.font = '11px system-ui'; g.textBaseline = 'top';
      slices.forEach(([s], i) => {
        const x = s / buf.duration * w;
        g.fillStyle = '#ff4fd8'; g.fillRect(x, 0, 2, h);
        g.fillStyle = '#fff'; g.fillText(String(i + 1), x + 4, 4);
      });
      info.textContent = `${slices.length} slice${slices.length === 1 ? '' : 's'}. Click the picture to hear a slice. Slices go on pads 1 to ${slices.length}.`;
    };
    cv.addEventListener('click', e => {
      const r = cv.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * buf.duration;
      const sl = slices.find(([a, b]) => t >= a && t < b);
      if (!sl) return;
      const src = ctx.createBufferSource(); src.buffer = sliceBuffer(buf, sl[0], sl[1]); src.connect(live.M.duckIn); src.start();
    });
    const modeSeg = el('div', { class: 'seg' });
    const btns = [['hits', 'Find the hits'], ['even', '16 equal slices']].map(([v, label]) => el('button', { onclick: () => { mode = v; slices = slicesFor(); paint(); draw(); } }, label));
    const paint = () => btns.forEach((b, i) => b.setAttribute('aria-pressed', ['hits', 'even'][i] === mode));
    modeSeg.append(...btns); paint();
    const apply = async () => {
      const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
      const srcId = await addUserData(name, encodeWav(chans, buf.sampleRate), true);
      slices.forEach(([a, b], i) => {
        const id = `chp:${srcId.slice(4)}:${i}`, c = { name: `${name} ${i + 1}`, src: srcId, start: a, end: b };
        chops[id] = c; addChop(id, c);
        state.pads[i] = Object.assign({}, PAD_DEFAULT, { sound: id });
      });
      store.set('chops', chops);
      state.kit = { id: 'custom', name: `Chop: ${name}` };
      state.notes = null;
      closeModal(); closeBrowser();
      await preloadKit(); renderAll(); dirty();
      toast(`${slices.length} slices of "${name}" are on the pads`);
    };
    openModal(el('h2', {}, `Chop "${name}" across the pads`),
      el('p', {}, '"Find the hits" cuts at each drum hit or word. "16 equal slices" cuts it evenly, good for loops.'),
      modeSeg, cv, info,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: closeModal }, 'Cancel'), el('button', { class: 'btn primary', onclick: apply }, 'Put slices on the pads')));
    $('#modalCard').classList.add('wide');
    requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------------- wobble designer
  function wobbleDialog() {
    const t = target(), cur = library.get(state.pads[t].sound);
    const editing = cur && cur.kind === 'wob' ? cur : null;
    const p = Object.assign({}, WOB_DEFAULT, editing ? editing.params : {});
    let preview = null, renderTimer = 0, playing = false, version = 0;
    const playBtn = el('button', { class: 'btn primary' }, '▶ Play');
    const stopPreview = () => { if (preview) { try { preview.stop(); } catch { } preview = null; } };
    const startPreview = async () => {
      const v = ++version, buf = await SYNTH.renderWobble(p, state.bpm);
      if (!playing || v !== version) return;
      stopPreview();
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf; src.loop = true; g.gain.value = 0.75;
      src.connect(g).connect(live.M.duckIn); src.start();
      preview = src;
    };
    const changed = () => { if (playing) { clearTimeout(renderTimer); renderTimer = setTimeout(startPreview, 120); } };
    playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? '■ Stop' : '▶ Play'; playing ? startPreview() : stopPreview(); };
    const segRow = (label, key, opts) => {
      const box = el('div', { class: 'seg' });
      const btns = opts.map(([v, l]) => el('button', { onclick: () => { p[key] = v; paint(); changed(); } }, l));
      const paint = () => btns.forEach((b, i) => b.setAttribute('aria-pressed', opts[i][0] === p[key] || (typeof p[key] === 'number' && Math.abs(opts[i][0] - p[key]) < 1e-9)));
      box.append(...btns); paint();
      return el('div', { class: 'form-row' }, el('span', {}, label), box);
    };
    const sliderRow = (label, key, min, max, fmt, log) => {
      const toPos = v => log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
      const fromPos = x => log ? min * Math.pow(max / min, x) : min + x * (max - min);
      const input = el('input', { type: 'range', min: 0, max: 1, step: 0.001 }), out = el('output');
      const set = () => { out.textContent = fmt(p[key]); input.style.setProperty('--p', toPos(p[key]) * 100 + '%'); };
      input.value = toPos(p[key]);
      input.addEventListener('input', () => { p[key] = +fromPos(+input.value).toFixed(log ? 0 : 3); set(); changed(); });
      set();
      return el('div', { class: 'form-row' }, el('span', {}, label), el('div', { class: 'ctrl' }, input, out));
    };
    const nameIn = el('input', { type: 'text', value: editing ? editing.name : `Wobble ${Object.keys(wobbles).length + 1}`, maxlength: 30 });
    nameIn.addEventListener('keydown', e => e.stopPropagation());
    const save = asNew => {
      const name = nameIn.value.trim() || 'My wobble';
      const id = editing && !asNew ? editing.id : newId('wob');
      wobbles[id] = { name, params: Object.assign({}, p) };
      store.set('wobbles', wobbles);
      addWobble(id, wobbles[id]);
      ready.delete(id); renderedAt.delete(id);
      closeModal();
      assignSound(t, id);
      toast(`"${name}" is on pad ${t + 1}`);
    };
    const hz = v => v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz';
    openModal(
      el('h2', {}, editing ? `Edit "${editing.name}"` : 'Wobble designer'),
      el('p', {}, 'Shape your own wobble bass. It follows the tempo. Press Play and change things while it plays.'),
      el('div', { class: 'form' },
        segRow('Speed', 'rate', SPEEDS),
        segRow('Second half', 'rate2', [[0, 'Same'], ...SPEEDS]),
        segRow('Shape', 'shape', [['sine', 'Smooth'], ['tri', 'Triangle'], ['saw', 'Opening'], ['ramp', 'Closing'], ['square', 'Chop']]),
        segRow('Wave', 'wave', [['saw', 'Saw'], ['square', 'Square'], ['both', 'Both']]),
        sliderRow('Low', 'low', 40, 1000, hz, true),
        sliderRow('High', 'high', 300, 9000, hz, true),
        sliderRow('Resonance', 'reso', 0.5, 20, v => v.toFixed(1)),
        sliderRow('Growl', 'growl', 0, 1, pct),
        sliderRow('Grit', 'grit', 0, 1, pct),
        sliderRow('Sub', 'sub', 0, 1, pct),
        sliderRow('Width', 'width', 0, 30, v => Math.round(v) + ' ct'),
        el('div', { class: 'form-row' }, el('span', {}, 'Name'), nameIn)),
      el('div', { class: 'row' },
        playBtn, el('div', { class: 'grow' }),
        el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        editing ? el('button', { class: 'btn', onclick: () => save(true) }, 'Save as new') : null,
        el('button', { class: 'btn primary', onclick: () => save(false) }, editing ? 'Update' : `Put on pad ${t + 1}`)));
    $('#modalCard').classList.add('wide');
    modalCleanup = () => { playing = false; clearTimeout(renderTimer); stopPreview(); };
  }

  // ---------------------------------------------------------------- settings and help
  const SWATCHES = ['#ff2a2a', '#ff7a00', '#ffd000', '#9be000', '#00e040', '#00e0a0', '#00c8ff', '#2a5cff', '#8a3cff', '#e000ff', '#ff3c9a', '#ffffff'];
  function lightsDialog() {
    let picked = new Set([0]);
    const changed = () => { saveLights(); renderPads(); paint(); };
    const segRow = (label, opts, get, set) => {
      const btns = opts.map(([v, l]) => el('button', { onclick: () => { set(v); changed(); } }, l));
      const row = el('div', { class: 'form-row' }, el('span', {}, label), el('div', { class: 'seg' }, ...btns));
      row.paint = () => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opts[i][0] === get())));
      return row;
    };
    const onBtn = el('button', { class: 'btn toggle', title: 'Turn the pad lights on or off', onclick: () => {
      lightOpts.on = !lightOpts.on;
      if (lightOpts.on) chooseLink(); else lights.restore();
      changed();
    } });
    const status = el('p', { class: 'status' });
    const connectBtn = el('button', { class: 'btn sm', onclick: () => connectBt(true) }, 'Connect over Bluetooth');
    const soundColours = () => state.pads.map(p => { const info = p.sound && library.get(p.sound); return info ? CAT[info.cat].color : '#000000'; });
    const modeRow = segRow('Colors', [['sound', 'Sound colors'], ['mine', 'My colors'], ['own', 'Pad\'s own']], () => lightOpts.mode, v => {
      if (v === 'mine' && !lightOpts.mine) lightOpts.mine = soundColours();
      lightOpts.mode = v;
    });
    const cells = Array.from({ length: 16 }, (_, i) => el('button', {
      class: 'lcell', title: 'Pad ' + (i + 1),
      onclick: e => {
        if (lightOpts.mode !== 'mine') return;
        if (e.shiftKey || e.ctrlKey) { if (picked.has(i) && picked.size > 1) picked.delete(i); else picked.add(i); } else picked = new Set([i]);
        paint();
      },
    }, el('span', {}, String(i + 1))));
    // Laid out like the pad: pad 1 bottom left, pad 16 top right.
    const grid = el('div', { class: 'light-grid' }, ...[12, 8, 4, 0].flatMap(r => cells.slice(r, r + 4)));
    const setPicked = c => { for (const i of picked) lightOpts.mine[i] = c; changed(); };
    const custom = el('input', { type: 'color', title: 'Any color' });
    custom.addEventListener('input', () => setPicked(custom.value));
    const mineBox = el('div', { class: 'mine' },
      el('div', { class: 'swatches' }, ...SWATCHES.map(c => el('button', { style: `--c:${c}`, title: c, onclick: () => setPicked(c) })),
        el('button', { class: 'off', title: 'Off', onclick: () => setPicked('#000000') }), custom,
        el('button', { class: 'btn sm', onclick: () => { picked = new Set(cells.map((_, i) => i)); paint(); } }, 'All pads'),
        el('button', { class: 'btn sm', onclick: () => { lightOpts.mine = soundColours(); changed(); } }, 'Start from sound colors')),
      el('small', {}, 'Click a pad above, or hit it on your pad, then pick a color. Shift-click picks more than one.'));
    const brightIn = el('input', { type: 'range', min: 0.05, max: 1, step: 0.01, value: lightOpts.bright }), brightOut = el('output');
    brightIn.addEventListener('input', () => { lightOpts.bright = +brightIn.value; changed(); });
    const brightRow = el('div', { class: 'form-row' }, el('span', {}, 'Brightness'), el('div', { class: 'ctrl' }, brightIn, brightOut));
    const flashRow = segRow('When you hit', [[true, 'Flash'], [false, 'Nothing']], () => lightOpts.flash, v => { lightOpts.flash = v; });
    const beatRow = segRow('On the beat', [[true, 'Flash'], [false, 'Nothing']], () => lightOpts.beat, v => { lightOpts.beat = v; });
    const whiteRow = segRow('Flash color', [[false, 'Brighter'], [true, 'White']], () => lightOpts.white, v => { lightOpts.white = v; });
    const mineRow = el('div', { class: 'form-row' }, el('span', {}), mineBox);
    const paint = () => {
      onBtn.setAttribute('aria-pressed', String(lightOpts.on));
      onBtn.textContent = lightOpts.on ? 'On' : 'Off';
      status.textContent = lightsText();
      connectBtn.hidden = !(lightOpts.on && navigator.bluetooth && lights.status === 'nopad' && !btBusy);
      [modeRow, flashRow, beatRow, whiteRow].forEach(r => r.paint());
      brightOut.textContent = Math.round(lightOpts.bright * 100) + '%';
      brightIn.style.setProperty('--p', (lightOpts.bright - 0.05) / 0.95 * 100 + '%');
      brightRow.hidden = lightOpts.mode === 'own';
      whiteRow.hidden = lightOpts.mode === 'own' || !(lightOpts.flash || lightOpts.beat);
      mineRow.hidden = lightOpts.mode !== 'mine';
      const list = padLightList(), own = lights.own();
      cells.forEach((c, i) => {
        const col = lightOpts.mode === 'own' ? own[i] : list[i].base;
        c.style.setProperty('--c', col || 'transparent');
        c.classList.toggle('dark', !col || (lightOpts.mode !== 'own' && !list[i].level));
        c.classList.toggle('sel', lightOpts.mode === 'mine' && picked.has(i));
      });
      if (lightOpts.mode === 'mine') { const c = lightOpts.mine[[...picked][0]]; if (c && c !== '#000000') custom.value = c; }
    };
    lightsUi = paint;
    lightPick = i => { if (lightOpts.mode === 'mine') { picked = new Set([i]); paint(); } };
    openModal(
      el('div', { class: 'lights-head' }, el('h2', {}, 'Pad lights'), onBtn),
      el('div', { class: 'lights-status' }, status, connectBtn),
      el('div', { class: 'form' }, modeRow, el('div', { class: 'form-row' }, el('span', {}, 'Pads'), grid), mineRow, brightRow, flashRow, beatRow, whiteRow),
      el('small', {}, 'Thump never saves anything to your pad: its own colors come back when Thump closes or the lights are off. Switch presets on the pad (hold SHIFT and press a pad) and the lights follow.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
    modalCleanup = () => { lightsUi = () => { }; lightPick = null; };
    paint();
  }
  function settingsDialog() {
    const ins = midi ? [...midi.inputs.values()].filter(i => i.state === 'connected').map(i => i.name) : [];
    const lat = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000);
    openModal(el('h2', {}, 'Settings'),
      el('div', { class: 'settings-list' },
        el('div', { class: 'item' }, el('div', {}, el('b', {}, 'Sound delay'), el('p', {}, 'Time from a hit to the speakers, before Bluetooth delay.')), el('span', { class: 'mono' }, lat ? lat + ' ms' : 'unknown')),
        el('div', { class: 'item' }, el('div', {}, el('b', {}, 'MIDI inputs'), el('p', {}, ins.length ? ins.join(', ') : 'None connected')))),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
  }
  function showHelp() {
    openModal(
      el('h2', {}, 'Make your first beat'),
      el('ol', {},
        el('li', {}, 'Pick a kit at the top. The bottom row of pads is kick, snare and hi-hats.'),
        el('li', {}, 'Press Rec. You hear four clicks to count you in, then the pattern starts recording.'),
        el('li', {}, 'Play a simple kick and snare. The pattern goes round and round, so add hi-hats on the next pass, then bass.'),
        el('li', {}, 'Mess up? Undo takes away your last pass. Snap keeps your hits in time.'),
        el('li', {}, 'Press Rec again to stop recording. Save it from the Beats menu.')),
      el('h2', {}, 'Build a song'),
      el('ol', {},
        el('li', {}, 'Patterns A to H are separate loops. Copy to next makes a copy you can change, like a build-up or a drop.'),
        el('li', {}, 'While playing, click another pattern and it switches when the current pass ends.'),
        el('li', {}, '+ Add puts the current pattern on the song line. Click a part to play it 2, 4 or 8 times. Turn on Play song.'),
        el('li', {}, 'Save audio turns your pattern or song into an MP3 or WAV file.')),
      el('h2', {}, 'Sound tricks'),
      el('ul', {},
        el('li', {}, 'Dubstep sits around 140 BPM in half time: kick on beat 1, snare on beat 3.'),
        el('li', {}, 'Bass pads have Hold on: they play while you hold the pad. Design your own in the sound list with Design a wobble.'),
        el('li', {}, 'Pump makes everything duck when the kick hits, the classic EDM breathing sound. Swing makes the groove bounce.'),
        el('li', {}, 'Mute with pads lets you drop parts out live, like pulling the drums for a breakdown.'),
        el('li', {}, 'Set Repeat to 1/16 and hold a hi-hat for rolls, or hold a wobble for stutters.'),
        el('li', {}, 'Sweep the master Filter down before a drop and back to Off when it hits.'),
        el('li', {}, 'Record with mic: bang on metal for industrial hits. Chop a long sound: put a vocal or loop across the pads.'),
        el('li', {}, 'Lights (top bar) sets your pad\'s colors: sound colors, your own, or the pad\'s own, with flashes as pads play. Works over USB or Bluetooth.')),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: closeModal }, 'Got it')));
  }
  let modalCleanup = null;
  function openModal(...kids) {
    if (modalCleanup) { const c = modalCleanup; modalCleanup = null; c(); }
    $('#modalCard').className = 'modal-card';
    $('#modalCard').replaceChildren(...kids);
    $('#modal').hidden = false;
  }
  function closeModal() {
    if (modalCleanup) { const c = modalCleanup; modalCleanup = null; c(); }
    $('#modal').hidden = true;
  }
  function confirmDialog(text, yes, fn) {
    openModal(el('p', {}, text), el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn primary', onclick: () => { closeModal(); fn(); } }, yes)));
  }
  function toast(text) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const t = el('div', { class: 'toast' }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 2800);
  }

  function renderAll() {
    renderKitSel(); renderPads(); renderPanel(); renderPatterns(); renderSong(); updateTransport(); updateProgressTicks(); drawLoop();
    for (const [k] of masterCtrlDefs) setCtrl('master', k, state.master[k]);
  }

  // ---------------------------------------------------------------- input
  function bindKeys() {
    addEventListener('keydown', e => {
      const t = e.target;
      if (t.matches && t.matches('input[type=text], input[type=search], input[type=number], select')) return;
      if (e.ctrlKey || e.metaKey) { if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); } return; }
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) togglePlay(); return; }
      if (e.code === 'Escape') {
        const open = !$('#browser').hidden || !$('#modal').hidden || !$('#beatMenu').hidden;
        closeBrowser(); closeModal(); $('#beatMenu').hidden = true;
        if (!open) silence();
        return;
      }
      const i = KEYS.indexOf(e.code);
      if (i < 0 || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) padDown(i, e.shiftKey ? 127 : 100, 'k');
    });
    addEventListener('keyup', e => { const i = KEYS.indexOf(e.code); if (i >= 0) padUp(i, 'k'); });
    addEventListener('blur', () => { for (const [k, h] of [...held]) padUp(h.grid, k[0]); });
    document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
    // Give the keyboard back to the pads after a dropdown or the tempo box is used.
    document.addEventListener('change', e => { if (e.target.matches('select, input[type=number]')) e.target.blur(); });
    $('#bpmIn').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  }

  // Timers on the page slow down when the window is in the background, which would
  // stall the loop. A worker's timer keeps running; fall back to the page timer.
  function startClock() {
    let fallback = null;
    const useFallback = () => { if (!fallback) fallback = setInterval(tick, 25); };
    try {
      const w = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 25);'], { type: 'text/javascript' })));
      w.onmessage = tick;
      w.onerror = useFallback;
    } catch { useFallback(); }
  }

  // ---------------------------------------------------------------- self test (index.html?selftest)
  async function selftest() {
    const out = [], ok = (c, m) => out.push((c ? 'PASS ' : 'FAIL ') + m);
    for (const pre of PRESETS) {
      ok(pre.pads.length === 16, `${pre.id}: 16 pads`);
      const missing = pre.pads.map(e => Array.isArray(e) ? e[0] : e).filter(id => !library.has(id));
      ok(!missing.length, `${pre.id}: all sounds exist ${missing.join(' ')}`);
    }
    const peakOf = (n, get) => { let pk = 0, bad = 0; for (let c = 0; c < n; c++) for (const v of get(c)) { if (v !== v) bad++; else pk = Math.max(pk, Math.abs(v)); } return [pk, bad]; };
    const bufPeak = b => peakOf(b.numberOfChannels, c => b.getChannelData(c));
    for (const s of SYNTH.sounds) {
      try {
        const b = await SYNTH.render(s.id, 140), [peak, bad] = bufPeak(b);
        ok(b.length > 100 && peak > 0.5 && peak < 1.01 && !bad, `${s.id}: ${b.duration.toFixed(2)}s peak ${peak.toFixed(2)}`);
      } catch (err) { ok(false, `${s.id}: ${err.message}`); }
    }
    for (const shape of ['sine', 'tri', 'saw', 'ramp', 'square']) for (const [rate, rate2, wave, growl] of [[0.5, 0, 'both', 0], [1 / 3, 0.25, 'saw', 0.6], [2, 1 / 6, 'square', 1]]) {
      const b = await SYNTH.renderWobble(Object.assign({}, WOB_DEFAULT, { shape, rate, rate2, wave, growl }), 140), [peak, bad] = bufPeak(b);
      ok(Math.abs(b.duration - 4 * 60 / 140) < 0.01 && peak > 0.5 && !bad, `wobble ${shape} ${wave} rate ${rate.toFixed(2)}/${rate2.toFixed(2)} growl ${growl}`);
    }
    let decoded = 0;
    for (const s of SAMPLES.sounds) { try { const l = await decodeLayers(s.layers); if (l[0].buf.length) decoded++; } catch { } }
    ok(decoded === SAMPLES.sounds.length, `decoded ${decoded}/${SAMPLES.sounds.length} samples`);

    // timing
    let p = placeHit(3.9, 8, 0.25); ok(p.beat === 4 && p.skip === 4, 'snap forward skips the doubled hit');
    p = placeHit(4.1, 8, 0.25); ok(p.beat === 4 && p.skip === null, 'snap back has no skip');
    p = placeHit(7.95, 8, 0.25); ok(p.beat === 0 && p.skip === 8, 'snap wraps to the start');
    p = placeHit(1.3, 8, 0); ok(Math.abs(p.beat - 1.3) < 1e-9, 'no snap keeps raw position');
    state.master.swing = 0.66;
    ok(Math.abs(swingOffset(0.25) - 0.08) < 1e-9 && swingOffset(0.5) === 0 && swingOffset(0) === 0 && Math.abs(swingOffset(1.75) - 0.08) < 1e-9, 'swing moves only the off 16ths');
    state.master.swing = 0.5;
    ok(swingOffset(0.25) === 0, 'swing 50% is straight');

    // song order
    state.patterns[0].bars = 1; state.patterns[1].bars = 2;
    state.song = [{ pat: 0, reps: 2 }, { pat: 1, reps: 1 }]; state.songMode = true; state.songLoop = false;
    const order = [];
    for (let g = firstSeg(); g && order.length < 6; g = nextSeg(g)) order.push(LETTERS[g.pat] + '@' + g.start);
    ok(order.join(' ') === 'A@0 A@4 B@8', 'song plays A A B then ends: ' + order.join(' '));
    state.songLoop = true;
    const order2 = [];
    for (let g = firstSeg(), k = 0; g && k < 5; g = nextSeg(g), k++) order2.push(LETTERS[g.pat]);
    ok(order2.join('') === 'AABAA', 'song loops back to the start');
    state.songMode = false; state.pat = 1;
    seq.queued = 0;
    const q = nextSeg(firstSeg());
    ok(q.pat === 0 && seq.queued === null && nextSeg(q).pat === 0, 'queued pattern takes over at the end of the pass');
    state.song = []; state.pat = 0;

    // notes
    state.notes = { src: 8, scale: 'minor', root: 0 };
    ok(noteSemis(0) === 0 && noteSemis(7) === 12 && noteSemis(15) === 26, 'notes mode minor scale');
    ok(gridIndexFor(8, 12) === 7, 'notes map back to pads');
    state.notes = null;

    // old beats load
    const v1 = loadBeat({ v: 1, pads: freshState().pads, bpm: 120, bars: 4, events: [{ pad: 0, beat: 1, vel: 90, semis: 0, dur: 0.25 }] });
    ok(v1.patterns[0].bars === 4 && v1.patterns[0].events.length === 1 && v1.patterns.length === 8, 'version 1 beats load into pattern A');

    // export: render, pump, WAV and MP3
    state.pads = PRESETS[0].pads.map(normPad);
    state.patterns[0] = { bars: 1, events: [0, 1, 2, 3].map(b => ({ pad: 0, beat: b, vel: 110, semis: 0, dur: 0.25 })).concat([{ pad: 8, beat: 0, vel: 100, semis: 0, dur: 2 }]) };
    state.master.pump = 0.8;
    const r = await renderOffline([{ pat: 0, start: 0, len: 4 }], 4);
    const [rpk] = peakOf(2, c => r.channels[c]);
    ok(rpk > 0.1 && r.channels[0].length >= Math.floor(4 * 60 / 140 * 44100), `offline render has sound (peak ${rpk.toFixed(2)}, ${(r.channels[0].length / 44100).toFixed(2)}s)`);
    const wav = new DataView(encodeWav(r.channels, r.sampleRate));
    ok(wav.getUint32(0) === 0x52494646 && wav.getUint16(22, true) === 2 && wav.getUint32(24, true) === 44100, 'WAV header');
    const mp3 = new Uint8Array(await (await encodeMp3(r.channels, r.sampleRate)).arrayBuffer());
    ok(mp3.length > 5000 && mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, `MP3 frames (${mp3.length} bytes)`);
    const back = await ctx.decodeAudioData(mp3.buffer.slice(0));
    ok(Math.abs(back.duration - r.channels[0].length / 44100) < 0.2, `MP3 decodes to the right length (${back.duration.toFixed(2)}s)`);
    state.master.pump = 0;

    // mic trim and chopping
    const tb = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }), td = tb.getChannelData(0);
    for (let i = 12000; i < 24000; i++) td[i] = Math.sin(i / 10) * 0.5;
    const tr = trimSilence(tb);
    ok(tr && Math.abs(tr.data.length / 48000 - (0.25 + 0.008 + 0.06)) < 0.02, 'mic trim cuts silence');
    const hb = new AudioBuffer({ length: 48000 * 2, sampleRate: 48000, numberOfChannels: 1 }), hd = hb.getChannelData(0);
    [0.1, 0.6, 1.1, 1.6].forEach(t => { const s = Math.round(t * 48000); for (let i = 0; i < 4000; i++) hd[s + i] = Math.exp(-i / 800) * Math.sin(i / 3); });
    const hits = findHits(hb);
    ok(hits.length === 4 && hits.every((h, i) => Math.abs(h - [0.1, 0.6, 1.1, 1.6][i]) < 0.03), 'chopper finds the hits: ' + hits.map(h => h.toFixed(2)).join(' '));
    ok(Math.abs(sliceBuffer(hb, 0.6, 1.1).duration - 0.5) < 0.001, 'slice length');

    // Pad lights: the codec against bytes captured from M-VAVE's editor, then a pretend Pocket
    // that, like the real one, ignores colour writes until its whole memory has been read.
    {
      const hx = a => a.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
      ok(hx(SMC.toMidi(SMC.packet(0x11, []))) === 'F0 00 32 45 00 00 00 40 7F F7', 'lights: identity request bytes');
      ok(hx(SMC.toMidi(SMC.read(4, 0, 12))) === 'F0 00 32 0D 41 00 00 00 02 00 00 00 00 40 01 00 00 6F 01 F7', 'lights: read request bytes');
      ok(hx(SMC.toMidi(SMC.write(5, 0x126, [255, 0, 0]))) === 'F0 00 32 09 59 00 00 40 02 26 02 00 00 30 00 00 00 7F 01 00 08 0D F7', 'lights: colour write bytes');
      const reply0 = SMC.parse(SMC.fromMidi([0xF0, 0x00, 0x32, 0x01, 0x08, 0x00, 0x00, 0x00, 0x00, 0x7F, 0x01, 0xF7]));
      ok(reply0 && reply0.cmd === 0 && reply0.data.length === 1 && reply0.data[0] === 0, 'lights: decodes the pad\'s OK reply');
      const sent = [];
      usbLink({ id: 'x', send: b => sent.push(b) }).send(SMC.packet(0x11, []));
      ok(hx(sent[0]) === 'F0 00 32 45 00 00 00 40 7F F7', 'lights: USB wraps packets in SysEx');
      const got = [], join = SMC.joiner(p => got.push(p.cmd)), pk = SMC.packet(0x23, Array.from({ length: 600 }, (_, i) => i & 255));
      join(pk.slice(0, 3)); join(pk.slice(3, 500)); join([...pk.slice(500), ...SMC.packet(0x00, [0])]); join([9, 9, 9]); join(SMC.packet(0x11, [1]));
      ok(got.join() === '35,0,17', `lights: joins Bluetooth notifications into packets (${got.join()})`);
      {
        // Each piece handed over twice at once (seen on Linux), then a real repeat later on.
        let t = 0; const seen = [], feed = SMC.unrepeat(SMC.joiner(p => seen.push(p.data.length)), () => t);
        for (const piece of [pk.slice(0, 300), pk.slice(300)]) { feed(piece); t += 0.1; feed(piece.slice()); t += 20; }
        const short = SMC.packet(0x23, [4, 0, 0, 0, 0, 12, 0, 0]);
        feed(short); t += 450; feed(short.slice());
        ok(seen.join() === '600,8,8', `lights: drops notifications handed over twice, keeps real repeats (${seen.join()})`);
      }

      // The pretend pad: preset 1, with pads 1 and 2 of bank 3 swapped in its note layout.
      const mem = new Uint8Array(POCKET.size);
      for (let pr = 0; pr < 4; pr++) for (let r = 0; r < 112; r++) mem.set([0, 9, 4 + r, 0, 127, 250, 250, 0, 255], pr * POCKET.preset + r * 26);
      mem[32 * 26 + 2] = 37; mem[33 * 26 + 2] = 36;
      let unlocked = false, on = true, biggest = 0;
      const L = makeLights({ enabled: () => on, key: null });
      const link = {
        kind: 'mock', id: 'mock',
        send(b) {
          const q = SMC.parse(b);
          if (!q) return;
          biggest = Math.max(biggest, b.length);
          const d = q.data, a = d[1] | d[2] << 8 | d[3] << 16 | d[4] << 24, n = d[5] | d[6] << 8 | d[7] << 16;
          const reply = (cmd, data) => setTimeout(() => link.onPacket && link.onPacket(SMC.parse(SMC.packet(cmd, data))), 1);
          if (q.cmd === 0x11) reply(0x11, [...'SMC-PAD Pocket_004'].map(c => c.charCodeAt(0)).concat(Array(9).fill(0)));
          else if (q.cmd === 0x23) {
            if (d[0] === 5 && a + n >= POCKET.size) unlocked = true;
            reply(0x23, [...d.slice(0, 8), ...(d[0] === 4 ? [0xA0, 0, 0x32, 2, 0, 0, 0, 0, 0, 0, 0, 0] : mem.slice(a, a + n))]);
          } else if (q.cmd === 0x22) { if (unlocked) mem.set(d.slice(8, 8 + n), a); reply(0x00, [0]); }
        },
      };
      const settle = async () => { await sleep(20); for (let t = 0; t < 300 && L.busy; t++) await sleep(10); };
      const at = (g, i) => [...mem.slice((g * 16 + i) * 26 + 5, (g * 16 + i) * 26 + 8)].join();
      L.attach(link);
      L.setPads(Array.from({ length: 16 }, (_, i) => ({ base: i < 15 ? '#ff5d5d' : null, level: 0.22 })));
      await settle();
      ok(L.status === 'on' && L.model === 'SMC-PAD Pocket_004', `lights: connects to a pretend Pocket (${L.status})`);
      const idleRed = at(2, 0).split(',').map(Number);
      ok(idleRed[0] > 40 && idleRed[0] < 70 && idleRed[1] < 15 && at(2, 14) === at(2, 0), `lights: pads 1-15 dim red (${at(2, 0)})`);
      ok(at(2, 15) === '0,0,0' && at(3, 0) === '250,250,0', 'lights: empty pad dark, other banks untouched');
      L.flash(0, 127);
      await sleep(40);
      const lit = at(2, 0).split(',').map(Number);
      ok(lit[0] > 200 && lit[1] > idleRed[1], `lights: a hit flashes the pad (${at(2, 0)})`);
      await sleep(150); await settle();
      ok(at(2, 0) === idleRed.join(), 'lights: and it goes back to dim');
      L.flash(3, 40, true);
      await sleep(40);
      ok(at(2, 3) === '250,250,250', `lights: white flashes (${at(2, 3)})`);
      await sleep(150); await settle();
      ok(L.padFor(9, 37) === 0 && L.padFor(9, 36) === 1 && L.padFor(9, 39) === 3 && L.padFor(0, 36) === null, 'lights: reads which pad sent a note from the pad\'s own layout');
      ok(L.padFor(9, 52) === 0 && L.where.group === 3, 'lights: follows the pad to bank 4');
      await settle();
      ok(at(3, 0) === idleRed.join(), 'lights: and lights that bank');
      L.setPads(Array.from({ length: 16 }, () => ({ own: true, level: 1 })));
      await settle();
      ok(at(3, 0) === '250,250,0' && L.own()[0] === '#fafa00', 'lights: "pad\'s own" shows the pad\'s colours');
      const teal = () => L.setPads(Array.from({ length: 16 }, () => ({ base: '#2ee6c0', level: 0.22 })));
      teal(); await settle();
      on = false; L.restore();
      await settle();
      ok(at(2, 0) === '250,250,0' && at(2, 15) === '250,250,0' && at(3, 0) === '250,250,0', 'lights: turning them off puts the pad\'s colours back');
      on = true; teal(); await settle();
      L.restoreNow();
      await sleep(20);
      ok(at(2, 0) === '250,250,0' && at(3, 0) === '250,250,0' && at(2, 7) === '250,250,0', 'lights: closing Thump puts the pad\'s colours back in one message');
      L.attach(null); link.kind = 'bt'; L.attach(link); // a new session, now over Bluetooth
      teal(); await settle();
      L.padFor(9, 36); await settle(); // bank 3 as well, so the restore spans 32 pads
      ok(at(2, 1) !== '250,250,0' && at(3, 0) !== '250,250,0', 'lights: a new session finds the pad\'s colours again');
      biggest = 0; L.restoreNow();
      await sleep(20);
      ok(biggest > 0 && biggest <= 512 && at(2, 0) === '250,250,0' && at(3, 0) === '250,250,0', `lights: over Bluetooth the restore fits 512-byte writes (${biggest})`);
      L.attach(null);
    }
    const fails = out.filter(l => l.startsWith('FAIL')).length;
    const pre = $('#selftest');
    pre.hidden = false;
    pre.textContent = `SELFTEST ${fails ? 'FAIL' : 'PASS'} (${out.length - fails}/${out.length})\n` + out.join('\n');
    document.title = 'SELFTEST ' + (fails ? 'FAIL' : 'PASS');
  }

  // ---------------------------------------------------------------- start
  async function init() {
    buildPads(); buildPanel(); buildTransport(); buildBeatMenu(); bindKeys();
    $('#kitSel').onchange = e => loadPreset(e.target.value);
    $('#helpBtn').onclick = showHelp;
    $('#settingsBtn').onclick = settingsDialog;
    $('#lightsBtn').onclick = lightsDialog;
    $('#exportBtn').onclick = exportDialog;
    $('#browserClose').onclick = closeBrowser;
    $('#search').addEventListener('input', () => renderBrowser());
    $('#search').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeBrowser(); });
    $('#addFileBtn').onclick = () => $('#fileIn').click();
    $('#fileIn').onchange = async e => {
      let last = null;
      for (const f of e.target.files) last = (await addUserFile(f)) || last;
      e.target.value = '';
      if (last) { browserCat = 'user'; assignSound(target(), last); renderBrowser(); }
    };
    $('#micBtn').onclick = micDialog;
    $('#wobBtn').onclick = wobbleDialog;
    $('#chopBtn').onclick = () => $('#chopIn').click();
    $('#chopIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) chopDialog(f); };
    $('#muteBtn').onclick = () => setMuteMode(!muteMode);
    $('#muteDone').onclick = () => setMuteMode(false);
    $('#rowsBtn').onclick = () => { allRows = !allRows; $('#rowsBtn').setAttribute('aria-pressed', allRows); drawLoop(); };
    $('#loopCanvas').addEventListener('click', loopClick);
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
    addEventListener('resize', drawLoop);
    const gate = $('#audioGate');
    gate.onclick = () => ctx.resume();
    ctx.onstatechange = () => { gate.hidden = ctx.state === 'running'; };
    setTimeout(() => { gate.hidden = ctx.state === 'running'; }, 600);

    if (location.search.includes('selftest')) { renderAll(); return selftest(); }

    await loadUserSounds();
    state = loadBeat(store.get('session', null));
    applyMaster();
    renderAll();
    preloadKit();
    initMidi();
    // Closing: put the pad's own colours back. A Bluetooth write still needs the browser for
    // a moment after the page lets go of it, so the page waits briefly before closing.
    let closing = false;
    const restoreOnClose = () => {
      if (closing) return;
      closing = true;
      if (lights.restoreNow() && lights.kind === 'bt') { const t = performance.now(); while (performance.now() - t < 400) { } }
    };
    window.addEventListener('beforeunload', restoreOnClose);
    window.addEventListener('pagehide', restoreOnClose);
    startClock();
    if (!store.get('seenHelp2', false)) { store.set('seenHelp2', true); showHelp(); }
  }
  // Test hooks for tools/cdp.mjs.
  window.thump = { lights, makeLights, SMC, lightOpts, lightsDialog, connectBt, chooseLink, get state() { return state; }, seq, play, stop, padDown, padUp, renderAll, chopDialog, wobbleDialog, micDialog, exportDialog, settingsDialog, toggleMute, choosePattern, copyToNext };
  init();
})();
