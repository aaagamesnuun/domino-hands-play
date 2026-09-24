// 試作「手触り＋なぞり置き」
// 途中まで作られたコースの、とぎれたところを自分でつないで鐘を鳴らす。
// 置く瞬間の気持ちよさ（下の面で変わる音・光）と、描くように並べる「なぞり置き」を味わう。
//
// なぞり置きの拍：押したまま動かしている間、次の1個を落とす距離を少しだけ伸び縮みさせて、
// 落ちる瞬間を BGM の16分（72BPM）に寄せる。手の速さがちょうどいい（中で 約 2.8〜3.4 単位/秒、
// ゆっくりなら8分）と、カタカタが拍にそろって木琴のような音が鳴る。そろった置き方が続くほど
// 音と光が明るくなる（数字は出さない）。急ぎすぎると音がこもって「つまる」。

import * as THREE from 'three';
import { startProto } from '../lib/protoapp.js';
import { SIZES, FEEL } from '../lib/protosim.js';
import { LAYOUT } from '../../src/config.js';
import { buildCourse, projectOnPath, BOOKS, RULER, RAMPS } from './course.js';
import { TouchSound, CHORD_TONES } from './touch-sound.js';
import { injectStyle, dressBooks, rulerFace, textDecal, Marks, Sparkles, bellGeometry, DoneBanner } from './deco.js';

// 置くドミノの4色（続けて同じ色にならない並び）
const PALETTE = ['#e9e0cf', '#9fae93', '#c7765a', '#7d93a8'];
const ORDER = [0, 1, 2, 3, 1, 0, 3, 2, 0, 2, 1, 3];

// ---------- 調整する数値 ----------
const BASE_SPACING = FEEL.traceSpacing;   // 拍に寄せないときのなぞりの間隔（0.6）
// 拍に寄せる幅。BGM の16分は 8分の裏が少し遅れる（スウィング）ので、同じ速さで動かしても
// 拍と拍の間は 0.28 / 0.20 / 0.20 / 0.15 秒と伸び縮みする。間隔を lo〜hi の中で伸び縮みさせて吸収し、
// はみ出す分は落ちる時刻を少しずらす（GROOVE.early〜late の中なら「そろった」とみなす。早く落ちた分は音を拍まで待たせる）。
// 中のドミノなら、16分にそろうのは手の速さ 約 2.8〜3.4 単位/秒（小は 0.62 倍、大は 1.6 倍）。
// それより遅いと8分や4分にそろう（明るくなるのはゆっくり）。あいだの速さは半分くらいしかそろわない。
const MAG = {
  ideal: 0.6,     // いちばん気持ちいい間隔（高さに対する比）
  lo: 0.44,       // 拍に寄せるとき、ここまで詰めてよい
  hi: 0.74,       // ここまで広げてよい（0.95 を超えると届かない。段を下りるところは 0.8 未満が安全）
  look: 8,        // 何ステップ先の拍まで候補にするか（16分 × 8 = 2拍）
  slow: 0.3,      // これより手が遅いときは寄せない
};
const GROOVE = {
  early: 0.065,   // 拍よりこれだけ（秒）早く落ちても「そろった」とみなす（音は拍まで待たせる）
  late: 0.035,    // 拍よりこれだけ遅れても「そろった」とみなす（音はすぐ鳴る）
  gain: 0.07,     // そろった置き方1回で明るさが上がる量（0..1）。16分でそろえ続けると約3秒でいちばん明るい
  loose: 0.09,    // 拍を外したときに下がる量
  jamKeep: 0.4,   // 急ぎすぎたときに残る割合
  rushSpeed: 4.6, // これより速い手は「急ぎすぎ」（中の場合。ドミノの高さに比例：小 2.85、大 7.4 単位/秒）
  idle: 0.45,     // 置かずにいると、この秒数から暗くなりはじめる
  fade: 0.45,     // 暗くなる速さ（1秒あたり）
};
const OVERVIEW = { target: [0, 0, -2.3], pitch: 1.12, dist: 25 };

const course = buildCourse();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const _ca = new THREE.Color(), _cb = new THREE.Color();
const mix = (a, b, k) => `#${_ca.set(a).lerp(_cb.set(b), clamp(k, 0, 1)).getHexString()}`;

