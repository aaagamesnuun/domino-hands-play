// 置く手触りの音と、拍の時計。
// ・置く「とっ」は下の面で変わる（フェルト・本・板の坂・ものさし）
// ・なぞり置きが拍（72BPM の16分）にそろうと、木琴のような音が今のコードの中で鳴る。
//   ちょうどいい置き方が続くほど、音が明るく（倍音・余韻・響き・鈴）なる
// ・急ぎすぎると、こもった「ガタッ」につまる
// BGM の拍の時計（src/audio.js の Sound）をそのまま使う。音が出ていないときは同じ速さの予備の時計で数える。

import { MUSIC } from '../../src/config.js';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const BPM = MUSIC.bpm > 0 ? MUSIC.bpm : 72;
const BEAT = 60 / BPM;
const SW = Math.min(0.75, Math.max(0.5, MUSIC.swing || 0.5));
const SUB = [0, SW * SW, SW, SW + SW * (1 - SW)];   // audio.js と同じ、16分の位置（8分の裏が少し遅れる）

// コード進行（BGM と同じ順：Dm9 – G13 – Cmaj9 – Am9。1小節ずつ）の中で鳴らしてよい音（MIDI 番号、低い順）
export const CHORD_TONES = [
  [62, 65, 69, 72, 74, 76, 77, 81, 84],   // Dm9 : D F A C D E F A C
  [62, 67, 71, 74, 76, 79, 83, 86],       // G13 : D G B D E G B D（C は避ける）
  [60, 64, 67, 71, 72, 74, 76, 79, 83],   // Cmaj9: C E G B C D E G B
  [60, 64, 67, 69, 71, 72, 76, 79, 81],   // Am9 : C E G A B C E G A
];

let warned = false;
function warn(e) {
  if (warned) return;
  warned = true;
  try { console.warn('[feel-sound]', e); } catch (_) { /* 無視 */ }
}

// 拍の時計。ステップ = 16分。BGM が鳴っていればその時計、なければ performance.now() で同じ拍を数える
export class BeatClock {
  constructor(sound) {
    this.sound = sound;
  }
  get live() {
    const s = this.sound;
    return !!(s.ctx && s._built && s._transportOn && s.ctx.state === 'running'
      && typeof s._stepTime === 'function' && typeof s._stepAtOrAfter === 'function');
  }
  now() {
    return this.live ? this.sound.ctx.currentTime : performance.now() / 1000;
  }
  stepTime(i) {
    if (this.live) return this.sound._stepTime(i);
    const b = Math.floor(i / 4);
    return (b + SUB[i - b * 4]) * BEAT;
  }
  // 時刻 t 以降で最初のステップ
  firstStepAtOrAfter(t) {
    if (this.live) return this.sound._stepAtOrAfter(t, 1);
    let i = Math.max(0, Math.floor(t / BEAT) * 4);
    while (this.stepTime(i) < t) i++;
    return i;
  }
  // 時刻 t にいちばん近いステップ。off は t − そのステップの時刻（正ならあと）
  nearest(t) {
    const j = this.firstStepAtOrAfter(t);
    const i = Math.max(0, j - 1);
    const ti = this.stepTime(i), tj = this.stepTime(j);
    const best = Math.abs(ti - t) <= Math.abs(tj - t) ? i : j;
    const time = best === i ? ti : tj;
    return { step: best, time, off: t - time };
  }
  // 時刻 t 以降の、8分の頭のステップ
  nextEighth(t) {
    let i = this.firstStepAtOrAfter(t);
    if (i % 2) i++;
    return i;
  }
  chordIndex(step) {
    return Math.floor(step / 16) % 4;
  }
}

export class TouchSound {
  constructor(sound) {
    this.sound = sound;
    this.clock = new BeatClock(sound);
    this._nb = null;
  }

  get ctx() {
    return this.sound.ctx;
  }

  ok() {
    const s = this.sound;
    if (!s.ctx || !s._built) return false;
    try {
      return typeof s._canPlay === 'function' ? s._canPlay() : !s.muted;
    } catch (_) {
      return false;
    }
  }

  // 効果音の出口。send > 0 なら残響にも送る
  _dest(send = 0) {
    const s = this.sound;
    try {
      if (send > 0 && typeof s._out === 'function') return s._out(send);
    } catch (_) { /* 無視 */ }
    return s._sfxVol || s.ctx.destination;
  }

