// 「ドミノが音符」の楽器（WebAudio でその場で合成する。音源ファイルは使わない）。
// 小＝ベル（オルゴールのような高い鈴）、中＝木琴（マリンバ）、大＝やわらかいベース。
// 音は本体の Sound の効果音の出口（sound._sfxVol）と残響（sound._sfxVerb）へ流すので、
// 音量・ミュート（M）・全体のこもり方は BGM や他の効果音と同じようにかかる。
// 拍の時計も本体の BGM（72BPM、スウィングつき）のものを借りる（sound._stepAtOrAfter / _stepTime）。

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const MAX_VOICES = { note: 40, click: 16 };   // 同時に鳴らす数の上限（あふれた分は鳴らさない。カタッで音符が止まらないよう別枠）
const SIXTEENTH = 60 / 72 / 4;

export class MusicSynth {
  constructor(sound) {
    this.sound = sound;
    this.bus = null;
    this.busCtx = null;
    this.voices = { note: [], click: [] };   // 鳴っている音の終わる時刻
    this.noiseBuf = null;
    this.bassWave = null;
    this.warned = false;
  }

  get ctx() {
    return this.sound.ctx;
  }

  // いま音を出せるか（「はじめる」を押す前・ミュート中は出さない）
  ready() {
    const s = this.sound;
    const c = s.ctx;
    return !!(c && s._built && !s.muted && c.state !== 'closed' && s._sfxVol);
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // BGM の拍の時計が動いているか
  get clockOn() {
    const s = this.sound;
    return !!(s.ctx && s._transportOn && typeof s._stepAtOrAfter === 'function' && typeof s._stepTime === 'function');
  }

  // 時刻 t 以降で最初の、every の倍数の16分（{ step, t }）。時計がなければ、そのまま
  nextStep(t, every = 1) {
    if (!this.clockOn) return { step: -1, t };
    const s = this.sound;
    const step = s._stepAtOrAfter(t, every);
    return { step, t: s._stepTime(step) };
  }

  stepTime(step) {
    return this.clockOn ? this.sound._stepTime(step) : this.now() + step * SIXTEENTH;
  }

  _ensure() {
    const ctx = this.ctx;
    if (this.bus && this.busCtx === ctx) return true;
    if (!ctx || !this.sound._sfxVol) return false;
    const bus = ctx.createGain();
    bus.gain.value = 1;
    // ほんの少し丸める（夜のちゃぶ台らしく、耳に痛い高音を落とす）
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    lp.Q.value = 0.2;
    bus.connect(lp);
    lp.connect(this.sound._sfxVol);
    if (this.sound._sfxVerb) {
      const send = ctx.createGain();
      send.gain.value = 0.32;
      bus.connect(send);
      send.connect(this.sound._sfxVerb);
    }
    // 木の当たる音・木琴の打つ音に使うノイズ
    const len = Math.max(1, Math.floor(ctx.sampleRate * 0.06));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
    this.noiseBuf = buf;
    // ベースの波形（基音に2〜4倍音を少し。小さなスピーカーでも音の高さが分かるように）
    this.bassWave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.32, 0.1, 0.03]));
    this.bus = bus;
    this.busCtx = ctx;
    return true;
  }

  _warn(e) {
    if (this.warned) return;
    this.warned = true;
    try {
      console.warn('[music]', e);
    } catch (_) {
      // 無視
    }
  }

  // 同時に鳴る数を数える。上限なら false
  _claim(t, dur, pool = 'note') {
    const now = this.now();
    const v = this.voices[pool];
    let n = 0;
    for (let i = 0; i < v.length; i++) if (v[i] > now) v[n++] = v[i];
    v.length = n;
    if (n >= MAX_VOICES[pool]) return false;
    v.push(t + dur);
    return true;
  }

  // 左右の位置（-1..1）つきの出口
  _out(pan) {
    const ctx = this.ctx;
    if (typeof ctx.createStereoPanner !== 'function') return this.bus;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan || 0, -0.8, 0.8);
    p.connect(this.bus);
    return p;
  }

  // ---------- 公開 ----------

  // 音符を1つ鳴らす。size で楽器が変わる。t は AudioContext の時刻（省略でいま）
  note(midi, size, { t = 0, vel = 0.8, pan = 0, sparkle = false } = {}) {
    try {
      if (!this.ready() || !this._ensure()) return false;
      const at = Math.max(this.now() + 0.004, t || 0);
      const dur = size === 'l' ? 2.8 : size === 's' ? 2.0 : 1.2;
      if (!this._claim(at, dur)) return false;
      const out = this._out(pan);
      if (size === 's') this._bell(midi, at, vel, out);
      else if (size === 'l') this._bass(midi, at, vel, out);
      else this._marimba(midi, at, vel, out);
      // ちょうどいい間隔で置いたときの、キラッ（1オクターブ上と、その5度上をかすかに）
      if (sparkle) {
        const f = mtof(midi + (size === 'l' ? 24 : 12));
        this._partial(f, at + 0.01, 0.022 * vel, 0.5, out, 0.004);
        this._partial(f * 1.5, at + 0.03, 0.012 * vel, 0.35, out, 0.004);
      }
      return true;
    } catch (e) {
      this._warn(e);
      return false;
    }
  }

  // 音の鳴らない つなぎ が倒れるときの、小さなカタッ
  click(size, { t = 0, pan = 0, gain = 1 } = {}) {
    try {
      if (!this.ready() || !this._ensure()) return;
      const at = Math.max(this.now() + 0.004, t || 0);
      if (!this._claim(at, 0.05, 'click')) return;
      const f = { s: 3200, m: 2500, l: 1700 }[size] || 2500;
      this._noise(at, f * (1 + (Math.random() - 0.5) * 0.12), 2.6, 0.6 * gain, 0.028, this._out(pan));
    } catch (e) {
      this._warn(e);
    }
  }

  // 帯の上を手でなぞったときの、ごく小さなポロン
  pluck(midi, { pan = 0, gain = 1 } = {}) {
    try {
      if (!this.ready() || !this._ensure()) return;
      const at = this.now() + 0.004;
      if (!this._claim(at, 0.6, 'click')) return;
      const out = this._out(pan);
      const f = mtof(midi);
      this._partial(f, at, 0.03 * gain, 0.55, out, 0.006);
      this._partial(f * 2, at, 0.008 * gain, 0.25, out, 0.006);
    } catch (e) {
      this._warn(e);
    }
  }

  // ---------- 楽器 ----------

  // 正弦波ひとつ。t60 は 60dB 下がるまでの秒数
  _partial(f, t, peak, t60, dest, att = 0.002) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(1e-4, peak), t + att);
    g.gain.setTargetAtTime(0, t + att + 0.001, t60 / 6.9);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + att + t60 + 0.05);
  }

  // 帯域をしぼったノイズの一瞬（木の当たる音・マレットの音）。
  // 帯域をしぼるほど小さく聞こえるので、gain は大きめに渡す（0.6 で「コツ」くらい）
  _noise(t, freq, q, gain, dur, dest, type = 'bandpass') {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(freq, ctx.sampleRate * 0.45);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(1e-4, gain), t);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  // 小：ベル。基音と、ほんの少しずらした基音（ゆっくりうなる）、オクターブ、金属らしい倍音
  _bell(midi, t, vel, dest) {
    const f = mtof(midi);
    const a = 0.1 * vel;
    this._partial(f, t, a, 1.9, dest);
    this._partial(f * 1.0027, t, a * 0.35, 1.5, dest);
    this._partial(f * 2.0, t, a * 0.2, 0.8, dest);
    this._partial(f * 2.76, t, a * 0.1, 0.4, dest);
    this._partial(f * 5.4, t, a * 0.04, 0.16, dest, 0.001);
  }

  // 中：木琴（マリンバ）。基音＋2オクターブ上の倍音はすぐ消える＋マレットのコツ
  _marimba(midi, t, vel, dest) {
    const f = mtof(midi);
    const a = 0.17 * vel;
    this._partial(f, t, a, 1.05, dest, 0.003);
    this._partial(f * 4.0, t, a * 0.22, 0.16, dest, 0.001);
    this._partial(f * 9.9, t, a * 0.04, 0.05, dest, 0.001);
    this._noise(t, 1600 + f * 1.5, 0.9, 0.25 * vel, 0.014, dest);
  }

  // 大：やわらかいベース。こもった三角波ぎみの音が、ゆっくり消えていく
  _bass(midi, t, vel, dest) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.bassWave);
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.5;
    lp.frequency.setValueAtTime(1100, t);
    lp.frequency.setTargetAtTime(420, t + 0.01, 0.2);
    const g = ctx.createGain();
    const a = 0.3 * vel;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(a, t + 0.014);
    g.gain.setTargetAtTime(0, t + 0.015, 0.4);
    o.connect(lp);
    lp.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 2.8);
    // 弾いた瞬間の、指の当たるような柔らかいコツ
    this._noise(t, 700, 0.7, 0.2 * vel, 0.03, dest, 'lowpass');
  }
}
