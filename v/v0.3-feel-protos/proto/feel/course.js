// コースを組み立てる：道すじ（線・弧・ふくらみ・S字）、最初から置いてあるドミノ、
// とぎれ（自分でつなぐところ）、坂・本・ものさしの橋・鐘。
//
// 道すじは盆いっぱいに3本の道を折り返してつなぐ（手前 → 右で折り返し → まんなか → 左で折り返し → 奥 → 鐘）。
//   手前（z=2.0）  ：平ら → のぼり坂 → 本 → 本の上の本（段を上って下りる）→ くだり坂
//   まんなか（z=-2.4）：本へ上がる → ものさしの橋 → 本から下りる → 手前へふくらむ
//   奥（z=-6.4）    ：中 → 小のS字 → 中 → 大 → 鐘（大きさの階段）
// 長さの単位は「中のドミノの高さ = 1」。

import { ramp, block, SIZES } from '../lib/protosim.js';

export const Z1 = 2.0;    // 手前の道
export const Z2 = -2.4;   // まんなかの道
export const Z3 = -6.4;   // 奥の道

export const STAGE_COLOR = '#cfc6b6';   // 最初から置いてあるドミノ（少しくすんだ生成り）
export const START_COLOR = '#f5eedd';   // はじめの1枚

const PI = Math.PI;
const SPACING = 0.6;        // 同じ大きさどうしの間隔（高さに対する比）
const MIXED = 0.66;         // 大きさが変わるところの間隔（小さい方の高さに対する比）

// ---------- 道すじの部品。f(v) は v = 0..1 の点 ----------

function line(x0, z0, x1, z1, size) {
  return { size, approx: Math.hypot(x1 - x0, z1 - z0), f: (v) => ({ x: x0 + (x1 - x0) * v, z: z0 + (z1 - z0) * v }) };
}
function arc(cx, cz, r, a0, a1, size) {
  return {
    size, approx: Math.abs(a1 - a0) * r,
    f: (v) => {
      const a = a0 + (a1 - a0) * v;
      return { x: cx + r * Math.cos(a), z: cz + r * Math.sin(a) };
    },
  };
}
// ふくらみ：端では向きがまっすぐにそろい、まんなかで amp だけ横へ出る
function bump(x0, x1, z0, amp, size) {
  return {
    size, approx: Math.abs(x1 - x0) * 1.1,
    f: (v) => ({ x: x0 + (x1 - x0) * v, z: z0 + (amp * (1 - Math.cos(2 * PI * v))) / 2 }),
  };
}
// S字：端では向きがまっすぐにそろう
function swing(x0, x1, z0, amp, size) {
  return {
    size, approx: Math.abs(x1 - x0) * 1.15,
    f: (v) => ({ x: x0 + (x1 - x0) * v, z: z0 + amp * Math.sin(2 * PI * v) * Math.sin(PI * v) }),
  };
}

export const LEGS = [
  line(-10.6, Z1, 8.5, Z1, 'm'),                    // 0 手前：坂と本
  arc(8.5, -0.2, 2.2, PI / 2, -PI / 2, 'm'),         // 1 右の折り返し
  line(8.5, Z2, -3.4, Z2, 'm'),                     // 2 まんなか：本とものさしの橋
  bump(-3.4, -8.5, Z2, 0.7, 'm'),                   // 3 まんなか：手前へふくらむ
  arc(-8.5, -4.4, 2.0, PI / 2, (3 * PI) / 2, 'm'),   // 4 左の折り返し
  line(-8.5, Z3, -6.0, Z3, 'm'),                    // 5 奥：中
  swing(-6.0, -0.5, Z3, 0.55, 's'),                 // 6 奥：小のS字
  line(-0.5, Z3, 3.5, Z3, 'm'),                     // 7 奥：中
  line(3.5, Z3, 8.2, Z3, 'l'),                      // 8 奥：大 → 鐘
];

// ---------- 道すじ（細かい折れ線にして、道のりで引けるようにする） ----------

export function buildPath(legs, step = 0.01) {
  const pts = [];
  const legStart = [], legEnd = [];
  let s = 0;
  legs.forEach((leg, li) => {
    const n = Math.max(8, Math.ceil(leg.approx / step));
    if (li > 0) {
      const q = pts[pts.length - 1];
      const p0 = leg.f(0);
      if (Math.hypot(p0.x - q.x, p0.z - q.z) > 1e-3) console.warn('[course] 道がつながっていない', li);
    }
    legStart[li] = s;
    for (let i = li === 0 ? 0 : 1; i <= n; i++) {
      const p = leg.f(i / n);
      if (pts.length) {
        const q = pts[pts.length - 1];
        s += Math.hypot(p.x - q.x, p.z - q.z);
      }
      pts.push({ x: p.x, z: p.z, s, leg: li });
    }
    legEnd[li] = s;
  });
  return { pts, length: s, legs, legStart, legEnd };
}