// この試作の状態
const S = {
  tp: null, clock: null,
  seenPress: 0,
  last: null,          // 直前に置いたドミノ { x, z, size }
  lastStep: null,      // 直前にそろった拍（同じ拍に2個入れない）
  mag: null,           // なぞり置きを寄せようとしている拍 { step, time, base }
  level: 0, glow: 0, combo: 0, lastTraceAt: -1e9,
  stageIds: [],
  hitStage: new Set(),
  wave: null, camFocus: null, camHold: 0,
  done: false, doneAt: -1e9, bellAt: -1e9, bellGlow: 0,
  connected: 0, allConnected: false,
  coverTimer: 0, pulseTimer: 0,
  delayed: [],
  pendingGlance: null, glanceBlock: false,
  bellPiece: null, bellMesh: null,
  handLight: null, bellLight: null, marks: null, sparkles: null, banner: null,
};

// 組み合わせの基準の高さ：同じ大きさならその高さ、ちがうなら小さい方の 1.1 倍（大きさの変わり目は詰める）
function pairBase(prevSize, size) {
  const h = SIZES[size].h;
  if (!prevSize || prevSize === size) return h;
  return 1.1 * Math.min(h, SIZES[prevSize].h);
}

// 置いた場所の下の面
function surfaceAt(x, y, z) {
  if (y > RULER.top - 0.03 && Math.abs(z - RULER.z) <= RULER.hz + 0.02 && Math.abs(x - RULER.x) <= RULER.hx + 0.02) return 'ruler';
  for (const r of RAMPS) {
    if (x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && Math.abs(z - r.z) <= r.width / 2) return 'wood';
  }
  if (y > 0.05) return 'book';
  return 'felt';
}

function setSticky(ctx, lines) {
  ctx.view.room.sticky.setLines(lines);
}

function refreshSticky(ctx) {
  if (S.done) return;
  if (S.allConnected) setSticky(ctx, ['ぜんぶ つながった', 'はじめの1枚を', '指で押そう', '（Space）']);
  else setSticky(ctx, ['とぎれたところを', 'つないで', '鐘を ならそう', `のこり ${course.gaps.length - S.connected}か所`]);
}

// カメラで別の場所を見る。見ている間は手がカーソルについてこないので、
// なぞっている最中なら、ボタンを離すまで待つ（終わった瞬間に手が跳んで列を置いてしまわないように）
function glance(ctx, to, hold, travel = 1.0) {
  S.pendingGlance = { to, hold, travel };
  flushGlance(ctx);
}
function flushGlance(ctx) {
  const g = S.pendingGlance;
  if (!g || ctx.input.primary) return;
  S.pendingGlance = null;
  ctx.view.rig.glance(g.to, g.hold, g.travel);
}
function overview(ctx, hold = 2.4) {
  glance(ctx, OVERVIEW, hold, 1.0);
}

// ---------- なぞり置きを拍に寄せる ----------

