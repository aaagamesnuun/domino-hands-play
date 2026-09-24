// 音。音源ファイルは使わず、すべてその場で合成する（WebAudio）。
// ・BGM：72BPM の lofi hip-hop。先読みスケジューラで16分ずつ予約する
//   パート 0 ローズ（＋レコードのノイズ） / 1 ベース / 2 ハイハット / 3 キック・スネア / 4 パッド・リード
// ・効果音：木のドミノ、箱、呼び鈴、スタンプ。連鎖は拍に合わせて音階が上がる
// 流れ：各声部 → パート → 音楽バス（テープのゆれ）→ ミックス → ローパス（緊張でこもる）→ 軽い歪み → 音量 → コンプ → 出力
// 公開メソッドは例外を投げない。AudioContext が作れない環境では何もしない。

import { MUSIC } from './config.js';

const BPM = MUSIC.bpm > 0 ? MUSIC.bpm : 72;
const SW = Math.min(0.75, Math.max(0.5, MUSIC.swing || 0.5));
const BEAT = 60 / BPM;                // 4分音符（秒）
const BAR = BEAT * 4;
// 16分の位置（拍の中の割合）。8分の裏を SW の位置へ、16分の裏もそれぞれの半分の中で同じ比率へ
const SUB = [0, SW * SW, SW, SW + SW * (1 - SW)];
const LOOKAHEAD = 0.12;               // どこまで先を予約するか（秒）
const LATE_SKIP = 0.05;               // これ以上遅れた拍は鳴らさずに飛ばす（タブが裏にいた後など）
const FADE_TC = (BAR * 2) / 4;        // パートの出入り（約2小節でそろう時定数）

const BASE = { master: 0.9, music: 0.6, sfx: 0.85 };   // 内部の基準音量
const DUCK_DB = -6;                   // 緊張したときのドラムの下がり幅
const TONE_OPEN = 3200;               // 全体のローパス（ふだん）
const TONE_CLOSED = 1200;             // 全体のローパス（いちばん緊張したとき）

// コード進行（MUSIC.chords と同じ順）：Dm9 – G13 – Cmaj9 – Am9。1小節ずつ
const RH_ROOTS = [50, 43, 48, 45];    // ローズの左手（根音）D3 G2 C3 A2
const VOICINGS = [                    // ローズの右手（ルートレス。となりへ少しずつ動く）
  [53, 57, 60, 64],                   // Dm9  : F A C E
  [53, 57, 59, 64],                   // G13  : F A B E
  [52, 55, 59, 62],                   // Cmaj9: E G B D
  [55, 59, 60, 64],                   // Am9  : G B C E
];
const BASS_ROOTS = [38, 43, 36, 33];  // D2 G2 C2 A1
const PAD_NOTES = [[69, 72, 76], [69, 71, 76], [67, 71, 74], [67, 72, 76]];
const PENTA = [0, 2, 4, 7, 9];        // C メジャー・ペンタトニック（C D E G A）
const MEL_TOP = 12;                   // 連鎖のメロディの上限（C4 から約2.5オクターブ上の E6）
const SWELL = [60, 64, 71, 74, 55, 48, 67, 79];   // 連鎖の締めの Cmaj9（足していく順）
const SPARKLE = [76, 79, 83, 86];     // 長い連鎖の締めに添える鈴 E5 G5 B5 D6
const CLICK_VOICES = 16;              // 同時に鳴らすカチの上限
const MEL_FLUSH = 0.04;               // 連鎖のメロディは、その16分のこれだけ前に予約する

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const rand = (a, b) => a + Math.random() * (b - a);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// ペンタトニックの i 番目（0 = C4）の MIDI 番号
const pentaMidi = (i) => 60 + 12 * Math.floor(i / 5) + PENTA[i % 5];

// 連鎖の深さ → ペンタトニックの何番目か。1段ごとに1つ上がり、上限を越えたら1オクターブ下へ折り返す
function chainMelodyIndex(depth) {
  const i = Math.max(0, depth - 1);
  if (i <= MEL_TOP) return i;
  return MEL_TOP - 4 + ((i - MEL_TOP - 1) % 5);
}

// やわらかい飽和（小さい音はそのまま、大きい音だけ丸める）
function makeSatCurve(k) {
  const n = 2049;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / k;
  }
  return c;
}

function makeNoise(ctx, sec) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * sec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// 倍音の強さ（sin の係数。[0] は直流で 0）から波形を作る
function makeWave(ctx, harmonics) {
  const imag = new Float32Array(harmonics);
  const real = new Float32Array(harmonics.length);
  return ctx.createPeriodicWave(real, imag);
}

// 予約済みの音を消す（まだ鳴り始めていない連鎖のメロディの差し替え用）
function silence(voice, now) {
  try {
    voice.amp.gain.cancelScheduledValues(0);
    voice.amp.gain.setValueAtTime(0, 0);
  } catch (_) {
    // 無視
  }
  for (const o of voice.oscs) {
    try {
      o.stop(now);   // 2回目の stop を許さない古いブラウザでは例外になるが、音量はもう 0
    } catch (_) {
      // 無視
    }
  }
}

export class Sound {
  constructor() {
    this.ctx = null;
    this._built = false;
    this._dead = false;              // AudioContext が使えない環境
    this._muted = false;
    this._vol = { master: 0.8, music: 0.7, sfx: 0.8 };
    this._layers = 0;
    this._tension = { target: 0, cur: 0, applied: 0 };
    // 拍の時計（16分 = 1ステップ。_t0 がステップ0の時刻）
    this._transportOn = false;
    this._t0 = 0;
    this._step = 0;
    this._plan = null;               // いまの小節の譜面
    this._pushInto = -1;             // 前の小節で先取りしたコードが鳴っている小節
    this._reentry = false;           // 拍を飛ばした直後（途中からコードを入れ直す）
    this._leadIdx = 7;
    this._mel = null;                // 連鎖のメロディ { step, depth, voice }（voice が null の間はまだ作っていない）
    this._clicks = [];               // 鳴っているカチの終わる時刻
    this._hum = null;                // 呼び鈴を押している間のうなり
    this._createdMs = 0;
    this._warned = false;
    this._onVisibility = () => {
      if (document.visibilityState === 'visible') this._resume();
    };
  }