// 道のり s の点（位置・向き・その区間のドミノの大きさ）
export function pointAt(path, s) {
  const pts = path.pts;
  const t = Math.max(0, Math.min(path.length, s));
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s <= t) lo = mid;
    else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const k = b.s > a.s ? (t - a.s) / (b.s - a.s) : 0;
  const tx = b.x - a.x, tz = b.z - a.z;
  const len = Math.hypot(tx, tz) || 1;
  return {
    x: a.x + tx * k, z: a.z + tz * k, tx: tx / len, tz: tz / len,
    yaw: Math.atan2(tx, tz), size: path.legs[b.leg].size, leg: b.leg, s: t,
  };
}

// (x, z) にいちばん近い道の点の道のり。sMin〜sMax の中だけを探す
export function projectOnPath(path, x, z, sMin = -Infinity, sMax = Infinity) {
  let best = null, bd = Infinity;
  for (const p of path.pts) {
    if (p.s < sMin || p.s > sMax) continue;
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { s: best.s, dist: Math.sqrt(bd) } : null;
}

// 区間の中の道のり。local が負なら区間の終わりから数える
function legS(path, li, local) {
  return local >= 0 ? path.legStart[li] + local : path.legEnd[li] + local;
}

// ---------- 台・本・ものさし ----------

// 本（見た目の小口の帯のために、下の面と上の面の高さも持っておく）
export const BOOKS = [
  { x: 1.3, z: Z1, hx: 3.1, hz: 1.1, bottom: 0, top: 0.25, color: '#56677e' },    // 手前の大きい本
  { x: 1.4, z: Z1, hx: 1.2, hz: 0.85, bottom: 0.25, top: 0.5, color: '#8f5a48' },  // その上の小さい本
  { x: 3.9, z: Z2, hx: 1.3, hz: 1.0, bottom: 0, top: 0.25, color: '#66744f' },     // まんなか右の本
  { x: -2.0, z: Z2, hx: 1.4, hz: 1.0, bottom: 0, top: 0.25, color: '#77597a' },    // まんなか左の本
];

// ものさし：左右の本に渡した橋（上面 0.31、幅 0.7）
export const RULER = { x: 1.0, z: Z2, hx: 2.0, hz: 0.35, bottom: 0.25, top: 0.31 };

// 坂（上り向きにドミノを並べるので、傾きは 0.25 / 4 ≈ 3.6°）
export const RAMPS = [
  { x0: -5.8, x1: -1.8, z: Z1, h0: 0, h1: 0.25, width: 2.2 },
  { x0: 4.4, x1: 8.4, z: Z1, h0: 0.25, h1: 0, width: 2.2 },
];

// 高さが急に変わるところ（ドミノがまたがないようによける）
const STEP_EDGES = [
  { x: 0.2, z: Z1, leg: 0 },    // 本の上の本へ上る
  { x: 2.6, z: Z1, leg: 0 },    // 本の上の本から下りる
  { x: 5.2, z: Z2, leg: 2 },    // 本へ上がる
  { x: 3.0, z: Z2, leg: 2 },    // ものさしに乗る
  { x: -1.0, z: Z2, leg: 2 },   // ものさしから下りる
  { x: -3.4, z: Z2, leg: 2 },   // 本から下りる
];

// とぎれ（自分でつなぐところ）。[区間, 区間の中の道のり]
const GAP_SPECS = [
  { name: 'まっすぐ', a: [0, 2.1], b: [0, 4.3] },
  { name: 'のぼり坂', a: [0, 6.3], b: [0, 8.7] },
  { name: '本の段', a: [0, 9.9], b: [0, 11.9] },
  { name: 'カーブ', a: [1, 0.9], b: [1, 6.0] },
  { name: 'ものさしの橋', a: [2, 6.0], b: [2, 8.8] },
  { name: '小から中へ', a: [6, -1.7], b: [7, 1.3] },
  { name: '中から大へ', a: [7, 2.9], b: [8, 2.1] },
];

const MARK_STEP = { s: 0.24, m: 0.3, l: 0.42 };   // 下書きの点線の間隔

export function buildCourse() {
  const path = buildPath(LEGS);
  const steps = STEP_EDGES.map((e) => projectOnPath(path, e.x, e.z, path.legStart[e.leg], path.legEnd[e.leg]).s);
  const gapRanges = GAP_SPECS.map((g) => ({ name: g.name, a: legS(path, ...g.a), b: legS(path, ...g.b) }));
  const inGap = (s) => gapRanges.some((g) => s > g.a && s < g.b);

  // 段差をまたぐ位置なら、近い方の端へずらす（下の段では壁にめり込まない、上の段では全部が乗る）
  const avoidSteps = (s, size, prevS) => {
    const t = SIZES[size].t;
    for (const e of steps) {
      const lo = e - t / 2 - 0.045, hi = e + t / 2 + 0.035;
      if (s > lo && s < hi) {
        const back = lo - prevS >= 0.4 * SIZES[size].h;
        return back && s - lo <= hi - s ? lo : hi;
      }
    }
    return s;
  };

  // 道にそってドミノの位置を決める（とぎれの中は置かない）
  const all = [];
  let s = 0, prevS = -Infinity, prevSize = null;
  while (s <= path.length + 1e-6) {
    let p = pointAt(path, s);
    let size = p.size;
    if (prevSize && size !== prevSize) {
      // 大きさが変わるところは、小さい方の高さに合わせて詰める（大きい方へも倒せるように）
      const b = path.legStart[p.leg];
      const want = prevS + MIXED * Math.min(SIZES[size].h, SIZES[prevSize].h);
      s = Math.max(b + 0.01, want);
      p = pointAt(path, s);
      size = p.size;
    }
    s = avoidSteps(s, size, prevS);
    if (s > path.length) break;
    p = pointAt(path, s);
    all.push({ s, x: p.x, z: p.z, yaw: p.yaw, size: p.size, gap: inGap(s) });
    prevS = s;
    prevSize = p.size;
    s += SPACING * SIZES[p.size].h;
  }

  const dominoes = [];
  all.forEach((d, i) => {
    if (d.gap) return;
    const start = i === 0;
    dominoes.push({
      x: d.x, z: d.z, yaw: d.yaw, size: d.size,
      color: start ? START_COLOR : STAGE_COLOR,
      meta: { stage: true, start, s: d.s },
    });
  });

  // とぎれごとに、両どなりの最初からあるドミノ・確かめる点・下書きの点線を用意する
  const gaps = gapRanges.map((g, gi) => {
    let prev = null, next = null;
    for (const d of all) {
      if (d.gap) continue;
      if (d.s <= g.a) prev = d;
      else if (d.s >= g.b && !next) next = d;
    }
    const s0 = prev ? prev.s : g.a, s1 = next ? next.s : g.b;
    const samples = [];
    for (let u = s0 + 0.2; u <= s1 - 0.2 + 1e-6; u += 0.3) {
      const p = pointAt(path, u);
      samples.push({ x: p.x, z: p.z, R: 0.5 * SIZES[p.size].h });
    }
    const dashes = [];
    let u = s0 + 0.32;
    while (u < s1 - 0.28) {
      const p = pointAt(path, u);
      dashes.push({ x: p.x, z: p.z, yaw: p.yaw, size: p.size, s: u });
      u += MARK_STEP[p.size];
    }
    const mid = pointAt(path, (s0 + s1) / 2);
    const count = all.filter((d) => d.gap && d.s > g.a && d.s < g.b).length;
    return { index: gi, name: g.name, a: g.a, b: g.b, s0, s1, samples, dashes, center: { x: mid.x, z: mid.z }, count, connected: false };
  });

  // 鐘：最後の大きいドミノの先。小さな座布団の上に立てる
  const last = all[all.length - 1];
  const end = pointAt(path, last.s);
  const bell = { x: last.x + end.tx * 0.92, z: last.z + end.tz * 0.92 };
  const CUSHION_TOP = 0.08;

  const solids = [
    ramp(RAMPS[0].x0, Z1, RAMPS[0].x1, Z1, RAMPS[0].h0, RAMPS[0].h1, RAMPS[0].width, '#b58a60'),
    ...BOOKS.map((b) => block(b.x, b.z, b.hx, b.hz, b.top, b.color, 0, 'book')),
    ramp(RAMPS[1].x0, Z1, RAMPS[1].x1, Z1, RAMPS[1].h0, RAMPS[1].h1, RAMPS[1].width, '#b58a60'),
    {
      type: 'box', name: 'ruler', color: '#d8c79f',
      x: RULER.x, y: (RULER.bottom + RULER.top) / 2, z: RULER.z,
      hx: RULER.hx, hy: (RULER.top - RULER.bottom) / 2, hz: RULER.hz, rot: { x: 0, y: 0, z: 0, w: 1 },
    },
    block(bell.x, bell.z, 0.45, 0.45, CUSHION_TOP, '#8a4f4a', 0, 'cushion'),
  ];
  const props = [
    {
      type: 'box', name: 'bell', x: bell.x, y: CUSHION_TOP + 0.5 + 0.002, z: bell.z,
      hx: 0.3, hy: 0.5, hz: 0.3, color: '#cfa95e', metal: true, density: 5, restitution: 0.05,
    },
  ];

  // 大きさの階段の目じるし（小・中・大）：奥の道の手前側に書く
  const sizeLabels = [6, 7, 8].map((li) => {
    const p = pointAt(path, path.legStart[li] + 0.25);
    return { text: SIZES[LEGS[li].size].label, x: p.x, z: p.z + 0.95 };
  });

  return {
    path, gaps, dominoes, solids, props, bell, sizeLabels,
    all,   // とぎれも含めた全部の置き場所（確認用）
    start: dominoes[0],
    total: all.length,
  };
}
