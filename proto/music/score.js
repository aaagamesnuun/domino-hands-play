// 「ドミノが音符」の、描画にも音にも依存しない部分。
// ・盆の床の7本の帯（奥行き z 方向に並ぶ。手前が低い音、奥が高い音）と音の高さ
// ・最初から並べてある お手本（きらきら星の冒頭「ドドソソ」。続きの「ララソー」は自分で並べる）
// ・倒れた順の音を、拍にそろえ直す「おさらい」の譜割り

import { LAYOUT } from '../../src/config.js';

const TR = LAYOUT.tray;

export const LANE_COUNT = 7;
export const LANE_W = (TR.z1 - TR.z0) / LANE_COUNT;   // 約 1.71（ドミノ3枚ぶんくらい）

// C メジャー・ペンタトニック（C D E G A）の2オクターブから7つ。手前（z が大きい）から順に
export const LANE_MIDI = [60, 62, 64, 67, 69, 72, 74];
export const LANE_NAME = ['ド', 'レ', 'ミ', 'ソ', 'ラ', 'ド', 'レ'];
// 淡い虹色（手前の赤っぽい色から、奥の紫へ）
export const LANE_COLOR = ['#e79a98', '#ebb488', '#e6d58a', '#a9d39c', '#94c6d9', '#a4a9e2', '#c9a3dd'];

// 大きさで音色と高さが変わる：小＝1オクターブ上のベル、中＝木琴、大＝1オクターブ下のやわらかいベース
export const SIZE_SHIFT = { s: 12, m: 0, l: -12 };
export const SIZE_VOICE = { s: 'ベル', m: '木琴', l: 'ベース' };

// 音の鳴らない「つなぎ」のドミノの色（白木）
export const WOOD = '#b9a07e';

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// z → 帯の番号（0 = いちばん手前のド）
export function laneOf(z) {
  return clamp(Math.floor((TR.z1 - z) / LANE_W), 0, LANE_COUNT - 1);
}

export function laneCenter(i) {
  return TR.z1 - (i + 0.5) * LANE_W;
}

export function midiFor(lane, size = 'm') {
  return LANE_MIDI[clamp(lane | 0, 0, LANE_COUNT - 1)] + (SIZE_SHIFT[size] ?? 0);
}

export function inTray(x, z) {
  return x >= TR.x0 && x <= TR.x1 && z >= TR.z0 && z <= TR.z1;
}

// ---------- お手本の並べ方 ----------

// 道を描くペン。yaw は進む向き（方向 = (sin yaw, cos yaw)。+x が π/2、奥 -z が π）
const PEN_STEP = 0.02;

class Pen {
  constructor(x, z, yaw) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.s = 0;
    this.pts = [{ x, z, yaw, s: 0 }];
    this.marks = [];
  }

  _move(d) {
    this.x += Math.sin(this.yaw) * d;
    this.z += Math.cos(this.yaw) * d;
    this.s += d;
  }

  straight(len) {
    const n = Math.max(1, Math.ceil(len / PEN_STEP));
    for (let i = 0; i < n; i++) {
      this._move(len / n);
      this.pts.push({ x: this.x, z: this.z, yaw: this.yaw, s: this.s });
    }
    return this;
  }

  // 半径 r で deg 度まがる（正で yaw が増える向き：+x へ進んでいるなら奥へ曲がる）
  arc(r, deg) {
    const rad = (deg * Math.PI) / 180;
    const len = Math.abs(rad) * r;
    const n = Math.max(1, Math.ceil(len / PEN_STEP));
    const dy = rad / n;
    for (let i = 0; i < n; i++) {
      this.yaw += dy / 2;
      this._move(len / n);
      this.yaw += dy / 2;
      this.pts.push({ x: this.x, z: this.z, yaw: this.yaw, s: this.s });
    }
    return this;
  }

  // ここに音のドミノを置く
  note(lane, size = 'm') {
    this.marks.push({ s: this.s, lane, size });
    return this;
  }

  // 道のはじめから s 進んだところ
  at(s) {
    const p = this.pts;
    let lo = 0, hi = p.length - 1;
    if (s <= 0) return { ...p[0] };
    if (s >= p[hi].s) return { ...p[hi] };
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const a = p[lo], b = p[hi];
    const k = (s - a.s) / Math.max(1e-9, b.s - a.s);
    return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + (b.yaw - a.yaw) * k, s };
  }
}

function stageDomino(x, z, yaw, size, lane, silent) {
  return {
    x, z, yaw, size,
    color: silent ? WOOD : LANE_COLOR[lane],
    meta: { lane, silent, midi: midiFor(lane, size), stage: true },
  };
}