function updateMagnet(ctx) {
  const { sim, state, input, view } = ctx;
  const h = sim.hand;
  // よそ見の間に押したままだと、戻った瞬間に手が跳んで列ができてしまう。離すまでなぞりを止める
  if (view.rig.glancing && input.primary) S.glanceBlock = true;
  if (!input.primary) S.glanceBlock = false;
  if (S.glanceBlock) {
    FEEL.traceSpacing = 99;
    S.mag = null;
    return;
  }
  const tracing = state.trace && input.primary && !input.poke && h.traceFrom;
  if (!tracing) {
    FEEL.traceSpacing = BASE_SPACING;
    S.mag = null;
    return;
  }
  const H = SIZES[state.size].h;
  const base = pairBase(S.last?.size, state.size);
  const lo = MAG.lo * base, hi = MAG.hi * base, ideal = MAG.ideal * base;
  const d = Math.hypot(h.x - h.traceFrom.x, h.z - h.traceFrom.z);
  const v = Math.hypot(h.vx, h.vz);
  if (v < MAG.slow) {
    FEEL.traceSpacing = ideal / H;
    S.mag = null;
    return;
  }
  const clock = S.clock;
  const now = clock.now();
  // 決めた拍がまだ先で、そこまでの距離が許せる範囲なら、それを保つ（毎回選び直すとぶれる）
  const m = S.mag;
  if (m && m.base === base && m.time > now - 0.004) {
    const D = d + v * Math.max(0, m.time - now);
    if (D > lo - 0.05 * base && D < hi + 0.06 * base) {
      FEEL.traceSpacing = clamp(D, lo, hi) / H;
      return;
    }
  }
  // 次の拍の候補から、その瞬間の間隔がいちばん「ちょうどいい」ものを選ぶ
  let best = null;
  let i = clock.firstStepAtOrAfter(now + 0.01);
  if (S.lastStep != null && i <= S.lastStep) i = S.lastStep + 1;
  for (let k = 0; k < MAG.look; k++, i++) {
    const T = clock.stepTime(i);
    const D = d + v * (T - now);
    const score = Math.abs(D - ideal) + 3 * Math.max(0, D - hi, lo - D);
    if (!best || score < best.score) best = { step: i, time: T, D, score, base };
    if (D > hi * 1.6) break;
  }
  S.mag = best;
  FEEL.traceSpacing = clamp(best.D, lo, hi) / H;
}

// なぞっている間、次に落ちる位置がめり込む場所（段の壁の手前、立っているドミノの上）なら、その回は落とさない。
// なぞったまま本の段や、もうあるドミノの上を通っても事故にならない
function avoidBlocked(ctx, dt) {
  const { sim, state, input } = ctx;
  const h = sim.hand;
  if (!(state.trace && input.primary && !input.poke && h.traceFrom) || FEEL.traceSpacing > 50) return;
  const thr = FEEL.traceSpacing * SIZES[state.size].h;
  const fx = h.traceFrom.x, fz = h.traceFrom.z;
  const d = Math.hypot(h.x - fx, h.z - fz);
  const step = Math.max(dt, 1 / 120);
  let px = h.x + h.vx / 120, pz = h.z + h.vz / 120;   // もう届いていれば、次のティックで落ちる
  if (d < thr) {
    const ex = h.x + h.vx * step, ez = h.z + h.vz * step;
    const de = Math.hypot(ex - fx, ez - fz);
    if (de < thr) return;                                  // このフレームでは落ちない
    const f = (thr - d) / Math.max(1e-6, de - d);          // しきいを越える位置
    px = h.x + (ex - h.x) * f;
    pz = h.z + (ez - h.z) * f;
  }
  const c = sim.checkPlacement(px, pz, Math.atan2(px - fx, pz - fz), state.size);
  if (c.status === 'blocked' || c.status === 'outside') FEEL.traceSpacing = 99;
}

// ---------- 置いたとき ----------

