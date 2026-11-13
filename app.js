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
    M.an = ac.createAnalyser(); M.an.fftSize = 2048; M.an.smoothingTimeConstant = 0; // the display does its own smoothing
    M.out.connect(M.an);
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
  const cleanPad = p => Object.assign({}, PAD_DEFAULT, p, { sound: library.has(p && p.sound) ? p.sound : null });
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
  // Your kits: 16 pads saved under a name, next to the ready-made kits. id -> { name, bpm, pads }
  const userKits = store.get('kits', {});
  // The pad's four presets each hold a kit (the Pocket picks its preset when it is switched on
  // with pad 13-16 held). slots[n] is { kit: { id, name }, pads } as you left it, so edits stay
  // with their preset.
  const padPresets = Object.assign({ follow: true, slot: 0, slots: null }, store.get('presets', {}));
  const savePresets = () => store.set('presets', padPresets);
  const currentSlot = () => ({ kit: { id: state.kit.id, name: state.kit.name }, pads: state.pads.map(p => Object.assign({}, p)) });
  const undoStack = [];
  const pat = () => state.patterns[state.pat];
  const spb = () => 60 / state.bpm;

  let saveTimer = null;
  function dirty() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      store.set('session', beatData());
      if (padPresets.slots) { padPresets.slots[padPresets.slot] = currentSlot(); savePresets(); }
    }, 400);
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
    s.pads = d.pads.map(cleanPad);
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
    for (const i of [...latched.keys()]) unlatch(i);
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

  // ---------------------------------------------------------------- pad controls
  // Any pad can work a control instead of playing its sound, like the pad's own control mode.
  // Controls belong to the pads, not the kit: they stay put when you switch kits or presets,
  // and the kit keeps the pad's sound for when you set it back. [id, name, what it does, held?]
  const CONTROLS = [
    ['Note repeat', [
      ['repHold', 'Repeat (hold)', 'Hold this pad and hit others: they repeat in time while you hold them.', true],
      ['repToggle', 'Repeat on/off', 'Turns note repeat on and off. Then holding any pad repeats it in time.'],
      ['repNext', 'Repeat rate', 'Steps note repeat through 1/8, 1/16, 1/16T, 1/32 and off.'],
    ]],
    ['Latch', [
      ['latch', 'Latch', 'While latch is on, held sounds and repeats keep going when you let go. Hit that pad again to stop it.'],
      ['stopAll', 'Stop all sound', 'Stops every sound that is playing, latched ones too. The beat keeps going.'],
    ]],
    ['Presets (kits)', [
      ...[0, 1, 2, 3].map(n => ['preset' + n, `Preset ${n + 1}`, `Switches to preset ${n + 1} and the kit on it.`]),
      ['presetNext', 'Next preset', 'Switches to the next of the four presets.'],
      ['presetPrev', 'Previous preset', 'Switches to the previous preset.'],
    ]],
    ['Patterns', [
      ['patNext', 'Next pattern', 'Goes to the next pattern with hits in it. While the beat plays, it switches at the end of the pass.'],
      ['patPrev', 'Previous pattern', 'Goes to the previous pattern with hits in it.'],
    ]],
    ['Groove and tempo', [
      ['swing', 'Swing', 'Steps swing through straight, 54%, 58%, 62% and 66%.'],
      ['tap', 'Tap tempo', 'Hit it in time, three times or more, to set the tempo.'],
      ['click', 'Metronome', 'Turns the click on and off.'],
    ]],
    ['Transport', [
      ['play', 'Play / stop', 'Starts and stops the beat.'],
      ['rec', 'Record', 'Starts recording with a count-in, or turns recording on and off while playing.'],
      ['undo', 'Undo', 'Takes back the last change to the patterns.'],
      ['mute', 'Mute (hold)', 'Hold this pad and hit others to mute or unmute them in the beat.', true],
    ]],
  ];
  const CTL = Object.fromEntries(CONTROLS.flatMap(([, list]) => list.map(([id, name, help, hold]) => [id, { id, name, help, hold: !!hold }])));
  const controls = (a => Array.from({ length: 16 }, (_, i) => CTL[a[i]] ? a[i] : null))(Array.isArray(store.get('controls')) ? store.get('controls') : []);
  const SWINGS = [0.5, 0.54, 0.58, 0.62, 0.66];
  let latch = false, lastRate = 0.25, repHeld = 0, repBefore = 0;
  const latched = new Map();
  const rateName = v => (REPEATS.find(([r]) => Math.abs(r - v) < 1e-9) || [0, 'Off'])[1];
  const shortKit = name => name.replace(/ \(edited\)$/, '').split(/ \/ | \(/)[0] + (/ \(edited\)$/.test(name) ? '*' : '');
  // Let go of a pad (held or latched) before it changes what it does.
  function freePad(i) {
    for (const [k, h] of [...held]) if (h.grid === i) padUp(i, k[0]);
    unlatch(i);
  }
  function setControl(i, id) {
    freePad(i);
    controls[i] = CTL[id] ? id : null;
    store.set('controls', controls);
    renderPads(); renderPanel(); renderPresetKeys();
  }
  function setRepeat(v) {
    state.repeat = v;
    if (v) lastRate = v;
    segs.forEach(f => f());
  }
  // Pads you are already holding start repeating when repeat comes on.
  function repeatHeld() {
    for (const h of held.values()) if (!h.ctl && !h.repeat && state.repeat > 0) { if (h.voice) live.cut(h.voice, 0); h.voice = null; h.repeat = startRepeat(h); }
  }
  function stepPattern(dir) {
    const cur = seq.playing ? seq.queued ?? (seq.seg ? seq.seg.pat : state.pat) : state.pat;
    const used = state.patterns.map((p, k) => p.events.length ? k : -1).filter(k => k >= 0);
    const pool = used.some(k => k !== cur) ? used : [...Array(PATS).keys()];
    for (let s = 1; s <= PATS; s++) {
      const k = mod(cur + dir * s, PATS);
      if (pool.includes(k)) { choosePattern(k); return toast(`Pattern ${LETTERS[k]}` + (seq.playing && seq.queued === k ? ' next' : '')); }
    }
  }
  function ctlDown(id) {
    const pre = /^preset(\d)$/.exec(id);
    if (pre || id === 'presetNext' || id === 'presetPrev') {
      const n = pre ? +pre[1] : mod(padPresets.slot + (id === 'presetNext' ? 1 : -1), 4);
      goSlot(n);
      toast(`Preset ${n + 1}: ${state.kit.name}`);
    } else switch (id) {
      case 'repHold': if (!repHeld++) { repBefore = state.repeat; if (!state.repeat) setRepeat(lastRate); repeatHeld(); } break;
      case 'repToggle': setRepeat(state.repeat ? 0 : lastRate); repeatHeld(); toast(state.repeat ? `Repeat ${rateName(state.repeat)}` : 'Repeat off'); break;
      case 'repNext': {
        const k = REPEATS.findIndex(([r]) => Math.abs(r - state.repeat) < 1e-9);
        setRepeat(REPEATS[(k + 1) % REPEATS.length][0]); repeatHeld();
        toast(state.repeat ? `Repeat ${rateName(state.repeat)}` : 'Repeat off');
        break;
      }
      case 'latch':
        latch = !latch;
        if (!latch) for (const i of [...latched.keys()]) unlatch(i);
        toast(latch ? 'Latch on: held sounds keep going until you hit the pad again' : 'Latch off');
        break;
      case 'stopAll': silence(); break;
      case 'patNext': stepPattern(1); break;
      case 'patPrev': stepPattern(-1); break;
      case 'swing': {
        const v = SWINGS.find(x => x > state.master.swing + 0.005) ?? SWINGS[0];
        state.master.swing = v; applyMaster(); setCtrl('master', 'swing', v); dirty();
        toast(v < 0.505 ? 'Swing off (straight)' : `Swing ${Math.round(v * 100)}%`);
        break;
      }
      case 'tap': tapTempo(); break;
      case 'click': state.click = !state.click; updateTransport(); dirty(); break;
      case 'play': togglePlay(); break;
      case 'rec': toggleRec(); break;
      case 'undo': undo(); break;
      case 'mute': setMuteMode(true); break;
    }
    ctlRefresh();
  }
  function ctlUp(id) {
    if (id === 'repHold' && repHeld > 0 && --repHeld === 0 && !repBefore) {
      setRepeat(0);
      for (const h of held.values()) if (h.repeat) { repeats.delete(h.repeat); h.repeat = null; }
    }
    if (id === 'mute') setMuteMode(false);
    ctlRefresh();
  }
  // What a control pad shows: is it on, and a word or two under its name.
  function ctlState(id) {
    const pre = /^preset(\d)$/.exec(id);
    if (pre) {
      const n = +pre[1], s = padPresets.slots && padPresets.slots[n];
      return [padPresets.slot === n, shortKit(n === padPresets.slot ? state.kit.name : s ? s.kit.name : '')];
    }
    switch (id) {
      case 'repHold': return [repHeld > 0, rateName(state.repeat || lastRate)];
      case 'repToggle': case 'repNext': return [state.repeat > 0, rateName(state.repeat)];
      case 'latch': return [latch, latch ? 'On' : 'Off'];
      case 'swing': return [state.master.swing > 0.505, state.master.swing < 0.505 ? 'Straight' : Math.round(state.master.swing * 100) + '%'];
      case 'tap': return [false, state.bpm + ' BPM'];
      case 'click': return [state.click, state.click ? 'On' : 'Off'];
      case 'play': return [seq.playing, seq.playing ? 'Playing' : 'Stopped'];
      case 'rec': return [seq.recording, seq.recording ? 'Recording' : 'Off'];
      case 'mute': return [muteMode, 'Hold + hit pads'];
      case 'patNext': case 'patPrev': return [false, 'Pattern ' + LETTERS[seq.queued ?? state.pat]];
      case 'presetNext': case 'presetPrev': return [false, 'Preset ' + (padPresets.slot + 1)];
      default: return [false, CTL[id].hold ? 'Hold' : 'Control'];
    }
  }
  // Right-click on a pad: what it does, as a menu right where you clicked.
  function padMenu(i, x, y) {
    select(i);
    const menu = $('#padMenu'), cur = controls[i] || '', info = state.pads[i].sound && library.get(state.pads[i].sound);
    const item = (id, name) => el('button', { class: id === cur ? 'cur' : null, onclick: () => { menu.hidden = true; setControl(i, id); } }, name);
    menu.replaceChildren(
      el('div', { class: 'sub' }, `Pad ${i + 1} does`),
      item('', 'Play its sound' + (info ? `: ${info.name}` : '')),
      ...CONTROLS.map(([label, list]) => el('div', { class: 'pm-group' }, el('div', { class: 'sub' }, label), el('div', { class: 'pm-items' }, ...list.map(([id, name]) => item(id, name))))));
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  }
  // Keeps the control pads (and their lights) up to date; cheap enough to run every frame.
  let ctlSig = null;
  function ctlRefresh() {
    let sig = '';
    for (let i = 0; i < 16; i++) {
      const id = controls[i], pad = padEls[i];
      if (!id || !pad || !pad.classList.contains('ctl')) continue;
      const [on, text] = ctlState(id);
      sig += i + (on ? '+' : '-');
      pad.classList.toggle('on', on);
      const cat = pad.querySelector('.cat');
      if (cat.textContent !== text) cat.textContent = text;
    }
    if (sig !== ctlSig) { ctlSig = sig; lights.setPads(padLightList()); }
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
    const key = source + i;
    if (controls[i]) {
      if (held.has(key)) return;
      held.set(key, { ctl: controls[i], grid: i });
      if (!state.notes && sel !== i) select(i);
      padEls[i] && padEls[i].classList.add('held');
      flashPad(i, 90);
      ctlDown(controls[i]);
      return;
    }
    if (muteMode && !state.notes) { toggleMute(i); flashPad(i, 60); return; }
    // With latch on, hitting a pad that is still going stops it.
    if (latched.has(i)) { unlatch(i); return; }
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
    // Latch keeps a held sound or a repeat going after you let go.
    if (!h.ctl && latch && (h.repeat || (h.voice && h.voice.hold)) && !latched.has(i)) { latched.set(i, h); return; }
    if (![...held.values()].some(x => x.grid === i) && !latched.has(i)) padEls[i] && padEls[i].classList.remove('held');
    if (h.ctl) return ctlUp(h.ctl);
    endHit(h);
  }
  function endHit(h) {
    if (h.voice && h.voice.hold) live.release(h.voice);
    if (h.ev) finishHit(h.ev);
    if (h.repeat) repeats.delete(h.repeat);
  }
  function unlatch(i) {
    const h = latched.get(i);
    if (!h) return;
    latched.delete(i);
    endHit(h);
    if (![...held.values()].some(x => x.grid === i)) padEls[i] && padEls[i].classList.remove('held');
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
      // Right-click opens a menu of what the pad does, without playing it.
      pad.addEventListener('contextmenu', e => { e.preventDefault(); if (!state.notes) padMenu(i, e.clientX, e.clientY); });
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

  // enabled: the lights are on. session: keep talking to the pad (lights on, or following its
  // presets). onPreset(n): the pad is on preset n (0-3), told after every read of its settings.
  function makeLights({ enabled, session = enabled, key, onState = () => { }, onPreset = () => { } }) {
    let link = null, ready = false, running = false, wake = null, waiter = null, failures = 0, lastPoll = 0;
    let glob = null, preset = 0, group = 2, model = '', status = 'nopad', saveTimer = 0;
    let mem = null; // all four presets' settings, as read at the last unlock
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
      const m = new Uint8Array(POCKET.size);
      for (let a = 0; a < m.length; a += 1009) {
        const d = await readRegion(5, a, Math.min(1009, m.length - a));
        if (!d) return false;
        m.set(d, a);
      }
      const p = g[10] < 4 ? g[10] : 0, base = p * POCKET.preset;
      for (let pr = 0; pr < 4; pr++) for (let r = 0; r < POCKET.records; r++) {
        const o = pr * POCKET.preset + r * POCKET.rec;
        if (m[o] !== 0 || m[o + 8] !== 0xFF) return null;
      }
      glob = g; preset = p; mem = m;
      notes = new Map();
      for (let r = 0; r < POCKET.records; r++) {
        const o = base + r * POCKET.rec, k = (m[o + 1] & 15) << 8 | m[o + 2];
        notes.set(k, [...(notes.get(k) || []), r]);
      }
      for (let pr = 0; pr < 4; pr++) for (let r = 0; r < POCKET.records; r++) {
        const a = pr * POCKET.preset + r * POCKET.rec + POCKET.rgb, cur = [...m.slice(a, a + 3)];
        // A colour Thump didn't put there is the pad's own (first run, or the pad was switched off since).
        if (!orig.has(a) || !sameRgb(cur, shown.get(a))) orig.set(a, cur);
        shown.set(a, cur);
      }
      persist();
      onPreset(preset);
      return true;
    }
    // Light the 16 pads on show. Anything Thump lit on another bank or preset goes back to
    // the pad's own colour, so only what you can see is ever Thump's.
    function paintAll() {
      const visible = new Set();
      for (let i = 0; i < 16; i++) { visible.add(addr(i)); if (!flashT[i]) want.set(addr(i), idleOf(i)); }
      for (const [a, c] of orig) if (!visible.has(a) && !sameRgb(shown.get(a), c)) want.set(a, c);
    }
    async function run() {
      if (running) return;
      running = true;
      try {
        while (link && (session() || want.size)) {
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
          // Read the global block every 300 ms (700 ms while busy writing): it keeps the session
          // open and shows a preset or bank change on the pad. No answer: the session lapsed.
          if (session() && performance.now() - lastPoll > (want.size ? 700 : 300)) {
            const g = await readRegion(4, 0, 12);
            lastPoll = performance.now();
            // Byte 10 is the preset (chosen when the pad is switched on), told at once; the rest waits for the re-read.
            if (g && g[10] !== glob[10] && g[10] < 4) { preset = g[10]; onPreset(preset); }
            if (!g || g.some((b, i) => b !== glob[i])) ready = false;
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
          if (!session()) break;
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
        if (l && session()) kick();
      },
      // Something changed whether the session is wanted (lights or preset following turned on).
      poke() { if (link && session()) kick(); },
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
      // The preset on show goes first: normally it is the only one Thump has lit.
      restoreNow() {
        if (!link || !ready || !mem) return false;
        let sent = false;
        for (const pr of [preset, 0, 1, 2, 3].filter((x, i, a) => a.indexOf(x) === i)) {
          const base = pr * POCKET.preset, at = r => base + r * POCKET.rec + POCKET.rgb, touched = [];
          for (let r = 0; r < POCKET.records; r++) if (orig.has(at(r)) && !sameRgb(shown.get(at(r)), orig.get(at(r)))) touched.push(r);
          if (!touched.length) continue;
          const lo = touched[0], hi = touched[touched.length - 1], block = mem.slice(base + lo * POCKET.rec, base + (hi + 1) * POCKET.rec);
          for (let r = lo; r <= hi; r++) if (orig.has(at(r))) block.set(orig.get(at(r)), (r - lo) * POCKET.rec + POCKET.rgb);
          const step = (link.kind === 'bt' ? 18 : 38) * POCKET.rec; // a Bluetooth packet must fit one 512-byte write
          for (let o = 0; o < block.length; o += step) {
            try { link.send(SMC.write(5, base + lo * POCKET.rec + o, [...block.slice(o, o + step)])); } catch { }
          }
          sent = true;
        }
        return sent;
      },
      get status() { return status; },
      get model() { return model; },
      get kind() { return link && link.kind; },
      get busy() { return running && (want.size > 0 || !ready); },
      get linked() { return !!link && ready; },
      get where() { return { preset, group }; },
    };
  }

  const LIGHTS_DEFAULT = { on: true, mode: 'sound', bright: 0.25, flash: true, white: false, beat: true, mine: null };
  const lightOpts = Object.assign({}, LIGHTS_DEFAULT, store.get('lights', {}));
  if (store.get('lights') == null && store.get('padLights', true) === false) lightOpts.on = false;
  const saveLights = () => store.set('lights', lightOpts);
  let sysexOk = false, btDevice = null, bt = null, btBusy = false, btError = '', lightPick = null;
  const lights = makeLights({
    enabled: () => lightOpts.on, session: () => lightOpts.on || padPresets.follow, key: 'padColors',
    onState: () => { lightsUi(); kitsUi(); renderPresetKeys(); }, onPreset: n => onPadPreset(n),
  });
  let lightsUi = () => { };
  // USB when the pad is plugged in, Bluetooth otherwise.
  function chooseLink() {
    const usb = sysexOk && midi && [...midi.outputs.values()].find(o => o.state === 'connected' && isPad(o.name) && /private/i.test(o.name));
    if (usb) { lights.attach(usbLink(usb)); if (bt) { bt.onClose = null; bt.close(); bt = null; } return; }
    if (bt) return lights.attach(bt);
    lights.attach(null);
    const btPad = midi && [...midi.inputs.values()].some(i => i.state === 'connected' && isPad(i.name) && isBt(i.name));
    if ((lightOpts.on || padPresets.follow) && btPad) connectBt(false);
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
      // Control pads glow orange: dim, and bright while their control is on.
      if (controls[i]) return { base: '#ff6a1a', level: ctlState(controls[i])[0] ? 1 : Math.min(1, lightOpts.bright * 0.8) };
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
      const info = p.sound && library.get(p.sound), c = controls[i] && CTL[controls[i]];
      pad.classList.toggle('ctl', !!c);
      if (c) {
        pad.style.setProperty('--c', '#ff6a1a');
        for (const k of ['empty', 'note', 'muted']) pad.classList.remove(k);
        pad.classList.toggle('sel', !notes && i === sel);
        pad.querySelector('.name').textContent = c.name;
        pad.querySelector('.badges').replaceChildren(el('b', { class: 'fn', title: 'This pad works a control. Right-click it to change what it does.' }, 'CTRL'));
        continue;
      }
      pad.classList.remove('on');
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
    ctlSig = null; // always send the lights
    ctlRefresh();
  }
  function flashPad(i, vel, beat) {
    const pad = padEls[i];
    if (!pad) return;
    if (beat ? lightOpts.beat : lightOpts.flash) lights.flash(i, vel, lightOpts.white);
    const v = Math.max(0.3, vel / 127);
    pad.querySelector('.flash').animate([{ opacity: v }, { opacity: v * 0.55, offset: 0.25 }, { opacity: 0 }], { duration: 480, easing: 'cubic-bezier(.2,.7,.3,1)' });
    pad.animate([{ transform: `translateY(${1 + 2 * v}px) scale(.975)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.3,1)' });
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
  // A knob turns a hidden range input: drag up or down (Shift for fine moves), scroll over it,
  // or focus it and use the arrow keys. Double-click puts it back to its starting value.
  function makeKnob(input, min, max, step, reset, center) {
    const R = 24, C = 2 * Math.PI * R, L = C * 0.75;
    const k = el('div', { class: 'knob', 'aria-hidden': 'true' });
    k.innerHTML = `<svg viewBox="0 0 64 64"><circle class="trk" cx="32" cy="32" r="${R}" stroke-dasharray="${L} ${C}" transform="rotate(135 32 32)"/>` +
      `<circle class="val" cx="32" cy="32" r="${R}" transform="rotate(135 32 32)"/></svg><i class="cap"></i>`;
    const val = k.querySelector('.val');
    const draw = () => {
      const p = clamp((input.value - min) / (max - min), 0, 1), from = center ? Math.min(p, 0.5) : 0, len = center ? Math.abs(p - 0.5) : p;
      k.style.setProperty('--a', (-135 + 270 * p) + 'deg');
      val.setAttribute('stroke-dasharray', `${len * L} ${C}`);
      val.setAttribute('stroke-dashoffset', -from * L);
    };
    const set = v => {
      v = +clamp(Math.round((v - min) / step) * step + min, min, max).toFixed(4);
      if (v !== +input.value) { input.value = v; input.dispatchEvent(new Event('input')); }
    };
    let y0 = null, v0 = 0;
    k.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); k.setPointerCapture(e.pointerId);
      y0 = e.clientY; v0 = +input.value; k.classList.add('turn');
      input.focus({ preventScroll: true });
    });
    k.addEventListener('pointermove', e => { if (y0 != null) set(v0 + (y0 - e.clientY) / (e.shiftKey ? 700 : 160) * (max - min)); });
    const end = () => { y0 = null; k.classList.remove('turn'); };
    k.addEventListener('pointerup', end);
    k.addEventListener('pointercancel', end);
    k.addEventListener('wheel', e => { e.preventDefault(); set(+input.value - Math.sign(e.deltaY) * Math.max(step, (max - min) / 50)); }, { passive: false });
    k.addEventListener('dblclick', reset);
    return { el: k, draw };
  }
  function makeCtrl(where, [key, label, min, max, step, fmt, def], onChange) {
    const input = el('input', { type: 'range', min, max, step, id: where + '-' + key, class: 'sr' + (min < 0 ? ' center' : '') });
    const out = el('output', { title: 'Double-click to reset' });
    const reset = () => { input.value = def ?? PAD_DEFAULT[key]; input.dispatchEvent(new Event('input')); };
    const knob = makeKnob(input, min, max, step, reset, min < 0);
    const setFill = () => { input.style.setProperty('--p', ((input.value - min) / (max - min) * 100) + '%'); knob.draw(); };
    input.addEventListener('input', () => { const v = +input.value; out.textContent = fmt(v); setFill(); onChange(key, v); });
    out.addEventListener('dblclick', reset);
    input.addEventListener('dblclick', reset);
    ctrlEls[where][key] = { input, out, fmt, setFill };
    return el('div', { class: 'ctrl knob-ctrl', title: `${label}: drag up or down, or scroll. Double-click to reset.` }, knob.el, el('label', { for: input.id }, label), out, input);
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
    const cs = $('#ctlSel');
    cs.append(el('option', { value: '' }, 'Play its sound'), ...CONTROLS.map(([label, list]) => el('optgroup', { label }, ...list.map(([id, name]) => el('option', { value: id }, name)))));
    cs.onchange = () => setControl(sel, cs.value);
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
    const info = p.sound && library.get(p.sound), c = !notes && controls[i] && CTL[controls[i]];
    $('#ctlRow').hidden = !!notes;
    $('#ctlSel').value = c ? c.id : '';
    $('#soundCtrls').hidden = !!c;
    $('#changeBtn').hidden = !!c;
    $('#ctlHelp').hidden = !c;
    if (c) {
      $('#padTitle').textContent = `Pad ${i + 1} · key ${KEY_LABEL[i]} · control`;
      $('#soundName').textContent = c.name;
      $('#soundMeta').replaceChildren(el('i', { style: 'background:#ff6a1a;color:#ff6a1a' }), c.hold ? 'Control · hold the pad' : 'Control · hit the pad');
      $('#editWobBtn').hidden = true;
      $('#ctlHelp').textContent = c.help + (info ? ` The kit keeps this pad's sound (${info.name}): choose Play its sound to get it back.` : '');
      return;
    }
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
  const taps = [];
  function tapTempo() {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(t);
    if (taps.length > 6) taps.shift();
    if (taps.length >= 3) setBpm(Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))));
  }
  function buildTransport() {
    $('#playBtn').onclick = togglePlay;
    $('#recBtn').onclick = toggleRec;
    seg('#barsSeg', BARS.map(b => [b, b + (b === 1 ? ' bar' : ' bars')]), () => pat().bars, setBars);
    seg('#snapSeg', SNAPS, () => state.snap, v => { state.snap = v; dirty(); });
    seg('#repSeg', REPEATS, () => state.repeat, setRepeat);
    const inp = $('#bpmIn');
    inp.onchange = () => setBpm(+inp.value);
    $('#bpmDown').onclick = () => setBpm(state.bpm - 1);
    $('#bpmUp').onclick = () => setBpm(state.bpm + 1);
    $('#tapBtn').onclick = tapTempo;
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

  // ---------------------------------------------------------------- UI: display
  // The display shows the pattern, where the beat is, what the machine is doing, and a
  // spectrum of what comes out of the speakers, low notes on the left.
  // The spectrum adds up the power of every FFT bin in a band, so a hi-hat, which spreads
  // its energy thinly over the wide treble bands, counts in full. It also tilts up 1.5 dB
  // per octave around 1 kHz, because music gets quieter towards the treble. Bars jump up
  // at once and fall back smoothly, so short hits show.
  // Like a recording meter with auto gain, the top of the display follows the loudest band
  // heard lately: it rises at once and sinks 6 dB a second. So a quiet kit or soft playing
  // still fills the display, and the bars show how the sounds compare. The display spans
  // 36 dB (4 dB a light).
  const SCOPE = { lo: 35, hi: 16000, range: 36, top: -12, topMin: -50, topMax: 0, headroom: 3, sink: 6, tilt: 1.5, fall: 1.8, hold: 0.45 };
  function scopeBands(db, rate, bands, out = new Float32Array(bands)) {
    const hz = db.length / (rate / 2), span = SCOPE.hi / SCOPE.lo;
    for (let i = 0; i < bands; i++) {
      const f0 = SCOPE.lo * span ** (i / bands), f1 = SCOPE.lo * span ** ((i + 1) / bands);
      const lo = Math.floor(f0 * hz), hi = Math.max(lo + 1, Math.ceil(f1 * hz));
      let p = 0;
      for (let k = lo; k < hi && k < db.length; k++) p += 10 ** (db[k] / 10);
      out[i] = 10 * Math.log10(p || 1e-30) + SCOPE.tilt * Math.log2(Math.sqrt(f0 * f1) / 1000);
    }
    return out;
  }
  const scopeMap = (raw, top, bands, out) => {
    for (let i = 0; i < bands; i++) out[i] = clamp((raw[i] - (top - SCOPE.range)) / SCOPE.range, 0, 1);
    return out;
  };
  // Levels from 0 to 1 against a fixed top (the selftest uses this).
  const scopeLevels = (db, rate, bands, out = new Float32Array(bands), top = SCOPE.top) => scopeMap(scopeBands(db, rate, bands, out), top, bands, out);
  // One frame of the auto gain: moves the top, then maps the bands under it.
  function scopeFollow(raw, bands, dt, out) {
    let loud = -Infinity;
    for (let i = 0; i < bands; i++) loud = Math.max(loud, raw[i]);
    scopeTop = clamp(Math.max(loud + SCOPE.headroom, scopeTop - SCOPE.sink * dt), SCOPE.topMin, SCOPE.topMax);
    return scopeMap(raw, scopeTop, bands, out);
  }
  const LEVELS = 9, scopeDb = new Float32Array(1024), scopeRaw = new Float32Array(64), scopeNow = new Float32Array(64), scopeVals = new Float32Array(64);
  const scopePeaks = new Float32Array(64), scopePeakT = new Float64Array(64), shownText = {};
  let scopeIdle = false, scopeT = 0, scopeTop = SCOPE.topMin;
  const show = (id, text) => { if (shownText[id] !== text) { shownText[id] = text; $(id).textContent = text; } };
  const barsText = n => `${n} BAR${n > 1 ? 'S' : ''}`;
  function updateDisplay() {
    const g = seq.seg, t = seq.playing ? posNow() : 0;
    let pos = '-.-.-', mode = 'STOP', sub = barsText(pat().bars);
    if (!seq.playing && state.songMode && state.song.length) { mode = 'SONG'; sub = `${state.song.length} PART${state.song.length > 1 ? 'S' : ''}`; }
    if (seq.playing && t < 0) { mode = seq.recording ? 'REC' : 'COUNT'; sub = `IN ${Math.ceil(-t)}`; }
    else if (seq.playing && g) {
      const b = Math.max(0, t - g.start);
      pos = `${Math.floor(b / 4) + 1}.${Math.floor(b % 4) + 1}.${Math.floor(b * 4) % 4 + 1}`;
      mode = seq.recording ? 'REC' : g.songIdx != null ? 'SONG' : 'LOOP';
      sub = seq.queued != null ? `NEXT ${LETTERS[seq.queued]}` : g.songIdx != null ? `PART ${g.songIdx + 1}/${state.song.length}` : barsText(state.patterns[g.pat].bars);
    }
    show('#dPat', LETTERS[seq.playing && g ? g.pat : state.pat]);
    show('#dPos', pos); show('#dMode', mode); show('#dSub', sub);
    $('#display').classList.toggle('rec', seq.recording);
  }
  function drawScope() {
    const cv = $('#scope'), w = cv.clientWidth, h = cv.clientHeight, an = live.M.an;
    if (!w || !h) return;
    const now = performance.now(), dt = Math.min(0.1, (now - scopeT) / 1000), BANDS = clamp(Math.round(w / 8), 16, 64);
    scopeT = now;
    an.getFloatFrequencyData(scopeDb);
    scopeFollow(scopeBands(scopeDb, ctx.sampleRate, BANDS, scopeRaw), BANDS, dt, scopeNow);
    let quiet = true;
    for (let i = 0; i < BANDS; i++) {
      scopeVals[i] = Math.max(scopeNow[i], scopeVals[i] - SCOPE.fall * dt);
      if (scopeVals[i] >= scopePeaks[i]) { scopePeaks[i] = scopeVals[i]; scopePeakT[i] = now; }
      else if (now - scopePeakT[i] > SCOPE.hold * 1000) scopePeaks[i] = Math.max(0, scopePeaks[i] - 0.9 * dt);
      if (scopeVals[i] > 0 || scopePeaks[i] > 0) quiet = false;
    }
    if (quiet && scopeIdle) return;
    scopeIdle = quiet;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const bw = w / BANDS, sh = h / LEVELS;
    for (let i = 0; i < BANDS; i++) {
      const lit = Math.round(scopeVals[i] * LEVELS), peak = Math.min(LEVELS - 1, Math.floor(scopePeaks[i] * LEVELS));
      for (let r = 0; r < LEVELS; r++) {
        const on = r < lit || (r === peak && scopePeaks[i] > 0.06);
        g.fillStyle = !on ? '#6af7dc12' : r >= LEVELS - 2 ? '#ff8c42' : '#6af7dc';
        g.fillRect(i * bw + 1, h - (r + 1) * sh + 1, Math.max(1, bw - 2), Math.max(1, sh - 2));
      }
    }
  }
  function displayLoop() {
    requestAnimationFrame(displayLoop);
    if (document.hidden) return;
    updateDisplay();
    drawScope();
    ctlRefresh();
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
      g.fillStyle = '#6af7dcaa'; g.font = '14px "Share Tech Mono", monospace'; g.textBaseline = 'middle';
      g.shadowColor = '#6af7dc'; g.shadowBlur = 6;
      g.fillText('> Press Rec to record what you play, or turn on "All pads" to click hits in.', 16, 34);
      g.shadowBlur = 0;
      return;
    }
    // Step keys: unlit, a little brighter on each beat's first step, an orange seam between bars.
    const cw = (w - LABEL_W) / steps, gap = cw > 14 ? 2 : 1;
    let playStep = -1;
    if (seq.playing && seq.seg && seq.seg.pat === state.pat) {
      const pos = posNow();
      if (pos >= seq.seg.start) playStep = Math.floor(clamp(pos - seq.seg.start, 0, L - 0.001) * 4);
    }
    for (let r = 0; r < rows.length; r++) {
      const y = 4 + r * ROW_H;
      for (let st = 0; st < steps; st++) {
        g.fillStyle = st === playStep ? '#2a1d14' : st % 4 === 0 ? '#1f2022' : Math.floor(st / 4) % 2 ? '#161719' : '#19191b';
        g.beginPath(); g.roundRect(LABEL_W + st * cw + gap / 2, y + 3, cw - gap, ROW_H - 6, 2); g.fill();
      }
    }
    for (let st = 16; st < steps; st += 16) { g.fillStyle = '#ff6a1a55'; g.fillRect(LABEL_W + st * cw - 1, 2, 2, rows.length * ROW_H + 4); }
    g.font = '600 13px "Barlow Condensed", sans-serif'; g.textBaseline = 'middle';
    rows.forEach((pad, r) => {
      const y = 4 + r * ROW_H, info = library.get(state.pads[pad].sound), m = state.mutes[pad], col = info ? CAT[info.cat].color : '#555';
      g.globalAlpha = m ? 0.35 : 1;
      g.fillStyle = col; g.shadowColor = col; g.shadowBlur = m ? 0 : 6;
      g.beginPath(); g.arc(10, y + ROW_H / 2, 3.5, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      g.fillStyle = m ? '#ffc23d' : '#a39e94';
      g.fillText((m ? `${String(pad + 1).padStart(2, '0')} MUTED` : `${String(pad + 1).padStart(2, '0')} ${info ? info.name : 'Empty'}`).toUpperCase().slice(0, 20), 20, y + ROW_H / 2 + 1);
      g.globalAlpha = 1;
    });
    // Hits light their step key in the sound's colour; harder hits glow brighter.
    for (const e of pat().events) {
      if (e.beat >= L) continue;
      const r = rows.indexOf(e.pad);
      if (r < 0) continue;
      const info = library.get(state.pads[e.pad].sound), col = info ? CAT[info.cat].color : '#888';
      const x = LABEL_W + e.beat * 4 * cw, y = 4 + r * ROW_H + 3;
      const long = state.pads[e.pad].hold ? Math.max(cw - gap, e.dur * 4 * cw - gap) : Math.max(4, cw - gap);
      const hot = Math.floor(e.beat * 4) === playStep;
      g.globalAlpha = (state.mutes[e.pad] ? 0.25 : 1) * (0.5 + 0.5 * (e.vel / 127));
      g.fillStyle = col; g.shadowColor = col; g.shadowBlur = state.mutes[e.pad] ? 0 : hot ? 16 : 7;
      g.beginPath(); g.roundRect(x + gap / 2, y, Math.min(long, w - x - 2), ROW_H - 6, 2); g.fill();
      g.shadowBlur = 0;
      if (hot) { g.globalAlpha = 0.55; g.fillStyle = '#fff'; g.beginPath(); g.roundRect(x + gap / 2, y, Math.min(long, w - x - 2), ROW_H - 6, 2); g.fill(); }
      g.globalAlpha = 1;
    }
    if (playStep >= 0) {
      const x = LABEL_W + clamp(posNow() - seq.seg.start, 0, L) * 4 * cw, c = seq.recording ? '#ff2e3f' : '#ff6a1a';
      g.fillStyle = c; g.shadowColor = c; g.shadowBlur = 10;
      g.fillRect(x - 1, 1, 2, rows.length * ROW_H + 6);
      g.shadowBlur = 0;
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
  const PRESET_SETS = [
    ['Bass music', ['dubstep', 'riddim', 'audiophob', 'trap']],
    ['Industrial', ['industrial', 'factory', 'electro', 'heavy']],
    ['Old school', ['808', 'boxes', 'hiphop', 'electro']],
    ['Live drums', ['rock', 'heavy', 'hands', 'hiphop']],
  ];
  const DEFAULT_SLOTS = ['dubstep', 'riddim', 'industrial', 'electro'];
  const myKits = () => Object.entries(userKits).sort((a, b) => a[1].name.localeCompare(b[1].name));
  function kitDef(id) {
    const pre = PRESETS.find(p => p.id === id);
    if (pre) return { id, name: pre.name, bpm: pre.bpm, pads: pre.pads.map(normPad) };
    const k = userKits[id];
    return k ? { id, name: k.name, bpm: k.bpm, pads: k.pads.map(cleanPad) } : null;
  }
  const slotFromKit = id => { const k = kitDef(id); return k && { kit: { id: k.id, name: k.name }, pads: k.pads }; };
  // A kit picker: your kits, the ready-made ones, and the kit itself when it is edited or gone.
  function kitOptions(kit) {
    const known = !!kitDef(kit.id), mine = myKits();
    return [
      known ? null : el('option', { value: '' }, kit.name),
      mine.length ? el('optgroup', { label: 'Your kits' }, ...mine.map(([id, k]) => el('option', { value: id }, k.name))) : null,
      el('optgroup', { label: 'Ready-made kits' }, ...PRESETS.map(p => el('option', { value: p.id }, p.name))),
    ].filter(Boolean);
  }
  function renderKitSel() {
    const s = $('#kitSel');
    s.replaceChildren(...kitOptions(state.kit));
    s.value = kitDef(state.kit.id) ? state.kit.id : '';
    renderPresetKeys();
  }
  // Load a kit onto the pads, which puts it on the preset you are on.
  function loadKit(id) {
    const k = kitDef(id);
    if (!k) return;
    state.kit = { id: k.id, name: k.name };
    state.pads = k.pads;
    state.notes = null;
    if (!seq.playing && !state.patterns.some(p => p.events.length)) setBpm(k.bpm);
    preloadKit(); renderAll(); dirty();
  }
  function saveKit(name) {
    const same = Object.keys(userKits).find(id => userKits[id].name.toLowerCase() === name.toLowerCase());
    const id = same || newId('kit');
    userKits[id] = { name, bpm: state.bpm, pads: state.pads.map(p => Object.assign({}, p)) };
    if (!store.set('kits', userKits)) { toast('Could not save (storage full)'); return null; }
    state.kit = { id, name };
    renderAll(); dirty();
    return id;
  }
  function renameKit(id, name) {
    userKits[id].name = name;
    store.set('kits', userKits);
    for (const s of padPresets.slots) if (s.kit.id === id) s.kit.name = name;
    if (state.kit.id === id) state.kit.name = name;
    savePresets(); renderAll(); dirty();
  }
  function deleteKit(id) {
    delete userKits[id];
    store.set('kits', userKits);
    // Presets keep the pads they had; the kit just isn't in the list any more.
    for (const s of padPresets.slots) if (s.kit.id === id) s.kit.id = 'custom';
    if (state.kit.id === id) state.kit.id = 'custom';
    savePresets(); renderAll(); dirty();
  }
  function initPresets() {
    const okSlot = x => x && x.kit && typeof x.kit.name === 'string' && Array.isArray(x.pads) && x.pads.length === 16;
    if (!(Array.isArray(padPresets.slots) && padPresets.slots.length === 4 && padPresets.slots.every(okSlot))) padPresets.slots = DEFAULT_SLOTS.map(slotFromKit);
    padPresets.slot = clamp(padPresets.slot | 0, 0, 3);
    padPresets.slots[padPresets.slot] = currentSlot();
    savePresets();
  }
  // Decode the other presets' sounds ahead, so switching is instant.
  const preloadSlots = () => { for (const s of padPresets.slots) for (const p of s.pads) if (library.has(p.sound)) loadSound(p.sound); };
  // Switch to preset n: the pads you leave stay with their preset, the tempo stays.
  function goSlot(n) {
    if (n === padPresets.slot || !padPresets.slots[n]) return;
    padPresets.slots[padPresets.slot] = currentSlot();
    padPresets.slot = n;
    const s = padPresets.slots[n];
    state.kit = { id: s.kit.id, name: s.kit.name };
    state.pads = s.pads.map(cleanPad);
    state.notes = null;
    preloadKit(); renderAll(); dirty(); savePresets();
  }
  // Put a kit on preset n (the pads on show, if that is the preset you are on).
  function assignSlot(n, id) {
    if (n === padPresets.slot) return loadKit(id);
    const s = slotFromKit(id);
    if (!s) return;
    padPresets.slots[n] = s;
    savePresets(); renderPresetKeys(); preloadSlots();
  }
  function fillSlots(ids) {
    ids.slice(0, 4).forEach((id, n) => { if (n !== padPresets.slot) { const s = slotFromKit(id); if (s) padPresets.slots[n] = s; } });
    if (ids[padPresets.slot]) loadKit(ids[padPresets.slot]);
    savePresets(); renderPresetKeys(); preloadSlots();
  }
  // The pad says which preset it is on. Follow it when it moves (and on first contact).
  let padPreset = null;
  function onPadPreset(n) {
    const moved = n !== padPreset;
    padPreset = n;
    if (moved && padPresets.follow && n !== padPresets.slot) {
      goSlot(n);
      toast(`Preset ${n + 1}: ${state.kit.name}`);
    }
    renderPresetKeys(); kitsUi();
  }
  let presetBtns = [], kitsUi = () => { };
  function buildPresetKeys() {
    presetBtns = [0, 1, 2, 3].map(n => el('button', { class: 'pkey two', onclick: () => goSlot(n) },
      el('span', { class: 'ptop' }, el('i'), el('b', {}, 'Preset ' + (n + 1))), el('span', { class: 'kname' })));
    $('#presetKeys').replaceChildren(...presetBtns);
  }
  function renderPresetKeys() {
    if (!presetBtns.length || !padPresets.slots) return;
    presetBtns.forEach((b, n) => {
      const s = padPresets.slots[n], on = n === padPresets.slot, name = on ? state.kit.name : s.kit.name;
      // Short on the key: "Riddim / neuro (edited)" shows as "Riddim*".
      const short = shortKit(name), here = lights.linked && padPreset === n;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('here', here);
      b.querySelector('.kname').textContent = short;
      b.title = `Preset ${n + 1}: ${name}. ${presetHow(n)}.` + (here ? ' Your pad is on this preset.' : '');
    });
  }
  // How to reach preset n from the pad: a control pad set to it, or power-on with pad 13-16 held.
  function presetHow(n) {
    const k = controls.indexOf('preset' + n);
    return k >= 0 ? `On your pad: hit pad ${k + 1}` : `On your pad: hold pad ${13 + n} while you switch it on`;
  }
  const presetPads = () => [0, 1, 2, 3].every(n => controls[12 + n] === 'preset' + n);
  function togglePresetPads() {
    const on = !presetPads();
    [0, 1, 2, 3].forEach(n => { freePad(12 + n); controls[12 + n] = on ? 'preset' + n : null; });
    store.set('controls', controls);
    renderPads(); renderPanel(); renderPresetKeys();
    toast(on ? 'Pads 13 to 16 now switch presets' : 'Pads 13 to 16 play their sounds again');
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
      g.fillStyle = '#6af7dc';
      for (let x = 0; x < w; x++) {
        let pk = 0; for (let i = x * step; i < (x + 1) * step && i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
        g.fillRect(x, h / 2 - pk * h * 0.45, 1, Math.max(1, pk * h * 0.9));
      }
      g.font = '12px "Share Tech Mono", monospace'; g.textBaseline = 'top';
      slices.forEach(([s], i) => {
        const x = s / buf.duration * w;
        g.fillStyle = '#ff6a1a'; g.fillRect(x, 0, 2, h);
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
      if (lightOpts.on) { chooseLink(); lights.poke(); } else lights.restore();
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
      el('small', {}, 'Thump never saves anything to your pad: its own colors come back when Thump closes or the lights are off. Switch the pad on in another preset (hold pad 13 to 16 while switching it on) and the lights follow.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
    modalCleanup = () => { lightsUi = () => { }; lightPick = null; };
    paint();
  }
  // Kits: what is on each of the pad's presets, filling them, and your own kits.
  function followText() {
    if (!padPresets.follow) return 'Off: switching presets on your pad leaves the kit alone.';
    if (lights.linked) return `On: your pad is on preset ${lights.where.preset + 1} (over ${lights.kind === 'bt' ? 'Bluetooth' : 'USB'}).`;
    const btPad = midi && [...midi.inputs.values()].some(i => i.state === 'connected' && isPad(i.name) && isBt(i.name));
    return {
      connecting: 'Connecting to your pad…',
      unsupported: `Only the SMC-PAD Pocket's presets can be followed (this is ${lights.model || 'another pad'}).`,
      noreply: 'The pad didn\'t answer. Switch it off and on, or unplug it and plug it back in.',
    }[lights.status] || (btError ? btError : btBusy ? 'Connecting over Bluetooth…'
      : btPad ? (navigator.bluetooth ? 'Your pad is on Bluetooth. Press Connect so Thump can see its presets (once; Thump remembers it).' : 'Plug the pad in with USB so Thump can see its presets.')
      : sysexOk ? 'Waiting for your pad: plug it in with USB, or switch it on.' : 'Thump needs permission to control MIDI devices. Close Thump, open it again and choose Allow.');
  }
  function nameDialog(title, text, value, okLabel, fn, back) {
    const input = el('input', { type: 'text', value, maxlength: 40 }), note = el('small', {});
    const check = () => { const n = input.value.trim().toLowerCase(), same = myKits().find(([, k]) => k.name.toLowerCase() === n); note.textContent = same && same[1].name !== value ? `This replaces your kit "${same[1].name}".` : ''; };
    const ok = () => { const n = input.value.trim(); if (!n) return; fn(n); back ? back() : closeModal(); };
    input.addEventListener('input', check);
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ok(); if (e.key === 'Escape') back ? back() : closeModal(); });
    openModal(el('h2', {}, title), el('p', {}, text), input, note,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => back ? back() : closeModal() }, 'Cancel'), el('button', { class: 'btn primary', onclick: ok }, okLabel)));
    check();
    setTimeout(() => { input.focus(); input.select(); }, 30);
  }
  function saveKitDialog(back) {
    const base = state.kit.name.replace(/ \(edited\)$/, ''), own = userKits[state.kit.id] || (myKits().find(([, k]) => k.name === base) || [])[1];
    const name = own ? own.name : /^(my kit|chop:)/i.test(base) ? `My kit ${myKits().length + 1}` : /^my /i.test(base) ? base : `My ${base}`;
    nameDialog('Save kit', 'Saves the 16 pads as they are now (sounds and settings), so you can put the kit on any preset.', name, 'Save kit',
      n => { if (saveKit(n)) toast(`Saved kit "${n}"`); }, back);
  }
  function kitsDialog() {
    const status = el('p', { class: 'status' });
    const connectBtn = el('button', { class: 'btn sm', onclick: () => connectBt(true) }, 'Connect over Bluetooth');
    const followBtn = el('button', { class: 'btn toggle', title: 'Load the kit on a preset when you switch to it on your pad', onclick: () => {
      padPresets.follow = !padPresets.follow;
      savePresets();
      if (padPresets.follow) { chooseLink(); lights.poke(); if (lights.linked && padPreset != null && padPreset !== padPresets.slot) goSlot(padPreset); }
      paint();
    } });
    const rows = [0, 1, 2, 3].map(n => {
      const key = el('button', { class: 'pkey', title: 'Switch to this preset', onclick: () => { goSlot(n); paint(); } }, el('i'), el('b', {}, 'P' + (n + 1)));
      const pick = el('select', { 'aria-label': `Kit on preset ${n + 1}`, onchange: e => { assignSlot(n, e.target.value); paint(); } });
      const hint = el('span', { class: 'slot-hint' });
      const row = el('div', { class: 'slot-row' }, key, hint, pick);
      row.paint = () => {
        const k = controls.indexOf('preset' + n);
        hint.textContent = k >= 0 ? `Pad ${k + 1}` : `Pad ${13 + n} at power-on`;
        const kit = n === padPresets.slot ? state.kit : padPresets.slots[n].kit;
        key.setAttribute('aria-pressed', String(n === padPresets.slot));
        key.classList.toggle('here', lights.linked && padPreset === n);
        pick.replaceChildren(...kitOptions(kit));
        pick.value = kitDef(kit.id) ? kit.id : '';
      };
      return row;
    });
    const fill = ids => {
      const edited = padPresets.slots.map((s, n) => n === padPresets.slot ? state.kit : s.kit).filter(k => !kitDef(k.id));
      if (!edited.length) { fillSlots(ids); return paint(); }
      confirmDialog(`Put new kits on all four presets? Your changes to ${edited.map(k => `"${k.name}"`).join(', ')} are lost unless you save them as a kit first.`, 'Fill presets', () => { fillSlots(ids); kitsDialog(); });
    };
    const padsBtn = el('button', { class: 'btn toggle', title: 'Pads 13 to 16 switch between the four presets while you play, instead of playing sounds', onclick: () => { togglePresetPads(); paint(); } }, 'Pads 13 to 16 switch presets');
    const fillRow = el('div', { class: 'fill-row' });
    const mineBox = el('div', { class: 'kit-list' });
    const paint = () => {
      followBtn.setAttribute('aria-pressed', String(padPresets.follow));
      followBtn.textContent = padPresets.follow ? 'Follow the pad: on' : 'Follow the pad: off';
      padsBtn.setAttribute('aria-pressed', String(presetPads()));
      status.textContent = followText();
      const btPad = midi && [...midi.inputs.values()].some(i => i.state === 'connected' && isPad(i.name) && isBt(i.name));
      connectBtn.hidden = !(padPresets.follow && btPad && navigator.bluetooth && lights.status === 'nopad' && !btBusy);
      rows.forEach(r => r.paint());
      const mine = myKits();
      fillRow.replaceChildren(...[el('span', {}, 'Fill all four with'),
        ...PRESET_SETS.map(([label, ids]) => el('button', { class: 'btn sm', title: ids.map(id => kitDef(id).name).join(', '), onclick: () => fill(ids) }, label)),
        mine.length ? el('button', { class: 'btn sm', title: mine.slice(0, 4).map(([, k]) => k.name).join(', '), onclick: () => fill(mine.slice(0, 4).map(([id]) => id)) }, 'Your kits') : null].filter(Boolean));
      mineBox.replaceChildren(...(mine.length ? mine.map(([id, k]) => el('div', { class: 'kit-item' + (state.kit.id === id ? ' on' : '') },
        el('div', {}, el('b', {}, k.name), el('small', {}, `${k.pads.filter(p => p.sound).length} sounds · ${k.bpm} BPM`)),
        el('button', { class: 'btn sm', title: `Put "${k.name}" on the pads (preset ${padPresets.slot + 1})`, onclick: () => { loadKit(id); paint(); } }, 'Load'),
        el('button', { class: 'btn sm', onclick: () => nameDialog('Rename kit', `A new name for "${k.name}".`, k.name, 'Rename', x => renameKit(id, x), kitsDialog) }, 'Rename'),
        el('button', { class: 'btn sm', onclick: () => confirmDialog(`Delete your kit "${k.name}"? Presets that use it keep their pads.`, 'Delete', () => { deleteKit(id); kitsDialog(); }) }, 'Delete')))
        : [el('p', { class: 'empty' }, 'No kits of your own yet. Change the sounds on the pads (Change sound), then save them here.')]));
    };
    kitsUi = () => { status.textContent = followText(); rows.forEach(r => r.paint()); };
    openModal(
      el('div', { class: 'lights-head' }, el('h2', {}, 'Kits'), followBtn),
      el('p', {}, 'Your pad has four presets, and each one holds a kit here. The pad picks its preset when you switch it on with pad 13, 14, 15 or 16 held, and Thump follows. To switch while you play, let pads 13 to 16 do it (or set any pad to a preset under Pad does). The keys above the pads switch presets too.'),
      el('div', { class: 'lights-status' }, status, connectBtn),
      el('h3', {}, 'Pad presets'),
      el('div', { class: 'slots' }, ...rows),
      el('div', { class: 'row', style: 'justify-content:flex-start' }, padsBtn),
      fillRow,
      el('h3', {}, 'Your kits'),
      mineBox,
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => saveKitDialog(kitsDialog) }, 'Save the pads as a kit…'),
        el('div', { class: 'grow' }),
        el('button', { class: 'btn primary', onclick: closeModal }, 'Done')));
    $('#modalCard').classList.add('wide');
    modalCleanup = () => { kitsUi = () => { }; };
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
        el('li', {}, 'The spectrum on the display shows what you hear, kicks on the left and hi-hats on the right. It sets its own sensitivity, so quiet kits fill it too.')),
      el('h2', {}, 'Your pad'),
      el('ul', {},
        el('li', {}, 'Click or hit a pad to change it in the panel on the right: its sound, volume, pitch and more.'),
        el('li', {}, 'Right-click a pad to make it a control instead of a sound: note repeat, latch, presets, patterns, swing, tap tempo, metronome, play, record, undo or mute. Pick Play its sound to get the sound back.'),
        el('li', {}, 'Latch: with it on, a Hold pad (like a wobble) or a repeating pad keeps going after you let go. Hit it again to stop it.'),
        el('li', {}, 'Your pad has four presets. It picks one when you switch it on with pad 13, 14, 15 or 16 held, and Thump loads the kit on it. Kits (top bar) chooses the four kits and saves your own.'),
        el('li', {}, 'To switch kits while you play, turn on Pads 13 to 16 switch presets in Kits.'),
        el('li', {}, 'Lights (top bar) sets your pad\'s colors: sound colors, your own, or the pad\'s own, with flashes as pads play. Control pads glow orange, brighter while they are on. Works over USB or Bluetooth.')),
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
        const open = !$('#browser').hidden || !$('#modal').hidden || !$('#beatMenu').hidden || !$('#padMenu').hidden;
        closeBrowser(); closeModal(); $('#beatMenu').hidden = true; $('#padMenu').hidden = true;
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
    const pm = $('#padMenu');
    document.addEventListener('pointerdown', e => { if (!pm.hidden && !pm.contains(e.target)) pm.hidden = true; }, true);
    addEventListener('resize', () => { pm.hidden = true; });
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
      const g4 = [0xA0, 0, 0x32, 2, 0, 0, 0, 0, 0, 0, 0, 0]; // the global block; byte 10 is the preset
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
            reply(0x23, [...d.slice(0, 8), ...(d[0] === 4 ? g4 : mem.slice(a, a + n))]);
          } else if (q.cmd === 0x22) { if (unlocked) mem.set(d.slice(8, 8 + n), a); reply(0x00, [0]); }
        },
      };
      const settle = async (x = L) => { await sleep(20); for (let t = 0; t < 300 && x.busy; t++) await sleep(10); };
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
      ok(at(3, 1) !== '250,250,0', 'lights: a new session finds the pad\'s colours again');
      L.padFor(9, 36); await settle();
      ok(at(2, 1) !== '250,250,0' && at(3, 1) === '250,250,0', 'lights: going back to bank 3 gives bank 4 its own colours back');
      biggest = 0; L.restoreNow();
      await sleep(20);
      ok(biggest > 0 && biggest <= 512 && at(2, 0) === '250,250,0' && at(3, 0) === '250,250,0', `lights: over Bluetooth the restore fits 512-byte writes (${biggest})`);
      L.attach(null);

      // Following the pad's presets: switched on with pad 14 held, the pad is on preset 2.
      const seen = [], atp = (pr, g, i) => at(0, pr * POCKET.preset / POCKET.rec + g * 16 + i);
      let lightsOn2 = true;
      const L2 = makeLights({ enabled: () => lightsOn2, session: () => true, key: null, onPreset: n => seen.push(n) });
      link.kind = 'mock'; L2.attach(link);
      L2.setPads(Array.from({ length: 16 }, () => ({ base: '#2ee6c0', level: 0.22 })));
      await settle(L2);
      const tealRgb = atp(0, 2, 0);
      ok(seen[0] === 0 && tealRgb !== '250,250,0', `presets: the pad reports preset 1 (${seen.join()})`);
      g4[10] = 1; await sleep(450); await settle(L2);
      ok(seen.includes(1) && L2.where.preset === 1, `presets: switching to preset 2 on the pad is seen (${seen.join()})`);
      ok(atp(1, 2, 0) === tealRgb && atp(0, 2, 0) === '250,250,0', `presets: preset 2 lights up and preset 1 gets its own colours back (${atp(1, 2, 0)} / ${atp(0, 2, 0)})`);
      L2.restoreNow(); await sleep(20);
      ok(atp(1, 2, 0) === '250,250,0', 'presets: closing gives preset 2 its own colours back');
      lightsOn2 = false; L2.restore(); await settle(L2);
      seen.length = 0; g4[10] = 2; await sleep(450); await settle(L2);
      ok(seen.includes(2) && L2.linked && L2.status === 'off' && atp(2, 2, 0) === '250,250,0', `presets: followed with the lights off, nothing lit (${seen.join()} ${L2.status})`);
      g4[10] = 0; L2.attach(null);
    }
    {
      // Your kits, and the kit on each of the pad's presets.
      const keepKits = JSON.stringify(userKits), keepPresets = JSON.stringify(padPresets);
      padPresets.follow = true;
      fillSlots(['dubstep', 'riddim', 'industrial', 'electro']);
      ok(state.kit.id === ['dubstep', 'riddim', 'industrial', 'electro'][padPresets.slot] && padPresets.slots.every((x, n) => n === padPresets.slot || x.kit.id === ['dubstep', 'riddim', 'industrial', 'electro'][n]), 'presets: fill puts four ready-made kits on the presets');
      goSlot(0); goSlot(1);
      ok(state.kit.id === 'riddim' && state.pads[0].sound === kitDef('riddim').pads[0].sound && presetBtns[1].getAttribute('aria-pressed') === 'true', 'presets: a preset key switches to its kit');
      state.pads[2] = Object.assign({}, state.pads[2], { sound: 'syn:clang' }); state.kit = { id: 'custom', name: 'Riddim / neuro (edited)' };
      goSlot(0); goSlot(1);
      ok(state.pads[2].sound === 'syn:clang' && state.kit.name === 'Riddim / neuro (edited)', 'presets: each preset keeps the pads you left on it');
      const id = saveKit('Selftest kit');
      ok(id && userKits[id] && $('#kitSel').value === id && state.kit.id === id, 'kits: saving the pads makes a kit you can pick');
      assignSlot(3, id); loadKit('electro'); loadKit(id);
      ok(state.pads[2].sound === 'syn:clang' && padPresets.slots[3].kit.id === id && padPresets.slots[3].pads[2].sound === 'syn:clang', 'kits: your kit loads back and goes on another preset');
      padPreset = null; onPadPreset(0);
      ok(padPresets.slot === 0 && state.kit.id === 'dubstep', 'presets: Thump follows the pad to preset 1');
      goSlot(2); onPadPreset(0);
      ok(padPresets.slot === 2, 'presets: a preset picked in Thump stays until the pad moves');
      onPadPreset(3);
      ok(padPresets.slot === 3 && state.kit.id === id, 'presets: the pad moving to preset 4 loads your kit');
      padPresets.follow = false; onPadPreset(1);
      ok(padPresets.slot === 3, 'presets: with following off the kit stays');
      deleteKit(id);
      ok(!userKits[id] && state.kit.id === 'custom' && state.pads[2].sound === 'syn:clang', 'kits: deleting a kit leaves the presets that use it alone');
      for (const k of Object.keys(userKits)) delete userKits[k];
      Object.assign(userKits, JSON.parse(keepKits)); store.set('kits', userKits);
      Object.assign(padPresets, JSON.parse(keepPresets)); savePresets();
      padPreset = null;
      const k = kitDef(padPresets.slots[padPresets.slot].kit.id);
      if (k) loadKit(k.id); else loadKit('dubstep');
    }
    {
      // Pad controls: a pad works note repeat, latch, presets, swing and more instead of a sound.
      const keepCtl = controls.slice(), keepPresets = JSON.stringify(padPresets), keepPats = JSON.stringify(state.patterns), keepPat = state.pat;
      const keepMaster = Object.assign({}, state.master), keepClick = state.click, keepMode = lightOpts.mode;
      silence(); setRepeat(0); latch = false; lightOpts.mode = 'sound';
      controls.fill(null);
      {
        const real = lights.setPads;
        let sent = 0;
        lights.setPads = l => { sent++; return real.call(lights, l); };
        renderPads();
        lights.setPads = real;
        ok(sent >= 1, 'controls: with no control pads, redrawing the pads still updates the pad lights');
      }
      fillSlots(['dubstep', 'riddim', 'industrial', 'electro']); goSlot(0);
      if (presetPads()) togglePresetPads();
      togglePresetPads();
      ok(presetPads() && padEls[13].classList.contains('ctl') && padEls[13].querySelector('.name').textContent === 'Preset 2', 'controls: pads 13 to 16 become preset keys');
      const voices0 = live.voices.size;
      padDown(13, 100, 'm'); padUp(13, 'm');
      ok(padPresets.slot === 1 && state.kit.id === 'riddim' && live.voices.size === voices0, 'controls: pad 14 switches to preset 2 and plays no sound');
      ok(padEls[13].classList.contains('on') && !padEls[12].classList.contains('on'), 'controls: the preset key you are on is lit');
      const ll = padLightList();
      ok(ll[13].base === '#ff6a1a' && ll[13].level === 1 && ll[12].level < 1, 'controls: on the pad, control pads glow orange, bright when on');
      goSlot(2);
      ok(controls[13] === 'preset1' && padEls[13].classList.contains('ctl') && padEls[14].classList.contains('on'), 'controls: control pads stay put when the kit changes');
      ok(/hit pad 14/.test(presetBtns[1].title), `controls: the preset keys say which pad switches to them (${presetBtns[1].title})`);
      togglePresetPads();
      ok(!controls[13] && !padEls[13].classList.contains('ctl'), 'controls: pads 13 to 16 go back to their sounds');

      setControl(15, 'repHold');
      padDown(15, 100, 'k');
      const rate = state.repeat;
      padDown(0, 100, 'k');
      const h0 = held.get('k0');
      ok(rate > 0 && h0 && h0.repeat && repeats.has(h0.repeat), `controls: holding Repeat makes a pad repeat (${rateName(rate)})`);
      padUp(15, 'k');
      ok(state.repeat === 0 && !repeats.size, 'controls: letting go of Repeat stops the repeat');
      padUp(0, 'k');
      setControl(15, 'repNext');
      const rates = [];
      for (let k = 0; k < 5; k++) { padDown(15, 100, 'k'); padUp(15, 'k'); rates.push(rateName(state.repeat)); }
      ok(rates.join() === '1/8,1/16,1/16T,1/32,Off', `controls: Repeat rate steps through the rates (${rates.join(' ')})`);

      setControl(15, 'latch');
      const keepPad1 = state.pads[1];
      state.pads[1] = Object.assign({}, keepPad1, { sound: 'syn:wobble', hold: true });
      await loadSound('syn:wobble');
      padDown(15, 100, 'k'); padUp(15, 'k');
      padDown(1, 100, 'k'); const v1 = held.get('k1').voice; padUp(1, 'k');
      ok(latch && v1 && !v1.released && latched.has(1), 'controls: with Latch on, a held sound keeps going after you let go');
      padDown(1, 100, 'k'); padUp(1, 'k');
      ok(v1.released && !latched.has(1), 'controls: hitting a latched pad again stops it');
      padDown(1, 100, 'k'); const v2 = held.get('k1').voice; padUp(1, 'k');
      padDown(15, 100, 'k'); padUp(15, 'k');
      ok(!latch && v2.released && !latched.size, 'controls: turning Latch off stops what was latched');
      state.pads[1] = keepPad1;

      setControl(15, 'swing'); state.master.swing = 0.5;
      const sw = [];
      for (let k = 0; k < 5; k++) { padDown(15, 100, 'k'); padUp(15, 'k'); sw.push(Math.round(state.master.swing * 100)); }
      ok(sw.join() === '54,58,62,66,50' && +$('#master-swing').value === 0.5, `controls: Swing steps through the amounts (${sw.join(' ')})`);

      state.patterns.forEach((p, k) => { p.events = k === 0 || k === 2 ? [{ pad: 0, beat: 0, vel: 100, semis: 0, dur: 0.25 }] : []; });
      choosePattern(0); setControl(15, 'patNext');
      padDown(15, 100, 'k'); padUp(15, 'k');
      const p1 = state.pat;
      padDown(15, 100, 'k'); padUp(15, 'k');
      ok(p1 === 2 && state.pat === 0, `controls: Next pattern skips empty patterns (A to ${LETTERS[p1]} to ${LETTERS[state.pat]})`);

      setControl(15, 'mute');
      padDown(15, 100, 'k'); padDown(3, 100, 'k'); padUp(3, 'k');
      const mutedNow = state.mutes[3], modeNow = muteMode;
      padUp(15, 'k');
      ok(modeNow && mutedNow && !muteMode, 'controls: hold Mute and hit a pad to mute it');
      toggleMute(3);
      setControl(15, 'click'); const c0 = state.click;
      padDown(15, 100, 'k'); padUp(15, 'k');
      ok(state.click === !c0, 'controls: Metronome turns the click on and off');
      select(0); padDown(15, 100, 'k'); padUp(15, 'k');
      ok(sel === 15 && state.click === c0, 'controls: hitting a control pad picks it in the panel too');
      padEls[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
      const menuOpen = !$('#padMenu').hidden, tapBtn = [...$('#padMenu').querySelectorAll('button')].find(b => b.textContent === 'Tap tempo');
      tapBtn && tapBtn.click();
      ok(menuOpen && controls[2] === 'tap' && $('#padMenu').hidden && sel === 2 && padEls[2].classList.contains('ctl'), 'controls: right-click opens a menu that sets what the pad does');
      setControl(2, null);

      select(15);
      ok($('#ctlSel').value === 'click' && $('#soundCtrls').hidden && !$('#ctlHelp').hidden && $('#soundName').textContent === 'Metronome', 'controls: the panel shows what a control pad does');
      ok(store.get('controls')[15] === 'click', 'controls: pad controls are saved');
      $('#ctlSel').value = ''; $('#ctlSel').dispatchEvent(new Event('change'));
      ok(!controls[15] && !$('#soundCtrls').hidden && $('#ctlHelp').hidden, 'controls: Play its sound puts the sound back');

      controls.splice(0, 16, ...keepCtl); store.set('controls', controls);
      state.patterns = JSON.parse(keepPats); state.pat = keepPat;
      Object.assign(state.master, keepMaster); state.click = keepClick; lightOpts.mode = keepMode;
      setRepeat(0); latch = false; silence(); select(0);
      Object.assign(padPresets, JSON.parse(keepPresets)); savePresets();
      const k = kitDef(padPresets.slots[padPresets.slot].kit.id);
      if (k) loadKit(k.id); else loadKit('dubstep');
      applyMaster(); renderAll();
    }
    {
      // The spectrum: a quiet hi-hat lights the treble, and music's usual slope reads about level.
      const bins = 1024, rate = 48000, hzOf = k => k * rate / 2 / bins;
      const hat = scopeLevels(Float32Array.from({ length: bins }, (_, k) => hzOf(k) > 6000 ? -50 : -140), rate, 16);
      ok(Math.round(hat[14] * 9) >= 4 && hat[3] === 0, `scope: a quiet hi-hat lights the treble (${Math.round(hat[14] * 9)} of 9)`);
      const slope = scopeLevels(Float32Array.from({ length: bins }, (_, k) => -30 - 15 * Math.log10(Math.max(1, hzOf(k)) / 1000)), rate, 16);
      const mid = [...slope].slice(3);
      ok(Math.max(...mid) - Math.min(...mid) < 0.2, `scope: a spectrum falling 4.5 dB an octave reads level (${mid.map(v => Math.round(v * 9)).join('')})`);
      // The auto gain: after loud music a very quiet hi-hat fills the display within seconds,
      // and a loud kick after it reaches the top at once without going past it.
      const keepTop = scopeTop, out = new Float32Array(16);
      const soft = scopeBands(Float32Array.from({ length: bins }, (_, k) => hzOf(k) > 6000 ? -80 : -200), rate, 16);
      scopeTop = SCOPE.top;
      let first = 0;
      for (let f = 0; f < 60; f++) { scopeFollow(soft, 16, 0.1, out); if (!f) first = Math.max(...out); }
      const filled = Math.round(Math.max(...out) * 9);
      ok(Math.round(first * 9) <= 2 && filled >= 7, `scope: a quiet hi-hat fills the display after a while (${Math.round(first * 9)} at first, ${filled} after 6 s)`);
      const kick = scopeBands(Float32Array.from({ length: bins }, (_, k) => hzOf(k) < 150 ? -20 : -200), rate, 16);
      const top = Math.round(Math.max(...scopeFollow(kick, 16, 0.016, out)) * 9);
      ok(top === 8, `scope: a loud kick right after reaches the top at once (${top} of 9)`);
      scopeTop = keepTop;
    }
    {
      // The knobs turn the real settings, and the display follows the pattern and the beat.
      const input = $('#master-space'), knob = input.closest('.ctrl').querySelector('.knob'), before = state.master.space;
      knob.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      ok(state.master.space > before && +input.value === state.master.space, `ui: scrolling a knob turns it (${before} to ${state.master.space})`);
      knob.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      ok(state.master.space === before, 'ui: double-clicking a knob resets it');
      choosePattern(2); updateDisplay();
      ok($('#dPat').textContent === 'C' && $('#dMode').textContent === 'STOP' && $('#dPos').textContent === '-.-.-', 'ui: the display shows the pattern when stopped');
      choosePattern(0);
      play(false); await sleep(400); updateDisplay();
      ok(/^[1-4]\.[1-4]\.[1-4]$/.test($('#dPos').textContent) && $('#dMode').textContent === 'LOOP' && $('#dPat').textContent === 'A', `ui: the display counts bars, beats and steps while playing (${$('#dPos').textContent} ${$('#dMode').textContent})`);
      stop(); updateDisplay();
      ok($('#dMode').textContent === 'STOP', 'ui: the display shows STOP after stopping');
    }
    const fails = out.filter(l => l.startsWith('FAIL')).length;
    const pre = $('#selftest');
    pre.hidden = false;
    pre.textContent = `SELFTEST ${fails ? 'FAIL' : 'PASS'} (${out.length - fails}/${out.length})\n` + out.join('\n');
    document.title = 'SELFTEST ' + (fails ? 'FAIL' : 'PASS');
  }

  // ---------------------------------------------------------------- start
  async function init() {
    buildPads(); buildPresetKeys(); buildPanel(); buildTransport(); buildBeatMenu(); bindKeys();
    $('#kitSel').onchange = e => loadKit(e.target.value);
    $('#kitsBtn').onclick = kitsDialog;
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

    if (location.search.includes('selftest')) { initPresets(); renderAll(); return selftest(); }

    await loadUserSounds();
    state = loadBeat(store.get('session', null));
    initPresets();
    applyMaster();
    renderAll();
    preloadKit();
    setTimeout(preloadSlots, 2500);
    initMidi();
    displayLoop();
    if (document.fonts) document.fonts.ready.then(() => drawLoop());
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
  window.thump = { live, library, loadSound, scopeLevels, padPresets, get padPreset() { return padPreset; }, goSlot, kitsDialog, lights, makeLights, SMC, lightOpts, lightsDialog, connectBt, chooseLink, get state() { return state; }, seq, play, stop, padDown, padUp, renderAll, chopDialog, wobbleDialog, micDialog, exportDialog, settingsDialog, toggleMute, choosePattern, copyToNext };
  init();
})();