  // ---------- 公開 API ----------

  // ユーザー操作の中で呼ぶ（ブラウザの自動再生制限のため）。何度呼んでもよい
  unlock() {
    try {
      if (this._dead) return;
      if (this.ctx) {
        this._resume();
        return;
      }
      const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!Ctx) {
        this._dead = true;
        return;
      }
      let ctx;
      try {
        ctx = new Ctx();
      } catch (e) {
        this._dead = true;
        this._warn(e);
        return;
      }
      this.ctx = ctx;
      this._createdMs = nowMs();
      try {
        this._build();
      } catch (e) {
        this._warn(e);
        this._dead = true;
        this._built = false;
        this.ctx = null;
        try {
          const p = ctx.close();
          if (p && p.catch) p.catch(() => {});
        } catch (_) {
          // 無視
        }
        return;
      }
      this._resume();
      this._startTransport();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVisibility);
    } catch (e) {
      this._warn(e);
    }
  }

  // 各 0..1。指定したものだけ変える
  setVolumes(v) {
    try {
      if (!v || typeof v !== 'object') return;
      for (const k of ['master', 'music', 'sfx']) {
        if (typeof v[k] === 'number' && Number.isFinite(v[k])) this._vol[k] = clamp(v[k], 0, 1);
      }
      this._applyVolumes(0.08);
    } catch (e) {
      this._warn(e);
    }
  }

  // BGM のパート数 0..4。約2小節かけて出入りする
  setLayers(n) {
    try {
      this._layers = clamp(Math.round(num(n, 0)), 0, 4);
      this._applyLayers(FADE_TC);
    } catch (e) {
      this._warn(e);
    }
  }

  // 0..1。手が立っている列に近いほど大きい（ドラムが引いて、音がこもる）
  setTension(t) {
    try {
      this._tension.target = clamp(num(t, 0), 0, 1);
    } catch (e) {
      this._warn(e);
    }
  }

  // 毎フレーム呼ぶ。緊張の追従と、BGM の先読み予約
  update(dt) {
    try {
      const ctx = this.ctx;
      if (!ctx || !this._built) return;
      const now = ctx.currentTime;
      // 緊張：近づくときは速く（0.15秒）、離れるときはゆっくり（0.8秒）
      const T = this._tension;
      const d = clamp(num(dt, 1 / 60), 0, 0.1);
      const tc = T.target > T.cur ? 0.15 : 0.8;
      T.cur += (T.target - T.cur) * (1 - Math.exp(-d / tc));
      if (Math.abs(T.target - T.cur) < 0.001) T.cur = T.target;
      if (Math.abs(T.cur - T.applied) > 0.003 || (T.cur === T.target && T.cur !== T.applied)) this._applyTension(now);
      // 呼び鈴から手が離れたのに知らせが来ないとき
      if (this._hum && now - this._hum.last > 0.3) this._releaseHum(now);
      // 待たせている連鎖のメロディ
      const m = this._mel;
      if (m && !m.voice && this._stepTime(m.step) - now < MEL_FLUSH) {
        if (this._canPlay()) this._flushMel(now);
        else this._mel = null;
      }
      if (ctx.state === 'running' && this._transportOn) this._schedule(now);
    } catch (e) {
      this._warn(e);
    }
  }

  get muted() {
    return this._muted;
  }

  set muted(v) {
    try {
      this._muted = !!v;
      if (!this._built) return;
      if (this._muted) this._releaseHum(this.ctx.currentTime);
      this._applyVolumes(0.05);
    } catch (e) {
      this._warn(e);
    }
  }

  // 置く「トン」：天板に当たる胴鳴り＋角のカツ
  place() {
    this._sfx((t) => {
      const j = 1 + rand(-0.04, 0.04);
      const out = this._out(0.06);
      this._tone(t, { f: 150 * j, f2: 128 * j, glide: 0.09, gain: 0.38, dur: 0.16, att: 0.0015, dest: out });
      this._tone(t, { f: 390 * j, gain: 0.07, dur: 0.05, dest: out });
      this._noiseBurst(t, { freq: 2000 * j, q: 2.2, gain: 0.2, dur: 0.022, dest: out });
    });
  }

  // 拾う：軽いコツ
  pick() {
    this._sfx((t) => {
      const j = 1 + rand(-0.04, 0.04);
      const out = this._out(0.04);
      this._noiseBurst(t, { freq: 2700 * j, q: 3, gain: 0.14, dur: 0.02, dest: out });
      this._tone(t, { f: 340 * j, f2: 300 * j, glide: 0.03, gain: 0.1, dur: 0.06, dest: out });
    });
  }

  // 木箱から n 個つかむ：ガサッ＋ドミノどうしが当たる音
  grab(n) {
    this._sfx((t) => {
      const k = clamp(Math.round(num(n, 1)), 1, 12);
      const out = this._out(0.05);
      this._noiseBurst(t, { freq: 1400, q: 0.6, gain: 0.09 + 0.008 * k, dur: 0.28 + 0.02 * k, att: 0.05, dest: out });
      const clacks = Math.min(2 + k, 9);
      const span = 0.18 + 0.02 * k;
      for (let i = 0; i < clacks; i++) {
        this._woodClick(t + 0.03 + Math.random() * span, rand(0.07, 0.15), rand(1800, 3400), out, 0);
      }
    });
  }

  // 箱にしまう「カラン」。fill 0..1 = 箱の埋まり具合（空ほど低く、うつろに響く）
  stash(fill) {
    this._sfx((t) => {
      const f = clamp(num(fill, 0.5), 0, 1);
      const out = this._out(0.1);
      const res = 170 + 260 * f;
      const ring = 0.32 - 0.18 * f;
      // カ：最初のひと当たり
      this._woodClick(t, 0.22, rand(2000, 2500), out, 0.1);
      // ラン：中でころがる
      const n = 3 + Math.floor(Math.random() * 3);
      let tt = t;
      for (let i = 0; i < n; i++) {
        tt += rand(0.035, 0.065);
        this._woodClick(tt, 0.12 * (1 - i / (n + 1)), rand(1600, 3400), out, 0);
      }
      // 箱の胴鳴り
      this._tone(t, { f: res, f2: res * 0.97, glide: ring, gain: 0.16 * (1.2 - 0.5 * f), dur: ring, att: 0.004, dest: out });
      this._tone(t + 0.005, { f: res * 1.52, gain: 0.06, dur: ring * 0.6, dest: out });
      // 空の箱のうつろさ
      this._noiseBurst(t, { freq: res * 2.1, q: 8 - 5 * f, gain: 0.1 * (1 - 0.6 * f), dur: ring * 0.8, dest: out });
    });
  }

  // 「カタッ」：ぐらついたが倒れない
  wobble() {
    this._sfx((t) => {
      const j = 1 + rand(-0.04, 0.04);
      const out = this._out(0.04);
      this._woodClick(t, 0.16, 1700 * j, out, 0.08);
      this._woodClick(t + rand(0.055, 0.085), 0.09, 1550 * j, out, 0.05);
    });
  }

  // 連鎖の1枚が当たった：すぐにカチ。さらに次の16分に、深さに応じたメロディを1音
  topple(depth) {
    this._sfx((t) => {
      const d = Math.max(1, Math.floor(num(depth, 1)));
      // カチ（同時に鳴るのは16まで。あふれた分は捨てる）
      const c = this._clicks;
      let n = 0;
      for (let i = 0; i < c.length; i++) if (c[i] > t) c[n++] = c[i];
      c.length = n;
      if (n < CLICK_VOICES) {
        const dur = 0.03;
        this._noiseBurst(t, { freq: rand(2300, 3400), q: 3.5, gain: rand(0.09, 0.13), dur, dest: this._sfxVol });
        c.push(t + dur + 0.02);
      }
      // メロディ（同じ16分なら深いほうだけ残す）。音はその16分の直前に作る（差し替えで無駄な音を作らない）
      if (!this._transportOn) return;
      const step = this._stepAtOrAfter(t + 0.012, 1);
      const m = this._mel;
      if (m && m.step === step) {
        if (d <= m.depth) return;
        m.depth = d;
        if (m.voice) {
          silence(m.voice, t);
          m.voice = null;
        }
      } else {
        if (m && !m.voice) this._flushMel(t);   // 前の16分の分がまだなら、いま鳴らす
        this._mel = { step, depth: d, voice: null };
      }
      if (this._stepTime(step) - t < MEL_FLUSH) this._flushMel(t);
    });
  }

  // 連鎖が閉じた：主和音（Cmaj9）がふくらんで解決する。長い連鎖ほど大きく長い
  chainEnd(length) {
    this._sfx((now) => {
      const ctx = this.ctx;
      const L = clamp(num(length, 1), 1, 3000);
      const s = Math.log(L) / Math.log(3000);          // 0..1
      const st = this._transportOn ? this._stepAtOrAfter(now + 0.03, 2) : -1;   // 次の8分
      const t = st >= 0 ? Math.max(now, this._stepTime(st)) : now;
      this._mel = null;
      const att = 0.35 + 1.1 * s;
      const hold = 0.4 + 2.4 * s;
      const rel = 1.0 + 2.5 * s;
      const end = t + att + hold;
      const out = this._out(0.45 + 0.25 * s);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0;
      lp.frequency.setValueAtTime(450, t);
      lp.frequency.exponentialRampToValueAtTime(900 + 1500 * s, t + att);
      lp.frequency.setTargetAtTime(500, end, rel / 3);
      lp.connect(out);
      const notes = SWELL.slice(0, 3 + Math.round(s * 5));
      const peak = 0.025 + 0.03 * s;
      notes.forEach((m, i) => {
        const t1 = t + i * 0.04;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t1);
        g.gain.linearRampToValueAtTime(peak, t1 + att);
        g.gain.setTargetAtTime(0, Math.max(end, t1 + att + 0.01), rel / 4);
        g.connect(lp);
        for (const dc of [-6, 6]) {
          const o = ctx.createOscillator();
          o.setPeriodicWave(this._waves.warm);
          o.frequency.value = mtof(m);
          o.detune.value = dc + rand(-2, 2);
          o.connect(g);
          o.start(t1);
          o.stop(end + rel * 1.6 + 0.5);
        }
      });
      // 長い連鎖には、上のほうで小さな鈴を添える
      if (L >= 30 && st >= 0) {
        const k = L >= 300 ? 4 : L >= 100 ? 3 : 2;
        const bell = this._out(0.5);
        for (let i = 0; i < k; i++) {
          this._kalimba(SPARKLE[i], this._stepTime(st + 2 * (i + 1)), rand(0.3, 0.38) * (0.7 + 0.3 * s), bell);
        }
      }
    });
  }

  // 呼び鈴を押している間（p 0..1）：かすかに上がっていくうなり
  bellPress(p) {
    try {
      const x = clamp(num(p, 0), 0, 1);
      if (x <= 0) {
        if (this._hum && this.ctx) this._releaseHum(this.ctx.currentTime);
        return;
      }
      if (!this._canPlay()) return;
      const ctx = this.ctx;
      const now = ctx.currentTime;
      let h = this._hum;
      if (!h) {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(this._out(0.2));
        const o1 = ctx.createOscillator();
        const o2 = ctx.createOscillator();
        o1.frequency.value = 392;
        o2.frequency.value = 392 * 1.0045;       // 少しずらしてゆっくりうならせる
        o1.connect(g);
        o2.connect(g);
        o1.start(now);
        o2.start(now);
        h = this._hum = { o1, o2, g, last: now };
      }
      h.last = now;
      const f = 392 * Math.pow(2, (5 * x) / 12);  // G4 → C5
      h.o1.frequency.setTargetAtTime(f, now, 0.1);
      h.o2.frequency.setTargetAtTime(f * 1.0045, now, 0.1);
      h.g.gain.setTargetAtTime(0.04 * x * x, now, 0.12);
    } catch (e) {
      this._warn(e);
    }
  }

  // 呼び鈴「チーン」（ひと休み）：金属の長い余韻
  bellRing() {
    this._sfx((t) => {
      this._releaseHum(t);
      const out = this._out(0.4);
      const f0 = 1318.5 * (1 + rand(-0.002, 0.002));   // E6
      const partials = [
        [1, 0.16, 5.0],
        [1.0042, 0.1, 4.2],
        [2.76, 0.06, 2.0],
        [5.4, 0.03, 0.8],
        [8.93, 0.012, 0.35],
      ];
      for (const [r, g, t60] of partials) this._ring(f0 * r, t, g, t60, out);
      this._noiseBurst(t, { freq: 3500, q: 1.2, gain: 0.08, dur: 0.02, dest: out });
    });
  }

  // スタンプ「ポン」（記録が出た）
  stamp() {
    this._sfx((t) => {
      const j = 1 + rand(-0.03, 0.03);
      const out = this._out(0.12);
      this._tone(t, { f: 240 * j, f2: 150 * j, glide: 0.07, gain: 0.32, dur: 0.22, att: 0.003, dest: out });
      this._tone(t, { f: 520 * j, f2: 380 * j, glide: 0.05, gain: 0.08, dur: 0.08, dest: out });
      this._noiseBurst(t, { type: 'lowpass', freq: 1200, q: 0, gain: 0.18, dur: 0.035, dest: out });
    });
  }

  // 次の箱が届いた：段ボールのボフッ＋小さなチャイム
  boxArrive() {
    this._sfx((t) => {
      const out = this._out(0.2);
      this._tone(t, { f: 95, f2: 52, glide: 0.12, gain: 0.4, dur: 0.35, att: 0.006, dest: out });
      this._noiseBurst(t, { type: 'lowpass', freq: 380, q: 0, gain: 0.25, dur: 0.16, dest: out });
      this._noiseBurst(t + 0.01, { freq: 900, q: 0.9, gain: 0.06, dur: 0.12, dest: out });
      const chime = this._out(0.5);
      this._kalimba(79, t + 0.22, 0.45, chime);
      this._kalimba(84, t + 0.36, 0.4, chime);
    });
  }

  // ---------- 組み立て ----------

  _build() {
    const ctx = this.ctx;

    // 出口：コンプ（安全用）← 音量 ← 歪み ← ローパス ← ミックス
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    comp.connect(ctx.destination);

    this._masterGain = ctx.createGain();
    this._masterGain.gain.value = 0;
    this._masterGain.connect(comp);

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSatCurve(1.5);
    shaper.oversample = '2x';
    shaper.connect(this._masterGain);

    this._toneLP = ctx.createBiquadFilter();
    this._toneLP.type = 'lowpass';
    this._toneLP.frequency.value = TONE_OPEN;
    this._toneLP.Q.value = 0;
    this._toneLP.connect(shaper);

    this._mix = ctx.createGain();
    this._mix.connect(this._toneLP);

    // 残響：その場で作ったインパルスで畳み込む。音楽と効果音それぞれの音量で送る
    const verb = ctx.createConvolver();
    verb.buffer = this._makeImpulse(1.8);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.3;
    verb.connect(verbOut);
    verbOut.connect(this._mix);
    this._musicVerb = ctx.createGain();
    this._sfxVerb = ctx.createGain();
    this._musicVerb.connect(verb);
    this._sfxVerb.connect(verb);

    // 音楽バス：遅延時間をゆっくり揺らしてテープのゆれ（音程 ±6 セントほど）
    this._musicVol = ctx.createGain();
    this._musicVol.connect(this._mix);
    const wow = ctx.createDelay(0.05);
    wow.delayTime.value = 0.006;
    wow.connect(this._musicVol);
    this._lfo(0.31, 0.0016, wow.delayTime);
    this._lfo(0.087, 0.0009, wow.delayTime);
    this._musicIn = ctx.createGain();
    this._musicIn.connect(wow);
    this._drumDuck = ctx.createGain();      // 緊張でドラムだけ下げる
    this._drumDuck.connect(this._musicIn);

    // パート：0 ローズ / 1 ベース / 2 ハイハット / 3 キック・スネア / 4 パッド・リード
    const levels = [0.8, 0.7, 0.45, 0.75, 0.55];
    const sends = [0.3, 0, 0.05, 0.1, 0.5];
    this._parts = levels.map((level, i) => {
      const node = ctx.createGain();
      node.gain.value = 0;
      node.connect(i === 2 || i === 3 ? this._drumDuck : this._musicIn);
      if (sends[i] > 0) {
        const s = ctx.createGain();
        s.gain.value = sends[i];
        node.connect(s);
        s.connect(this._musicVerb);
      }
      return { node, level, target: 0, offAt: 0 };
    });

    // ローズ：少し丸めて、ゆっくり左右に揺らす
    this._chordIn = ctx.createGain();
    const chordLP = ctx.createBiquadFilter();
    chordLP.type = 'lowpass';
    chordLP.frequency.value = 2400;
    chordLP.Q.value = 0;
    this._chordIn.connect(chordLP);
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner();
      chordLP.connect(pan);
      pan.connect(this._parts[0].node);
      this._lfo(0.15, 0.22, pan.pan);
    } else {
      chordLP.connect(this._parts[0].node);
    }

    // パッドとリード：暗めのフィルタをゆっくり動かす
    this._padIn = ctx.createGain();
    const padLP = ctx.createBiquadFilter();
    padLP.type = 'lowpass';
    padLP.frequency.value = 1000;
    padLP.Q.value = 1;
    this._lfo(0.05, 300, padLP.frequency);
    this._padIn.connect(padLP);
    padLP.connect(this._parts[4].node);
    this._leadIn = ctx.createGain();
    const leadLP = ctx.createBiquadFilter();
    leadLP.type = 'lowpass';
    leadLP.frequency.value = 1600;
    leadLP.Q.value = 0;
    this._leadIn.connect(leadLP);
    leadLP.connect(this._parts[4].node);

    // レコードのノイズと部屋の空気（ずっと鳴っている。パート0の一部）
    this._crackleGain = ctx.createGain();
    this._crackleGain.gain.value = 0;
    const crackleHP = ctx.createBiquadFilter();
    crackleHP.type = 'highpass';
    crackleHP.frequency.value = 40;
    crackleHP.Q.value = 0;
    crackleHP.connect(this._crackleGain);
    this._crackleGain.connect(this._musicVol);
    for (const buf of this._makeCrackle()) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(crackleHP);
      src.start();
    }

    // 効果音
    this._sfxVol = ctx.createGain();
    this._sfxVol.connect(this._mix);
    // 連鎖のメロディ（効果音の音量で、BGM の少し下に）
    this._melodyIn = ctx.createGain();
    const melLP = ctx.createBiquadFilter();
    melLP.type = 'lowpass';
    melLP.frequency.value = 2600;
    melLP.Q.value = 0;
    this._melodyIn.connect(melLP);
    melLP.connect(this._sfxVol);
    const melSend = ctx.createGain();
    melSend.gain.value = 0.3;
    this._melodyIn.connect(melSend);
    melSend.connect(this._sfxVerb);

    // 使い回すバッファと波形
    this._noise = makeNoise(ctx, 2);
    this._waves = {
      warm: makeWave(ctx, [0, 1, 0.42, 0.2, 0.1, 0.05, 0.025]),
      bass: makeWave(ctx, [0, 1, 0.26, 0.07]),
      soft: makeWave(ctx, [0, 1, 0.14, 0.05, 0.02]),
    };

    this._built = true;
    const now = ctx.currentTime;
    this._applyVolumes(0.08);
    this._crackleGain.gain.setTargetAtTime(0.3, now, 0.8);
    this._applyLayers(0.9);           // 最初はすこし速めに入る
    this._applyTension(now);
  }

  _lfo(freq, depth, param) {
    const o = this.ctx.createOscillator();
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
    o.start();
    return o;
  }

  // 残響のインパルス：前置きの遅れ＋指数で減るノイズ。後ろほど暗くする
  _makeImpulse(sec) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * sec));
    const buf = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * 0.012);
    const fade = Math.max(1, Math.floor(sr * 0.006));
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const k = i - pre;
        const env = Math.exp((-k / sr) * 3.4) * Math.min(1, k / fade);
        const a = 0.55 - 0.4 * (i / len);
        lp += (Math.random() * 2 - 1 - lp) * a;
        d[i] = lp * env;
      }
    }
    return buf;
  }

  // レコードのノイズ（24kHz で作って節約）。長さの違う2本をループさせて、繰り返しに気づかせない
  _makeCrackle() {
    const ctx = this.ctx;
    const sr = 24000;
    // 1) サー（ピンク寄り）＋部屋の低いうなり＋細かいプチ。つなぎ目は重ねてなめらかに
    const n = Math.floor(sr * 6.1);
    const xf = Math.floor(sr * 0.05);
    const raw = new Float32Array(n + xf);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
      br = (br + 0.02 * w) / 1.02;
      raw[i] += pink * 0.16 + br * 0.5;
      if (Math.random() < 30 / sr) {
        const a = (0.04 + 0.3 * Math.pow(Math.random(), 4)) * (Math.random() < 0.5 ? -1 : 1);
        const len = 2 + Math.floor(Math.random() * 5);
        for (let k = 0; k < len && i + k < raw.length; k++) {
          raw[i + k] += a * Math.exp(-k * 0.9) * (k === 0 ? 1 : Math.random() * 2 - 1);
        }
      }
    }
    const hiss = ctx.createBuffer(1, n, sr);
    const h = hiss.getChannelData(0);
    h.set(raw.subarray(0, n));
    for (let i = 0; i < xf; i++) {
      const u = i / xf;
      h[i] = raw[i] * u + raw[n + i] * (1 - u);
    }

    // 2) ときどきのポツッ、パチパチ（無音の上にまばらに）
    const m = Math.floor(sr * 9.7);
    const pops = ctx.createBuffer(1, m, sr);
    const e = pops.getChannelData(0);
    for (let i = 0; i < m; i++) {
      const r = Math.random();
      if (r < 1.2 / sr) {
        const amp = (0.12 + 0.45 * Math.pow(Math.random(), 2)) * (Math.random() < 0.5 ? -1 : 1);
        const len = 10 + Math.floor(Math.random() * 30);
        let lp = 0;
        for (let k = 0; k < len && i + k < m; k++) {
          const x = (k === 0 ? 1 : Math.random() * 2 - 1) * Math.exp(-k / (len * 0.3));
          lp += (x - lp) * 0.5;
          e[i + k] += amp * lp;
        }
      } else if (r < 1.6 / sr) {
        const count = 3 + Math.floor(Math.random() * 4);
        for (let c = 0; c < count; c++) {
          const j = i + Math.floor(Math.random() * sr * 0.03);
          if (j < m) e[j] += (0.05 + 0.08 * Math.random()) * (Math.random() < 0.5 ? -1 : 1);
        }
      }
    }
    return [hiss, pops];
  }

  // ---------- 状態の反映 ----------

  _resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(() => {});
    } catch (_) {
      // 無視
    }
  }

  _applyVolumes(tc) {
    if (!this._built) return;
    const now = this.ctx.currentTime;
    const v = this._vol;
    const music = v.music * BASE.music;
    const sfx = v.sfx * BASE.sfx;
    this._masterGain.gain.setTargetAtTime(this._muted ? 0 : v.master * BASE.master, now, tc);
    this._musicVol.gain.setTargetAtTime(music, now, tc);
    this._musicVerb.gain.setTargetAtTime(music, now, tc);
    this._sfxVol.gain.setTargetAtTime(sfx, now, tc);
    this._sfxVerb.gain.setTargetAtTime(sfx, now, tc);
  }

  _applyLayers(tc) {
    if (!this._built) return;
    const now = this.ctx.currentTime;
    this._parts.forEach((p, i) => {
      const target = i === 0 || i <= this._layers ? 1 : 0;
      if (target === p.target) return;
      p.target = target;
      p.node.gain.setTargetAtTime(target * p.level, now, tc);
      // 消えていく間は予約を続け、聞こえなくなったらやめる
      p.offAt = target ? Infinity : now + tc * 5;
    });
  }

  _applyTension(now) {
    const x = this._tension.cur;
    this._drumDuck.gain.setTargetAtTime(Math.pow(10, (DUCK_DB * x) / 20), now, 0.03);
    this._toneLP.frequency.setTargetAtTime(TONE_OPEN * Math.pow(TONE_CLOSED / TONE_OPEN, x), now, 0.03);
    this._tension.applied = x;
  }

  // 待たせていた連鎖のメロディを予約する（遅れすぎていたら捨てる）
  _flushMel(now) {
    const m = this._mel;
    if (!m || m.voice) return;
    const at = this._stepTime(m.step);
    if (at < now - 0.02) {
      this._mel = null;
      return;
    }
    const idx = chainMelodyIndex(m.depth);
    const vel = rand(0.5, 0.62) * (1 - 0.3 * (idx / MEL_TOP));
    m.voice = this._kalimba(pentaMidi(idx), Math.max(at, now), vel, this._melodyIn);
  }

  _partOn(i, t) {
    const p = this._parts[i];
    return p.target > 0 || t < p.offAt;
  }

  _releaseHum(now) {
    const h = this._hum;
    if (!h) return;
    this._hum = null;
    try {
      h.g.gain.setTargetAtTime(0, now, 0.06);
      h.o1.stop(now + 0.5);
      h.o2.stop(now + 0.5);
    } catch (_) {
      // 無視
    }
  }

  _canPlay() {
    const ctx = this.ctx;
    if (!ctx || !this._built || this._muted) return false;
    if (this._vol.master <= 0 || this._vol.sfx <= 0) return false;
    // 作った直後はまだ suspended のことがある（その間だけは予約してよい）
    return ctx.state === 'running' || (ctx.state === 'suspended' && nowMs() - this._createdMs < 800);
  }

  _sfx(fn) {
    try {
      if (!this._canPlay()) return;
      fn(this.ctx.currentTime + 0.004);
    } catch (e) {
      this._warn(e);
    }
  }

  _warn(e) {
    if (this._warned) return;
    this._warned = true;
    try {
      console.warn('[audio]', e);
    } catch (_) {
      // 無視
    }
  }

  // ---------- 拍の時計と先読み ----------

  _startTransport() {
    this._t0 = this.ctx.currentTime + 0.3;
    this._step = 0;
    this._plan = null;
    this._pushInto = -1;
    this._mel = null;
    this._transportOn = true;
  }

  // ステップ s（16分）の時刻。スウィング込み
  _stepTime(s) {
    const beat = Math.floor(s / 4);
    return this._t0 + (beat + SUB[s - beat * 4]) * BEAT;
  }

  // 時刻 time 以降で最初の、every の倍数のステップ
  _stepAtOrAfter(time, every) {
    let s = Math.max(0, Math.floor((time - this._t0) / BEAT) * 4);
    while (this._stepTime(s) < time || s % every !== 0) s++;
    return s;
  }

  _span(step, d) {
    return this._stepTime(step + d) - this._stepTime(step);
  }

  _schedule(now) {
    // 遅れすぎた（タブが裏にいた、長く止まっていた）ときは、過ぎた拍を鳴らさずに飛ばす
    if (now - this._stepTime(this._step) > LATE_SKIP) {
      this._step = this._stepAtOrAfter(now + 0.02, 1);
      this._reentry = true;
      this._mel = null;
    }
    const horizon = now + LOOKAHEAD;
    for (let guard = 0; guard < 32; guard++) {
      const t = this._stepTime(this._step);
      if (t >= horizon) break;
      this._playStep(this._step, Math.max(t, now));
      this._step++;
    }
  }

  _playStep(step, t) {
    const bar = Math.floor(step / 16);
    const s = step - bar * 16;
    if (!this._plan || this._plan.bar !== bar) this._plan = this._planBar(bar);
    const plan = this._plan;
    const reentry = this._reentry;
    this._reentry = false;
    if (this._muted || this._vol.master <= 0 || this._vol.music <= 0) return;
    const now = this.ctx.currentTime;
    const jit = (ms) => Math.max(now, t + rand(-ms, ms) / 1000);   // 人の手のゆらぎ

    // 0: ローズ
    if (this._partOn(0, t)) {
      const c = plan.chord[s];
      if (c) this._chord(c.ci, jit(5), this._span(step, c.d), c.v, 0.018);
      else if (reentry && s < 13) this._chord(plan.ci, t, this._span(step, 16 - s), 0.5, 0.3);
    }
    // 1: ベース
    if (this._partOn(1, t)) {
      const b = plan.bass[s];
      if (b) this._bass(b.m, jit(4), this._span(step, b.d), b.v);
    }
    // 2: ハイハット
    if (this._partOn(2, t)) {
      const h = plan.hat[s];
      if (h) this._hat(jit(5), h.v, h.open);
    }
    // 3: キック・スネア（スネアはほんの少し後ろに）
    if (this._partOn(3, t)) {
      const k = plan.kick[s];
      const sn = plan.snare[s];
      if (k) this._kick(jit(3), k);
      if (sn) this._snare(Math.max(now, t + 0.012 + rand(-0.004, 0.004)), sn);
    }
    // 4: パッドとリード
    if (this._partOn(4, t)) {
      if (s === 0) for (const m of PAD_NOTES[plan.ci]) this._padNote(m, t, this._span(step, 16), 0.9);
      const l = plan.lead[s];
      if (l) this._leadNote(l.m, jit(10), this._span(step, l.d), l.v);
    }
  }

  // 1小節ぶんの譜面を決める（毎回少しずつ変える）
  _planBar(bar) {
    const R = Math.random;
    const ci = bar % 4;
    const next = (bar + 1) % 4;
    const p = { bar, ci, chord: [], bass: [], hat: [], kick: [], snare: [], lead: [] };

    // ローズ：頭で弾いて、ときどき弾き直す。たまに次のコードを8分早く先取りする
    if (this._pushInto !== bar) {
      const r = R();
      if (r < 0.34) {
        p.chord[0] = { ci, d: 16, v: 0.9 };
      } else if (r < 0.58) {
        p.chord[0] = { ci, d: 10, v: 0.9 };
        p.chord[10] = { ci, d: 6, v: 0.6 };
      } else if (r < 0.8) {
        p.chord[0] = { ci, d: 6, v: 0.88 };
        p.chord[6] = { ci, d: 10, v: 0.65 };
      } else {
        p.chord[0] = { ci, d: 14, v: 0.9 };
        p.chord[14] = { ci: next, d: 18, v: 0.82 };
        this._pushInto = bar + 1;
      }
    }

    // ベース：頭に根音、3拍目の裏に根音か5度、ときどき次の根音へのつなぎ
    const root = BASS_ROOTS[ci];
    p.bass[0] = { m: root, d: R() < 0.5 ? 7 : 5, v: 0.95 };
    const rb = R();
    if (rb < 0.45) p.bass[10] = { m: root, d: 3, v: 0.72 };
    else if (rb < 0.75) p.bass[10] = { m: root + 7, d: 3, v: 0.64 };
    else if (rb < 0.9) p.bass[7] = { m: root + 12, d: 2, v: 0.5 };
    if (R() < 0.45) p.bass[14] = { m: BASS_ROOTS[next] + (R() < 0.5 ? -1 : 2), d: 2, v: 0.55 };

    // ハイハット：8分。表を少し強く、ときどき抜いたり16分のゴーストを足したり
    for (let s = 0; s < 16; s += 2) {
      if (R() < 0.05) continue;
      p.hat[s] = { v: (s % 4 === 0 ? 0.8 : 0.58) * rand(0.85, 1.12), open: s === 14 && R() < 0.22 };
    }
    if (R() < 0.3) p.hat[R() < 0.5 ? 7 : 15] = { v: 0.3, open: false };
    if (R() < 0.18) p.hat[11] = { v: 0.26, open: false };

    // キックとスネア（ブーンバップを静かに）
    p.kick[0] = rand(0.92, 1);
    if (R() < 0.8) p.kick[10] = rand(0.7, 0.82);
    else p.kick[11] = rand(0.62, 0.74);
    if (R() < 0.2) p.kick[6] = rand(0.5, 0.6);
    if (R() < 0.1) p.kick[15] = 0.42;
    p.snare[4] = rand(0.8, 0.9);
    p.snare[12] = rand(0.85, 0.95);
    if (R() < 0.18) p.snare[7] = 0.22;
    if (ci === 3 && R() < 0.35) p.snare[15] = 0.28;

    // リード：2小節に1回、ペンタトニックの短いフレーズ
    if (bar % 2 === 1 && R() < 0.75) {
      const slots = [0, 3, 6, 8, 10, 12, 14].filter(() => R() < 0.4);
      if (slots.length === 0) slots.push(8);
      for (let i = 0; i < slots.length && i < 4; i++) {
        this._leadIdx = clamp(this._leadIdx + Math.floor(R() * 5) - 2, 5, 10);
        if (ci === 1 && this._leadIdx % 5 === 0) this._leadIdx += 1;   // G13 の上では C を避ける
        const until = i + 1 < slots.length ? slots[i + 1] : 16;
        p.lead[slots[i]] = {
          m: pentaMidi(this._leadIdx),
          d: Math.min(until - slots[i], 3 + Math.floor(R() * 3)),
          v: rand(0.55, 0.85),
        };
      }
    }
    return p;
  }

  // ---------- BGM の声 ----------

  // 和音：左手の根音＋右手。下から少しずつずらして弾く
  _chord(ci, t, dur, vel, att) {
    const notes = VOICINGS[ci];
    const up = Math.random() < 0.8;
    const gap = rand(0.007, 0.019);
    this._rhodes(RH_ROOTS[ci], t, dur, vel * 0.7, this._chordIn, att);
    for (let i = 0; i < notes.length; i++) {
      const k = up ? i + 1 : notes.length - i;
      const dt = k * gap + rand(-0.002, 0.002);
      this._rhodes(notes[i], t + dt, Math.max(0.05, dur - dt), vel * rand(0.82, 1.02), this._chordIn, att);
    }
  }

  // エレピ（2オペレータの FM）。叩いた瞬間は明るく、すぐ丸くなる
  _rhodes(midi, t, dur, vel, dest, att) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const depth = ctx.createGain();
    const amp = ctx.createGain();
    car.frequency.value = f;
    car.detune.value = rand(-4, 4);
    mod.frequency.value = f;
    const reg = clamp((midi - 48) / 36, 0, 1);         // 高い音ほど変調を浅く
    const index = (0.6 + 1.1 * vel) * (1 - 0.5 * reg);
    depth.gain.setValueAtTime(f * index, t);
    depth.gain.setTargetAtTime(f * index * 0.22, t, 0.18);
    const a = Math.max(0.005, att);
    const peak = 0.11 * vel;
    const end = t + Math.max(dur, a + 0.05);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + a);
    amp.gain.setTargetAtTime(peak * 0.3, t + a + 0.001, 0.9 - 0.4 * reg);
    amp.gain.setTargetAtTime(0, end, 0.14);
    mod.connect(depth);
    depth.connect(car.frequency);
    car.connect(amp);
    amp.connect(dest);
    car.start(t);
    mod.start(t);
    car.stop(end + 0.9);
    mod.stop(end + 0.9);
  }

  // サブベース（サイン＋少しの倍音で小さなスピーカーでも聞こえるように）
  _bass(midi, t, dur, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this._waves.bass);
    o.frequency.value = mtof(midi);
    const g = ctx.createGain();
    const peak = 0.42 * vel;
    const end = t + Math.max(dur, 0.08);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.012);
    g.gain.setTargetAtTime(peak * 0.62, t + 0.013, 0.5);
    g.gain.setTargetAtTime(0, end, 0.05);
    o.connect(g);
    g.connect(this._parts[1].node);
    o.start(t);
    o.stop(end + 0.4);
  }

  // ハイハット：高域のノイズ（全体のローパスで丸まって、ほこりっぽく聞こえる。そのぶん大きめに出す）
  _hat(t, vel, open) {
    this._noiseBurst(t, {
      type: 'highpass', freq: 3000, q: 0, gain: 1.1 * vel, dur: open ? 0.22 : 0.045, dest: this._parts[2].node,
    });
  }

  // キック：下がっていくサイン＋頭のカチ
  _kick(t, vel) {
    const ctx = this.ctx;
    const dest = this._parts[3].node;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(118, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.75 * vel, t + 0.003);
    g.gain.setTargetAtTime(0, t + 0.02, 0.085);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.6);
    this._noiseBurst(t, { freq: 1400, q: 0.9, gain: 0.12 * vel, dur: 0.012, dest });
  }

  // スネア：ノイズ＋胴。ブラシ寄りにやわらかく
  _snare(t, vel) {
    const dest = this._parts[3].node;
    this._noiseBurst(t, { freq: 1900, q: 0.75, gain: 0.34 * vel, dur: 0.19, dest });
    this._tone(t, { f: 200, f2: 172, glide: 0.04, gain: 0.2 * vel, dur: 0.1, att: 0.001, dest });
  }

  _padNote(midi, t, dur, vel) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const peak = 0.05 * vel;
    const att = 1.2;
    const end = t + Math.max(dur, att + 0.1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + att);
    g.gain.setTargetAtTime(0, end, 0.5);
    g.connect(this._padIn);
    for (const dc of [-8, 7]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(this._waves.warm);
      o.frequency.value = mtof(midi);
      o.detune.value = dc + rand(-2, 2);
      o.connect(g);
      o.start(t);
      o.stop(end + 3);
    }
  }

  _leadNote(midi, t, dur, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this._waves.soft);
    o.frequency.value = mtof(midi);
    const g = ctx.createGain();
    const peak = 0.06 * vel;
    const end = t + Math.max(dur, 0.1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.05);
    g.gain.setTargetAtTime(peak * 0.6, t + 0.06, 0.4);
    g.gain.setTargetAtTime(0, end, 0.12);
    o.connect(g);
    g.connect(this._leadIn);
    o.start(t);
    o.stop(end + 1);
  }

  // ---------- 効果音の部品 ----------

  // 効果音の出口。send > 0 なら残響にも送る
  _out(send) {
    if (!(send > 0)) return this._sfxVol;
    const ctx = this.ctx;
    const g = ctx.createGain();
    const s = ctx.createGain();
    s.gain.value = send;
    g.connect(this._sfxVol);
    g.connect(s);
    s.connect(this._sfxVerb);
    return g;
  }

  // 鍵盤とカリンバの間のような、はじく音（連鎖のメロディ、チャイム）。消すための { amp, oscs } を返す
  _kalimba(midi, t, vel, dest) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const depth = ctx.createGain();
    const amp = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f;
    depth.gain.setValueAtTime(f * (0.6 + 1.2 * vel), t);
    depth.gain.setTargetAtTime(f * 0.06, t, 0.05);
    const peak = 0.2 * vel;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + 0.004);
    amp.gain.setTargetAtTime(0, t + 0.006, 0.34);
    mod.connect(depth);
    depth.connect(car.frequency);
    car.connect(amp);
    amp.connect(dest);
    car.start(t);
    mod.start(t);
    car.stop(t + 2.2);
    mod.stop(t + 2.2);
    return { amp, oscs: [car, mod] };
  }

  // 金属の部分音ひとつ（t60 = 60dB 下がるまでの秒数）
  _ring(f, t, gain, t60, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.003, t60 / 6.9);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + t60 + 0.1);
  }

  // 木の当たる音：帯域を絞ったノイズの一瞬＋（あれば）小さな胴鳴り
  _woodClick(t, gain, freq, dest, body) {
    this._noiseBurst(t, { freq, q: 3.2, gain, dur: 0.028, dest });
    if (body > 0) this._tone(t, { f: freq * 0.22, gain: body, dur: 0.05, dest });
  }

  // 音程のある短い音。f → f2 へ下がりながら指数で消える
  _tone(t, { f, f2 = 0, glide = 0.05, gain, dur, att = 0.002, dest, type = 'sine' }) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    const f1 = Math.max(20, f);
    o.frequency.setValueAtTime(f1, t);
    if (f2 > 0 && f2 !== f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + Math.max(0.005, glide));
    const g = ctx.createGain();
    const a = Math.max(0.001, num(att, 0.002));
    const d = Math.max(a + 0.01, num(dur, 0.1));
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(1e-4, num(gain, 0.1)), t + a);
    g.gain.exponentialRampToValueAtTime(1e-4, t + d);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + d + 0.03);
  }

  // フィルタを通したノイズの一瞬（共有のノイズを好きな位置から使う）。
  // 帯域を絞るほど音が小さくなるので、通る帯域の広さでおおよそ補正する（gain は音色どうしで比べられる大きさ）
  _noiseBurst(t, { type = 'bandpass', freq = 1000, q = 1, gain, dur, att = 0, dest }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const flt = ctx.createBiquadFilter();
    const ny = ctx.sampleRate / 2;
    const f = clamp(freq, 20, ny * 0.9);
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const band = type === 'bandpass' ? f / Math.max(0.1, q) : type === 'lowpass' ? f : type === 'highpass' ? ny - f : ny;
    const comp = clamp(Math.sqrt(ny / Math.max(1, band)), 1, 12);
    const g = ctx.createGain();
    const d = Math.max(0.005, num(dur, 0.05), att + 0.005);
    const peak = Math.max(1e-4, num(gain, 0.1) * comp);
    if (att > 0) {
      g.gain.setValueAtTime(1e-4, t);
      g.gain.exponentialRampToValueAtTime(peak, t + att);
    } else {
      g.gain.setValueAtTime(peak, t);
    }
    g.gain.exponentialRampToValueAtTime(1e-4, t + d);
    src.connect(flt);
    flt.connect(g);
    g.connect(dest);
    const off = Math.random() * Math.max(0, this._noise.duration - d - 0.1);
    src.start(t, off);
    src.stop(t + d + 0.02);
  }
}