function nearestOther(sim, id, x, z, radius) {
  let best = null, bd = radius;
  for (const p of sim.pieces) {
    if (p.kind !== 'domino' || p.id === id || p.state !== 'standing') continue;
    const t = p.body.translation();
    const d = Math.hypot(t.x - x, t.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function onPlace(e, ctx) {
  const { sim, view, state, input, feel } = ctx;
  state.lastYaw = e.yaw;
  state.yawOffset = 0;
  const clock = S.clock;
  const now = clock.now();
  const isClick = input.pressSeq !== S.seenPress;   // 押した瞬間の1個目
  S.seenPress = input.pressSeq;
  const tracing = !isClick && state.trace;
  const prev = S.last;
  const dist = prev ? Math.hypot(e.x - prev.x, e.z - prev.z) : null;
  const base = pairBase(prev?.size, e.size);
  const surface = surfaceAt(e.x, e.y, e.z);
  const n = sim.byId.get(e.id)?.n;
  const H = SIZES[e.size].h;

  if (!tracing) {
    // 1つずつ置く：下の面の音。ちょうどいい間隔なら「チッ」と光、となりのドミノも少し応える
    S.tp.knock(e.size, surface, null, { gain: 0.55 });
    if (e.status === 'nice') {
      feel.nice();
      view.flash(e.id, '#fff2c8', 0.5);
      view.ring(e.x, e.y, e.z, { color: '#ffd68a', r0: 0.2, r1: 0.9, life: 0.55, a: 0.9, n });
      const nb = nearestOther(sim, e.id, e.x, e.z, H * 1.6);
      if (nb) view.flash(nb.id, '#f6e4c0', 0.4);
    } else {
      view.ring(e.x, e.y, e.z, { color: '#fff4e0', r0: 0.1, r1: 0.5, life: 0.35, a: 0.35, n });
    }
  } else {
    const g = clock.nearest(now - 0.006);   // 置いたのはこのフレームの少し前
    const onGrid = g.off >= -GROOVE.early && g.off <= GROOVE.late && g.step !== S.lastStep;
    const spacingOk = dist != null && dist >= 0.38 * base && dist <= 0.84 * base;
    const rushing = e.speed > GROOVE.rushSpeed * H || e.status === 'far' || (dist != null && dist > 0.9 * base);
    if (rushing) {
      // 急ぎすぎ：音がつまって、明るさが引く
      S.level *= GROOVE.jamKeep;
      S.combo = 0;
      S.tp.jam(e.size, null);
      view.ring(e.x, e.y, e.z, { color: '#b9ad9c', r0: 0.1, r1: 0.4, life: 0.3, a: 0.25, n });
    } else if (onGrid && spacingOk) {
      // 拍にそろった
      S.level = Math.min(1, S.level + GROOVE.gain);
      S.combo++;
      S.lastStep = g.step;
      const lv = S.level;
      const t = clock.live ? g.time : null;
      S.tp.knock(e.size, surface, t, { gain: 0.42, bright: lv });
      const tones = CHORD_TONES[clock.chordIndex(g.step)];
      const pattern = [0, 2, 1, 3, 2, 4, 3, 1];
      const idx = Math.min(tones.length - 1, Math.floor(lv * 4) + pattern[S.combo % pattern.length]);
      S.tp.tock(tones[idx], t, lv, g.step % 4 === 0);
      const col = mix('#fff2c8', '#ffc56a', lv);
      view.flash(e.id, col, 0.35 + 0.8 * lv);
      view.ring(e.x, e.y, e.z, { color: mix('#fff4e0', '#ffc978', lv), r0: 0.15, r1: 0.55 + 0.9 * lv, life: 0.4 + 0.4 * lv, a: 0.35 + 0.5 * lv, n });
      if (lv > 0.35) S.sparkles.spawn(e.x, e.y + H * 0.9, e.z, col, 1 + Math.floor(lv * 3));
    } else {
      // 拍から外れた：ふつうのカタッ
      S.level = Math.max(0, S.level - GROOVE.loose);
      S.combo = Math.max(0, S.combo - 1);
      if (g.off >= -GROOVE.early && g.off <= GROOVE.late) S.lastStep = g.step;
      S.tp.knock(e.size, surface, null, { gain: 0.42 });
      if (e.status === 'nice') view.flash(e.id, '#f7ecd6', 0.3);
      view.ring(e.x, e.y, e.z, { color: '#fff4e0', r0: 0.1, r1: 0.45, life: 0.3, a: 0.3, n });
    }
    S.lastTraceAt = performance.now();
  }
  S.last = { x: e.x, z: e.z, size: e.size };
  S.mag = null;
}

// ---------- 倒れる・鐘・連鎖の終わり ----------

function onHit(e, ctx) {
  if (e.meta?.stage) S.hitStage.add(e.id);
  S.wave = { x: e.x, z: e.z, t: performance.now() };
  ctx.view.flash(e.id, '#ffe3b3', 0.3);
}

function celebrate(ctx) {
  S.done = true;
  S.doneAt = performance.now();
  S.banner.show('とぎれが ぜんぶ つながって、鐘が なった', 'R で ならべなおして もういちど');
  S.tp.fanfare();
  const b = course.bell;
  S.sparkles.spawn(b.x, 1.2, b.z, '#ffd58a', 26, { spread: 0.5, up: 0.9, life: 2.4 });
  setSticky(ctx, ['できた！', '鐘が なった', 'R で もういちど']);
  // 少し待ってから、倒れたコース全体を見わたす
  setTimeout(() => overview(ctx, 3.2), 1400);
}

function onPropHit(e, ctx) {
  if (e.name !== 'bell') return false;
  const nowMs = performance.now();
  if (nowMs - S.bellAt < 1500) return true;   // 続けて当たったときは鳴らし直さない
  S.bellAt = nowMs;
  ctx.sound.bellRing();
  S.bellGlow = 1;
  // 最初からあるドミノの 85% 以上がこの回に倒れていれば、コースを通って鳴った
  const frac = S.stageIds.length ? S.hitStage.size / S.stageIds.length : 0;
  if (!S.done && frac >= 0.85) celebrate(ctx);
  else ctx.floatLabel('ちーん', e.x, 1.7, e.z, 'f-soft', 1600);
  return true;
}

function onChainEnd(e, ctx) {
  ctx.sound.chainEnd(e.longest);
  ctx.floatLabel(`${e.longest}れん`, e.x, 1.6, e.z, e.longest >= 20 ? 'big' : '');
  if (S.done && performance.now() - S.doneAt < 12000) {
    setSticky(ctx, ['できた！', `${e.longest}れん`, 'R で もういちど']);
  } else if (e.longest >= 3) {
    // 途中で止まった場所を知らせる（直して、R でもう一度）
    ctx.floatLabel('ここで とまった', e.x, 0.8, e.z, 'f-note', 3000);
  }
}

function onReset(ctx) {
  S.hitStage.clear();
  S.done = false;
  S.wave = null;
  S.bellAt = -1e9;
  S.banner.hide();
  refreshSticky(ctx);
}

// 最初からあるドミノは片付けられない（右クリックで消えたら、元の場所に立て直す）
function restoreStage(ctx) {
  const { sim } = ctx;
  course.dominoes.forEach((d, i) => {
    if (sim.byId.has(S.stageIds[i])) return;
    const p = sim.placeAt(d.x, d.z, d.yaw, d.size, d.color, { byStage: true, meta: d.meta });
    if (p) {
      S.stageIds[i] = p.id;
      ctx.floatLabel('もとからの ドミノ', d.x, 1.3, d.z, 'f-note', 1600);
    }
  });
}

// ---------- とぎれがつながったか（置いた場所で見る。倒れても数える） ----------

function updateCoverage(ctx, first = false) {
  const { sim } = ctx;
  // [x, z, 高さ, 足もとの高さ, ...]（ものさしから落ちて床に立ったものは数えないよう、足もとの高さも見る）
  const doms = [];
  for (const p of sim.pieces) {
    if (p.kind !== 'domino') continue;
    const q = p.home ? p.home.pos : p.body.translation();
    const hh = SIZES[p.size].h;
    doms.push(q.x, q.z, hh, q.y - hh / 2);
  }
  S.marks.cover(doms);
  const near = (x, y, z, R) => {
    for (let i = 0; i < doms.length; i += 4) {
      const dx = doms[i] - x, dz = doms[i + 1] - z;
      if (dx * dx + dz * dz <= R * R && Math.abs(doms[i + 3] - y) < 0.12) return true;
    }
    return false;
  };
  let n = 0;
  for (const g of course.gaps) {
    const ok = g.samples.every((sp) => near(sp.x, sp.y, sp.z, sp.R));
    if (ok && !g.connected && !first) onGapConnected(ctx, g);
    g.connected = ok;
    if (ok) n++;
  }
  const all = n === course.gaps.length;
  if (all && !S.allConnected && !first) {
    S.tp.allConnected();
    const st = course.start;
    ctx.floatLabel('ぜんぶ つながった', st.x + 1.2, 1.5, st.z, 'f-soft', 2600);
    glance(ctx, { target: [st.x + 2.2, 0, st.z - 0.4], pitch: 0.95, dist: 11 }, 1.4, 0.9);
  }
  S.allConnected = all;
  S.connected = n;
  refreshSticky(ctx);
}

function onGapConnected(ctx, g) {
  const { sim } = ctx;
  S.tp.connected();
  ctx.floatLabel('つながった', g.center.x, 1.4, g.center.z, 'f-soft', 1800);
  // とぎれの中の自分のドミノを、道の順に光らせていく
  const list = [];
  for (const p of sim.pieces) {
    if (p.kind !== 'domino' || p.byStage || !p.home) continue;
    const q = p.home.pos;
    const pr = projectOnPath(course.path, q.x, q.z, g.s0 - 0.5, g.s1 + 0.5);
    if (pr && pr.dist < 0.6 * SIZES[p.size].h) list.push({ id: p.id, s: pr.s });
  }
  list.sort((a, b) => a.s - b.s);
  const t0 = performance.now();
  list.forEach((it, i) => S.delayed.push({ at: t0 + i * 55, id: it.id, color: '#ffe0a0', life: 0.6 }));
  S.sparkles.spawn(g.center.x, 0.9, g.center.z, '#ffe0a0', 8, { spread: 0.6, up: 0.6, life: 1.8 });
}

// ---------- 毎フレーム ----------

function dressBell(ctx) {
  if (S.bellMesh) return;
  S.bellPiece ||= ctx.sim.pieces.find((p) => p.kind === 'prop' && p.name === 'bell');
  if (!S.bellPiece) return;
  const m = ctx.view.propMeshes.get(S.bellPiece.id);
  if (!m) return;
  m.geometry.dispose();
  m.geometry = bellGeometry();
  const mat = m.material;
  mat.side = THREE.DoubleSide;
  mat.metalness = 0.55;
  mat.roughness = 0.32;
  mat.emissive.set('#7a5418');
  mat.emissiveIntensity = 0.1;
  mat.needsUpdate = true;
  S.bellMesh = m;
}

// 連鎖が走っている間は、カメラが波の先を追う
function followWave(dt, ctx, nowMs) {
  const rig = ctx.view.rig;
  const w = S.wave;
  const active = w && nowMs - w.t < 1300 && !ctx.input.primary;
  S.camHold = active ? Math.min(1, S.camHold + dt * 2) : Math.max(0, S.camHold - dt * 1.5);
  if (S.camHold <= 0 || !w) {
    S.camFocus = null;
    return;
  }
  S.camFocus ||= { x: rig.target.x, z: rig.target.z };
  const k = 1 - Math.exp(-3.5 * dt);
  S.camFocus.x += (w.x - S.camFocus.x) * k;
  S.camFocus.z += (w.z - S.camFocus.z) * k;
  const m = S.camHold * (1 - Math.exp(-8 * dt));
  rig.target.x += (S.camFocus.x - rig.target.x) * m;
  rig.target.z += (S.camFocus.z - rig.target.z) * m;
}

function onFrame(dt, ctx) {
  const { sim, view, input } = ctx;
  const nowMs = performance.now();

  updateMagnet(ctx);
  avoidBlocked(ctx, dt);
  if (!input.primary) S.lastStep = null;
  flushGlance(ctx);

  // 連続の明るさ：しばらく置かないと少しずつ落ちる。見た目はなめらかに追う
  if (nowMs - S.lastTraceAt > GROOVE.idle * 1000) S.level = Math.max(0, S.level - GROOVE.fade * dt);
  S.glow += (S.level - S.glow) * (1 - Math.exp(-6 * dt));
  const h = sim.hand;
  S.handLight.position.set(h.x, h.groundY + 1.3, h.z);
  S.handLight.intensity = 3.5 * Math.pow(S.glow, 1.3);

  S.coverTimer -= dt;
  if (S.coverTimer <= 0) {
    S.coverTimer = 0.2;
    updateCoverage(ctx);
  }
  S.marks.update(dt);

  dressBell(ctx);
  S.bellGlow = Math.max(0, S.bellGlow - dt * 0.5);
  if (S.bellMesh) S.bellMesh.material.emissiveIntensity = 0.1 + 1.3 * S.bellGlow;
  S.bellLight.intensity = 4 * S.bellGlow;

  followWave(dt, ctx, nowMs);

  // 全部つながったら、はじめの1枚をときどき光らせて知らせる
  S.pulseTimer -= dt;
  if (S.allConnected && !S.done && sim.chains.size === 0 && S.pulseTimer <= 0) {
    S.pulseTimer = 1.8;
    const st = course.start;
    view.ring(st.x, 0, st.z, { color: '#ffd68a', r0: 0.25, r1: 1.2, life: 1.3, a: 0.55 });
  }

  for (let i = S.delayed.length - 1; i >= 0; i--) {
    const d = S.delayed[i];
    if (d.at > nowMs) continue;
    if (sim.byId.has(d.id)) view.flash(d.id, d.color, d.life);
    S.delayed.splice(i, 1);
  }
  S.sparkles.update(dt);
}

// ---------- 起動 ----------

function setup(ctx) {
  const { sim, view, sound, state } = ctx;
  injectStyle();
  S.tp = new TouchSound(sound);
  S.clock = S.tp.clock;
  S.seenPress = ctx.input.pressSeq;
  S.stageIds = sim.pieces.filter((p) => p.kind === 'domino' && p.byStage).map((p) => p.id);

  // カメラは近め。手の方へ大きめに寄る
  view.follow = 0.62;
  const st = course.start;
  state.target = { x: st.x + 2.4, z: st.z + 0.6 };
  sim.hand.x = state.target.x;
  sim.hand.z = state.target.z;
  view.rig.target.set(-5.2, 0, 0.9);

  // 付箋をカメラに入る手前へ
  view.room.sticky.group.position.set(-5.85, LAYOUT.sticky.height, 4.9);

  // 飾り：本の小口、ものさしの目盛り、盆に書いた文字
  dressBooks(view.scene, BOOKS);
  rulerFace(view.scene, RULER);
  const here = textDecal('ここから →', { w: 2.2, h: 0.6, px: 84 });
  here.position.set(st.x + 1.0, 0.006, st.z + 1.0);
  view.scene.add(here);
  for (const L of course.sizeLabels) {
    const m = textDecal(L.text, { w: 0.7, h: 0.7, px: 120, tilt: 0.05 });
    m.position.set(L.x, 0.006, L.z);
    view.scene.add(m);
  }

  S.marks = new Marks(view.scene, sim, course.gaps);
  for (const g of course.gaps) for (const sp of g.samples) sp.y = sim.groundAt(sp.x, sp.z)?.y ?? 0;
  S.sparkles = new Sparkles(view.scene);
  // 光の数が途中で変わるとシェーダーを作り直すので、最初から置いておく（明るさ 0）
  S.handLight = new THREE.PointLight('#ffcf8a', 0, 7, 2);
  S.bellLight = new THREE.PointLight('#ffd89a', 0, 6, 2);
  S.bellLight.position.set(course.bell.x, 1.8, course.bell.z);
  view.scene.add(S.handLight, S.bellLight);
  S.banner = new DoneBanner();

  // はじめる → コース全体を見わたしてから手元へ
  document.getElementById('p-start')?.addEventListener('click', () => overview(ctx, 2.2));
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.code === 'KeyV') overview(ctx, 2.2);
  });

  updateCoverage(ctx, true);
  refreshSticky(ctx);
}

startProto({
  title: '手触り＋なぞり置き',
  desc: 'とぎれた道を なぞって つなぎ、鐘を ならそう。ちょうどいい速さで なぞると 拍にそろう',
  trace: true,
  layers: 3,
  camera: { dist: 12, pitch: 0.98 },
  colorFor: (size, n) => PALETTE[ORDER[n % ORDER.length]],
  stage: { solids: course.solids, props: course.props, dominoes: course.dominoes },
  keys: [
    ['V', 'コース全体を見る'],
    ['M', '音を消す'],
  ],
  setup,
  onEvent(e, ctx) {
    switch (e.type) {
      case 'place': onPlace(e, ctx); return true;
      case 'hit': onHit(e, ctx); return false;
      case 'propHit': return onPropHit(e, ctx);
      case 'chainEnd': onChainEnd(e, ctx); return true;
      case 'reset': onReset(ctx); return false;
      case 'pick': restoreStage(ctx); return false;
      default: return false;
    }
  },
  onFrame,
});

// デバッグ用（コンソールから見られるように）
window.__feel = { S, course, MAG, GROOVE };