// きらきら星の冒頭「ド ド ソ ソ」。音と音の間には、音の鳴らない つなぎ を9〜11枚。
// つなぎの数（＝道のりの長さ）が音の間の長さになるので、どの音の間もだいたい同じ長さにしてある。
// ドからソへの跳躍（帯3本ぶん）は、奥へ折り返す道で稼ぐ。最後のソは左向き：続きは左の空いた場所へ。
export const SAMPLE = {
  x: -1.0,        // 1つめの「ド」の位置
  span: 6.0,      // 同じ帯の音どうしの道のり（0.6 間隔で10すき間）
  turnR: 2.0,     // 折り返しの半径（1枚ごとに約18°まがる）
  gap: 0.6,       // つなぎの目安の間隔（中の高さ 1.0 に対して 0.6 倍＝ちょうどいい間隔）
  lead: 1.0,      // はじめの大きいドミノ（低いド）と、1つめのドの間隔
};

export function buildSample() {
  const { x, span, turnR, gap, lead } = SAMPLE;
  const z0 = laneCenter(0);
  const z3 = laneCenter(3);
  const rise = z0 - z3 - 2 * turnR;              // 折り返しの間のまっすぐな部分（約 1.14）
  const pen = new Pen(x, z0, Math.PI / 2);
  pen.note(0).straight(span).note(0)
    .arc(turnR, 90).straight(rise).arc(turnR, 90)
    .note(3).straight(span).note(3);

  const dominoes = [];
  // 指で押すのは、この大きいドミノ（1オクターブ下のド。1つめのドとほぼ同時に鳴って和音になる）
  dominoes.push(stageDomino(x - lead, z0, Math.PI / 2, 'l', 0, false));
  const marks = pen.marks;
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const p = pen.at(m.s);
    dominoes.push(stageDomino(p.x, p.z, p.yaw, m.size, m.lane, false));
    if (i + 1 >= marks.length) break;
    const len = marks[i + 1].s - m.s;
    const n = Math.max(1, Math.round(len / gap));
    for (let k = 1; k < n; k++) {
      const q = pen.at(m.s + (len * k) / n);
      dominoes.push(stageDomino(q.x, q.z, q.yaw, 'm', laneOf(q.z), true));
    }
  }
  const end = pen.at(pen.s);
  return {
    dominoes,
    start: { x: x - lead, z: z0 },
    end: { x: end.x, z: end.z, yaw: end.yaw },
  };
}

// ---------- おさらい（倒れた順の音を、拍にそろえ直す） ----------

// notes: [{ tick, midi, ... }]（倒れ始めた順）。
// 音の間の長さを「ふつうの間」（真ん中の半分の平均）で割って、16分・8分・4分…にそろえる。
// ほぼ同時（間が 0.3 未満）は和音、0.72 未満は16分、それより長いものは8分の倍数（長くても2分音符まで）。
// 返り値の step は16分の数（0 から）
export function quantizeTake(notes, { maxNotes = 96, maxChord = 4 } = {}) {
  const list = notes.slice(0, maxNotes);
  if (list.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < list.length; i++) {
    const d = list[i].tick - list[i - 1].tick;
    if (d >= 3) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  // 基準の間：真ん中の半分の平均（倒れる速さの小さなむらに引きずられないように）
  let base = 1;
  if (gaps.length) {
    const lo = Math.floor(gaps.length * 0.25);
    const hi = Math.max(lo + 1, Math.ceil(gaps.length * 0.75));
    const mid = gaps.slice(lo, hi);
    base = mid.reduce((a, b) => a + b, 0) / mid.length;
  }
  const out = [];
  let step = 0;
  let chord = 0;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      const q = (list[i].tick - list[i - 1].tick) / base;
      const inc = q < 0.3 ? 0 : q < 0.72 ? 1 : Math.min(8, 2 * Math.max(1, Math.round(q - 0.3)));
      step += inc;
      chord = inc === 0 ? chord + 1 : 0;
      if (chord >= maxChord) continue;
    }
    out.push({ ...list[i], step });
  }
  return out;
}

// 音名の並び（オクターブは無視）。同じ拍に同じ音名が重なったもの（低いドと高いドの和音など）は1つにまとめる
export function melodyOf(events) {
  const pcs = [];
  let lastStep = -1;
  let lastPc = -1;
  for (const e of events) {
    const pc = ((e.midi % 12) + 12) % 12;
    if (e.step === lastStep && pc === lastPc) continue;
    lastStep = e.step;
    lastPc = pc;
    pcs.push(pc);
  }
  return pcs;
}

// きらきら星の冒頭「ドドソソララソ」が入っているか
const TWINKLE = [0, 0, 7, 7, 9, 9, 7];
export function hasTwinkle(events) {
  const m = melodyOf(events);
  for (let i = 0; i + TWINKLE.length <= m.length; i++) {
    let ok = true;
    for (let k = 0; k < TWINKLE.length; k++) {
      if (m[i + k] !== TWINKLE[k]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}