  _noise() {
    if (this._nb) return this._nb;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.6);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return (this._nb = b);
  }

  _at(t) {
    const now = this.ctx.currentTime + 0.004;
    return typeof t === 'number' && Number.isFinite(t) ? Math.max(now, t) : now;
  }

  // 帯域をしぼったノイズの一瞬（しぼった分だけ音量をおぎなう）
  _burst(t, { type = 'bandpass', freq = 1000, q = 1, gain = 0.1, dur = 0.04, dest }) {
    const ctx = this.ctx;
    const ny = ctx.sampleRate / 2;
    const f = clamp(freq, 30, ny * 0.9);
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const band = type === 'bandpass' ? f / Math.max(0.1, q) : type === 'lowpass' ? f : ny - f;
    const comp = clamp(Math.sqrt(ny / Math.max(1, band)), 1, 12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(1e-4, gain * comp), t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + Math.max(0.006, dur));
    src.connect(flt);
    flt.connect(g);
    g.connect(dest);
    const off = Math.random() * Math.max(0, src.buffer.duration - dur - 0.05);
    src.start(t, off, dur + 0.02);
  }

  // 音程のある短い音。f → f2 へ下がりながら消える
  _ping(t, { f, f2 = 0, glide = 0.05, gain = 0.1, dur = 0.1, att = 0.002, type = 'sine', dest }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f), t);
    if (f2 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + Math.max(0.005, glide));
    const g = ctx.createGain();
    const d = Math.max(att + 0.01, dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(1e-4, gain), t + att);
    g.gain.exponentialRampToValueAtTime(1e-4, t + d);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + d + 0.03);
  }

  // 置く音。surface：'felt'（盆）/ 'book' / 'wood'（板の坂）/ 'ruler'。bright 0..1 で上に明るい「チッ」を足す
  knock(size, surface, t, { gain = 0.5, bright = 0 } = {}) {
    if (!this.ok()) return;
    try {
      const at = this._at(t);
      const f0 = { s: 240, m: 150, l: 95 }[size] || 150;
      const j = 1 + (Math.random() - 0.5) * 0.08;
      const G = gain * ({ s: 0.8, m: 1, l: 1.2 }[size] || 1);
      const dry = this._dest(0);
      const wet = this._dest(0.06 + 0.12 * bright);
      switch (surface) {
        case 'book':   // 紙の束：ぽすっ
          this._ping(at, { f: f0 * 0.85 * j, f2: f0 * 0.7 * j, glide: 0.06, gain: G * 0.55, dur: 0.075, dest: dry });
          this._burst(at, { freq: 1100 * j, q: 0.8, gain: G * 0.05, dur: 0.05, dest: dry });
          break;
        case 'ruler':  // ものさし：カチッ
          this._ping(at, { f: f0 * 1.5 * j, gain: G * 0.35, dur: 0.045, dest: dry });
          this._burst(at, { freq: 3300 * j, q: 4, gain: G * 0.035, dur: 0.028, dest: dry });
          this._ping(at + 0.003, { f: 1750 * j, gain: G * 0.05, dur: 0.08, dest: wet });
          break;
        case 'wood':   // 板の坂：コッ（中が少しうつろ）
          this._ping(at, { f: f0 * 1.1 * j, f2: f0 * 0.9 * j, glide: 0.08, gain: G * 0.65, dur: 0.1, dest: dry });
          this._burst(at, { freq: f0 * 7 * j, q: 3, gain: G * 0.045, dur: 0.045, dest: dry });
          this._ping(at, { f: 320 * j, gain: G * 0.1, dur: 0.15, dest: wet });
          break;
        default:       // フェルト：とっ（やわらかい）
          this._ping(at, { f: f0 * j, f2: f0 * 0.8 * j, glide: 0.08, gain: G * 0.8, dur: size === 'l' ? 0.13 : 0.09, dest: dry });
          this._burst(at, { type: 'lowpass', freq: 1300 * j, q: 0.5, gain: G * 0.06, dur: 0.03, dest: dry });
      }
      if (bright > 0.05) this._burst(at, { freq: 2600 + 2600 * bright, q: 2, gain: 0.018 * bright * G, dur: 0.022, dest: wet });
    } catch (e) {
      warn(e);
    }
  }

  // 拍にそろったときの木琴のような音。level 0..1 が上がるほど明るく・長く・よく響く
  tock(midi, t, level, accent = false) {
    if (!this.ok()) return;
    try {
      const ctx = this.ctx;
      const at = this._at(t);
      const f = mtof(midi);
      const lv = clamp(level, 0, 1);
      const out = this._dest(0.12 + 0.35 * lv);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1300 + 4200 * lv;
      lp.Q.value = 0.4;
      lp.connect(out);
      const peak = (0.05 + 0.06 * lv) * (accent ? 1.15 : 1);
      const decay = 0.16 + 0.34 * lv;
      this._ping(at, { f, gain: peak, dur: decay, dest: lp });
      this._ping(at, { f: f * 4, gain: peak * (0.25 + 0.3 * lv), dur: 0.035, dest: lp });   // 木琴の「コ」
      if (lv > 0.45) this._ping(at, { f: f * 2, type: 'triangle', gain: peak * 0.35 * ((lv - 0.45) / 0.55), dur: decay * 0.8, dest: lp });
      if (lv > 0.6 && accent && typeof this.sound._kalimba === 'function') {
        this.sound._kalimba(midi + 12, at, 0.14 + 0.3 * (lv - 0.6), this._dest(0.35));
      }
      if (lv > 0.85) this._ping(at + 0.01, { f: f * 3.01, gain: 0.012, dur: 0.6, dest: this._dest(0.5) });
    } catch (e) {
      warn(e);
    }
  }

  // 急ぎすぎ：こもった「ガタッ」
  jam(size, t) {
    if (!this.ok()) return;
    try {
      const ctx = this.ctx;
      const at = this._at(t);
      const f0 = { s: 240, m: 150, l: 95 }[size] || 150;
      const sz = { s: 0.8, m: 1, l: 1.2 }[size] || 1;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      lp.Q.value = 0.8;
      lp.connect(this._dest(0));
      this._burst(at, { freq: 900, q: 1.2, gain: 0.08 * sz, dur: 0.03, dest: lp });
      this._burst(at + 0.024, { freq: 760, q: 1.2, gain: 0.05 * sz, dur: 0.028, dest: lp });
      this._ping(at, { f: f0 * 0.75, f2: f0 * 0.6, glide: 0.04, gain: 0.35 * sz, dur: 0.05, dest: lp });
    } catch (e) {
      warn(e);
    }
  }

  // カリンバで数音（times と同じ数の midis）
  _kal(midis, times, vel) {
    const out = this._dest(0.4);
    midis.forEach((m, i) => {
      const at = this._at(times[i]);
      if (typeof this.sound._kalimba === 'function') this.sound._kalimba(m, at, vel, out);
      else this._ping(at, { f: mtof(m), gain: 0.08 * vel, dur: 0.8, dest: out });
    });
  }

  // とぎれが1つつながった：次の8分から2音
  connected() {
    if (!this.ok() || !this.clock.live) return;
    try {
      const c = this.clock;
      const st = c.nextEighth(c.now() + 0.03);
      const tones = CHORD_TONES[c.chordIndex(st)];
      this._kal([tones[3], tones[5]], [c.stepTime(st), c.stepTime(st + 2)], 0.42);
    } catch (e) {
      warn(e);
    }
  }

  // 全部つながった：3音
  allConnected() {
    if (!this.ok() || !this.clock.live) return;
    try {
      const c = this.clock;
      const st = c.nextEighth(c.now() + 0.03);
      const tones = CHORD_TONES[c.chordIndex(st)];
      this._kal([tones[2], tones[4], tones[6]], [c.stepTime(st), c.stepTime(st + 2), c.stepTime(st + 4)], 0.45);
    } catch (e) {
      warn(e);
    }
  }

  // できた：今のコードの音を16分で駆け上がり、最後に1オクターブ上
  fanfare() {
    if (!this.ok() || !this.clock.live) return;
    try {
      const c = this.clock;
      const st = c.nextEighth(c.now() + 0.25);
      const tones = CHORD_TONES[c.chordIndex(st)];
      const ms = [tones[1], tones[2], tones[3], tones[4], tones[5], tones[6], tones[3] + 12];
      const ts = ms.map((_, i) => c.stepTime(st + i + (i === ms.length - 1 ? 2 : 0)));
      this._kal(ms, ts, 0.5);
    } catch (e) {
      warn(e);
    }
  }
}
