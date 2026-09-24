// 試作「ドミノが音符」：置くことが作曲、倒すことが演奏。
// ・盆の床に7本の帯（手前が低い音、奥が高い音。ド レ ミ ソ ラ ド レ）。置いた帯の音が、次の16分にそろって鳴る
// ・倒れるときにも、そのドミノの音が鳴る。間隔が広いとゆっくり、狭いと速く鳴る（間隔がリズム）
// ・大きさで音色と高さ：小＝ベル（高い）、中＝木琴、大＝ベース（低い）
// ・X / Shift で「つなぎ」（音の鳴らない白木のドミノ）。休符と、遠い音への跳躍に使う
// ・最初から、きらきら星の冒頭「ドドソソ」が並べてある。続き（ララソー）を並べて押すと、曲になる
// ・連鎖が終わったら P で「おさらい」：倒れた順の音を、拍にそろえてもう一度小さく鳴らす

import * as THREE from 'three';
import { startProto } from '../lib/protoapp.js';
import { ramp, block, SIZES } from '../lib/protosim.js';
import { LAYOUT } from '../../src/config.js';
import {
  LANE_COUNT, LANE_W, LANE_NAME, LANE_COLOR, SIZE_VOICE, WOOD,
  laneOf, laneCenter, midiFor, inTray, buildSample, quantizeTake, hasTwinkle, clamp,
} from './score.js';
import { MusicSynth } from './synth.js';

const TR = LAYOUT.tray;

// ---------- 見た目と手触りの数値（調整するならここ） ----------
const LOOK = {
  bandBase: 0.2,        // 帯のふだんの濃さ
  bandHover: 0.13,      // 手の下の帯が濃くなる分
  bandPulse: 0.42,      // 音が鳴ったときに光る分
  pulseDecay: 3.5,      // 光が消える速さ（1/秒）
  pluckGain: 1,         // 帯をなぞる音の大きさ（0 で消える。V でも切り替え）
  hitVel: 0.8,          // 倒れるときの音の強さ
  placeVel: 0.72,       // 置いたときの音の強さ（ちょうどいい間隔なら少し強く、キラッと）
  replayVel: 0.55,      // おさらいの音の強さ（小さめ）
};

// ---------- ステージ ----------
// 左：帯を横切って奥へ上る坂と、その上の台。台の奥に鐘。坂に並べて倒すと、音階を上っていく
const RAMP = { x: -9.6, z0: 1.6, z1: -4.4, top: 0.375, width: 2.4 };   // 走り 6 で 0.375 上がる＝約3.6°（坂の上り向きに並べて立つ）
const solids = [
  ramp(RAMP.x, RAMP.z0, RAMP.x, RAMP.z1, 0, RAMP.top, RAMP.width, '#a47d58'),
  block(RAMP.x, -6.1, 1.3, 1.7, RAMP.top, '#8a6446', 0, 'stage'),
  // 右奥：本（上にも置ける。高さ 0.18 の段）
  block(4.6, -6.3, 1.9, 1.25, 0.18, '#6d5a7a', 0.1, 'book'),
];
const props = [
  { type: 'box', name: 'bell', x: RAMP.x, y: RAMP.top + 0.505, z: -7.2, hx: 0.3, hy: 0.5, hz: 0.3, color: '#c9a55b', metal: true, density: 2 },
];
const sample = buildSample();

// ---------- この試作の状態 ----------
const M = {
  synth: null,
  silentToggle: false,  // X で切り替え
  shift: false,         // Shift を押している間は反対になる
  hoverOn: true,        // 帯をなぞる音（V）
  bands: [],
  hoverVal: new Float32Array(LANE_COUNT),
  pulse: new Float32Array(LANE_COUNT),
  hoverLane: -1,
  lastPluck: 0,
  visuals: [],          // 音に合わせて光らせる予定 { perf, lane, id, color, replay }
  placeStep: -2,        // 置いたときの音の重なりよけ（同じ16分に同じ音は1回）
  placeNotes: new Set(),
  chains: new Map(),    // 連鎖の番号 → 倒れた順の記録
  take: null,           // いちばん最近の連鎖の音（おさらい用）
  replay: null,
  sampleTouched: false,
  twinkleDone: false,
  ui: {},
  lastHud: '',
};

const silentNow = () => M.silentToggle !== M.shift;
const perfNow = () => performance.now() / 1000;
const WHITE = new THREE.Color('#ffffff');
const _c = new THREE.Color();

function lighten(hex, k) {
  _c.set(hex).lerp(WHITE, k);
  return `#${_c.getHexString()}`;
}

// ---------- 床の帯 ----------

function smooth(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// 帯の縁をぼかすための、白いアルファの縦グラデーション
function bandTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height);
  for (let j = 0; j < c.height; j++) {
    const v = (j + 0.5) / c.height;
    const edge = Math.min(v, 1 - v) * 2;               // 縁で 0、真ん中で 1
    const a = smooth(0.02, 0.32, edge) * 0.85 + 0.15 * smooth(0.0, 0.08, edge);
    for (let i = 0; i < c.width; i++) {
      const k = (j * c.width + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function overlayMaterial(opts) {
  return new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    ...opts,
  });
}

function buildBands(scene) {
  const tex = bandTexture();
  const w = TR.x1 - TR.x0;
  for (let i = 0; i < LANE_COUNT; i++) {
    const geo = new THREE.PlaneGeometry(w - 0.1, LANE_W * 0.98);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, overlayMaterial({ color: LANE_COLOR[i], map: tex, opacity: LOOK.bandBase }));
    m.position.set((TR.x0 + TR.x1) / 2, 0.006, laneCenter(i));
    m.renderOrder = -2;   // 見本・波紋より先に描く（床に塗った色なので）
    scene.add(m);
    M.bands.push(m);
  }
}

// 床に書いた文字（音名・坂の書き込み）。フォントが届いたら書き直す
const floorTexts = [];
function floorText(scene, text, x, z, w, h, color, { size = 0.72, opacity = 0.8 } = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(64, Math.round(256 * (w / h)));
  c.height = 256;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = () => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.font = `400 ${Math.round(c.height * size)}px Yomogi, "Hiragino Maru Gothic ProN", "Zen Kaku Gothic New", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, c.width / 2, c.height / 2 + 4, c.width - 16);
    tex.needsUpdate = true;
  };
  draw();
  floorTexts.push(draw);
  const geo = new THREE.PlaneGeometry(w, h);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, overlayMaterial({ map: tex, opacity }));
  m.position.set(x, 0.008, z);
  m.renderOrder = -1;
  scene.add(m);
  return m;
}

function buildLabels(scene) {
  for (let i = 0; i < LANE_COUNT; i++) {
    const col = lighten(LANE_COLOR[i], 0.25);
    floorText(scene, LANE_NAME[i], TR.x0 + 0.55, laneCenter(i), 0.8, 0.8, col);
    floorText(scene, LANE_NAME[i], TR.x1 - 0.55, laneCenter(i), 0.8, 0.8, col);
  }
  floorText(scene, 'のぼると おとも あがる', RAMP.x + 0.4, 2.75, 3.4, 0.62, '#f4efe4', { size: 0.62, opacity: 0.55 });
  try {
    if (document.fonts && document.fonts.load) {
      document.fonts.load('64px Yomogi', 'ドレミソラのぼるとおもあが').then(() => {
        for (const d of floorTexts) d();
      }).catch(() => {});
    }
  } catch (_) {
    // 無視（そのままの字で描いてある）
  }
}

// 坂・台・本の上面にも、帯の色を写す（どこに置いても、音は奥行きで決まる）
function buildDecals(scene, defs) {
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const rgb = LANE_COLOR.map((h) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  for (const s of defs) {
    const W = 64;
    const H = clamp(Math.round((64 * s.hz) / s.hx), 8, 256);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    const r = s.rot || { x: 0, y: 0, z: 0, w: 1 };
    q.set(r.x, r.y, r.z, r.w);
    for (let j = 0; j < H; j++) {
      // 平面を寝かせると、画像の上の行が奥（ローカル -z）になる
      const lz = -s.hz + ((j + 0.5) / H) * 2 * s.hz;
      for (let i = 0; i < W; i++) {
        const lx = -s.hx + ((i + 0.5) / W) * 2 * s.hx;
        v.set(lx, s.hy, lz).applyQuaternion(q);
        const wx = s.x + v.x, wz = s.z + v.z;
        const k = (j * W + i) * 4;
        if (!inTray(wx, wz)) { img.data[k + 3] = 0; continue; }
        const f = (TR.z1 - wz) / LANE_W;
        const lane = clamp(Math.floor(f), 0, LANE_COUNT - 1);
        const fr = f - Math.floor(f);
        const edge = Math.min(fr, 1 - fr) * 2;
        const [cr, cg, cb] = rgb[lane];
        img.data[k] = cr;
        img.data[k + 1] = cg;
        img.data[k + 2] = cb;
        img.data[k + 3] = Math.round(255 * 0.34 * smooth(0.02, 0.3, edge));
      }
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(2 * s.hx, 2 * s.hz);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, overlayMaterial({ map: tex }));
    mesh.position.y = s.hy + 0.004;
    mesh.renderOrder = -2;
    const group = new THREE.Group();
    group.position.set(s.x, s.y, s.z);
    group.quaternion.copy(q);
    group.add(mesh);
    scene.add(group);
  }
}

// ---------- 画面の文字とボタン ----------

function injectStyle() {
  const noteColors = LANE_COLOR.map((c, i) => `.p-float.m-n${i} { color: ${lighten(c, 0.2)}; }`).join('\n');
  const st = document.createElement('style');
  st.textContent = `
.m-hud { position: fixed; z-index: 30; left: 16px; bottom: calc(46px + env(safe-area-inset-bottom, 0px)); pointer-events: none;
  font-size: 17px; color: var(--paper); text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
.m-hud .m-now { font-size: 22px; margin-right: 0.4em; }
.m-hud .m-sub { color: var(--ink-soft); }
.m-replay { position: fixed; z-index: 30; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%);
  pointer-events: auto; cursor: pointer; font: inherit; font-size: 17px; color: var(--paper);
  background: rgba(28, 22, 18, 0.72); border: 1px solid rgba(255, 207, 138, 0.28); border-radius: 999px; padding: 6px 18px;
  transition: opacity 0.4s, box-shadow 0.6s, border-color 0.6s; }
.m-replay:disabled { opacity: 0.35; cursor: default; }
.m-replay.m-ready { border-color: var(--lamp); box-shadow: 0 0 16px rgba(255, 207, 138, 0.35); }
.m-replay:focus-visible { outline: 2px solid var(--lamp); outline-offset: 3px; }
.m-hint { position: fixed; left: 0; top: 0; z-index: 30; pointer-events: none; text-align: center; white-space: nowrap;
  font-size: 18px; color: var(--lamp); text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8); transition: opacity 0.6s; }
.m-hint small { display: block; font-size: 14px; color: var(--ink-soft); }
.p-float.m-note { font-size: 24px; }
.p-float.m-note.m-s { font-size: 19px; }
.p-float.m-note.m-l { font-size: 32px; }
${noteColors}
@media (max-width: 640px) {
  .m-hud { font-size: 15px; }
  .m-replay { font-size: 15px; left: auto; right: 16px; transform: none; }
}
`;
  document.head.appendChild(st);
}

function buildUI(ctx) {
  injectStyle();
  const hud = document.createElement('div');
  hud.className = 'm-hud';
  hud.innerHTML = '<span class="m-now"></span><span class="m-sub"></span>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'm-replay';
  btn.disabled = true;
  btn.textContent = '♪ おさらい（P）';
  btn.addEventListener('click', () => {
    toggleReplay(ctx);
    ctx.view.renderer.domElement.focus();
  });
  const hint = document.createElement('div');
  hint.className = 'm-hint';
  hint.innerHTML = 'おてほんを おしてみよう<small>Space（ながおし）で ゆびを おろして、→ へ</small>';
  hint.style.opacity = '0';
  document.body.append(hud, btn, hint);
  M.ui = { hud, now: hud.querySelector('.m-now'), sub: hud.querySelector('.m-sub'), btn, hint };
}

function setReplayButton() {
  const { btn } = M.ui;
  if (!btn) return;
  if (M.replay) {
    btn.disabled = false;
    btn.textContent = '■ とめる（P）';
    btn.classList.remove('m-ready');
  } else if (M.take) {
    btn.disabled = false;
    btn.textContent = `♪ おさらい（P）・${M.take.count}おん`;
    btn.classList.add('m-ready');
  } else {
    btn.disabled = true;
    btn.textContent = '♪ おさらい（P）';
    btn.classList.remove('m-ready');
  }
}

// ---------- 出来事 ----------

function onPlace(e, ctx) {
  const { sim, view, feel, state } = ctx;
  const p = sim.byId.get(e.id);
  const silent = silentNow();
  const lane = laneOf(e.z);
  const midi = midiFor(lane, e.size);
  const col = silent ? WOOD : LANE_COLOR[lane];
  if (p) {
    p.color = col;
    p.meta = { lane, silent, midi };
    sim.version++;
  }
  // 手触り：木の「コトッ」と、ちょうどいい間隔の「チッ」はそのまま
  feel.place(e.size, e.speed);
  const nice = e.status === 'nice';
  if (nice) feel.nice();
  view.ring(e.x, e.y, e.z, {
    color: nice ? '#fff2c8' : lighten(col, 0.3), r0: 0.15, r1: nice ? 0.95 : 0.55,
    life: nice ? 0.6 : 0.4, a: nice ? 0.9 : 0.45, n: p?.n,
  });
  if (silent) {
    view.flash(e.id, '#f4e6cc', 0.3);
  } else {
    // 次の16分にそろえて鳴らす（同じ16分に同じ音は1回だけ、重ねるのは3音まで）
    const synth = M.synth;
    const at = synth.nextStep(synth.now() + 0.02, 1);
    if (at.step !== M.placeStep) {
      M.placeStep = at.step;
      M.placeNotes.clear();
    }
    const dup = at.step >= 0 && (M.placeNotes.has(midi) || M.placeNotes.size >= 3);
    if (!dup) {
      M.placeNotes.add(midi);
      synth.note(midi, e.size, { t: at.t, vel: nice ? LOOK.placeVel + 0.12 : LOOK.placeVel, pan: e.x / 14, sparkle: nice });
      M.visuals.push({ perf: perfNow() + Math.max(0, at.t - synth.now()), lane, id: e.id, color: lighten(col, 0.5) });
    }
    const top = (e.y || 0) + SIZES[e.size].h + 0.35;
    ctx.floatLabel(LANE_NAME[lane], e.x, top, e.z, `m-note m-n${lane} m-${e.size}`, 1100);
  }
  state.lastYaw = e.yaw;
  state.yawOffset = 0;
  return true;
}

function onHit(e, ctx) {
  const { sim, view } = ctx;
  const p = sim.byId.get(e.id);
  let meta = e.meta || p?.meta;
  if (!meta) {
    const lane = laneOf(e.z);
    meta = { lane, silent: false, midi: midiFor(lane, e.size) };
  }
  if (meta.stage) M.sampleTouched = true;
  // おさらい用の記録（倒れ始めた順と、その時刻＝ティック）
  let rec = M.chains.get(e.chain);
  if (!rec) {
    rec = [];
    M.chains.set(e.chain, rec);
  }
  if (rec.length < 2000) {
    rec.push({ tick: e.tick ?? sim.tick, id: e.id, midi: meta.midi, size: e.size, lane: meta.lane, silent: !!meta.silent, x: e.x });
  }
  const pan = e.x / 14;
  if (meta.silent) {
    M.synth.click(e.size, { pan, gain: 0.8 });
    view.flash(e.id, '#f6ead2', 0.25);
    return true;
  }
  M.synth.note(meta.midi, e.size, { vel: LOOK.hitVel + (Math.random() - 0.5) * 0.08, pan });
  const col = LANE_COLOR[meta.lane];
  view.flash(e.id, lighten(col, 0.55), 0.5);
  M.pulse[meta.lane] = Math.min(1.2, M.pulse[meta.lane] + 0.7);
  const h = SIZES[e.size]?.h ?? 1;
  const n = p?.n || { x: 0, y: 1, z: 0 };
  view.ring(e.x - n.x * h * 0.5, e.y - n.y * h * 0.5, e.z - n.z * h * 0.5, {
    color: lighten(col, 0.2), r0: 0.2, r1: 0.55 + 0.4 * h, life: 0.5, a: 0.55, n,
  });
  return true;
}

function onChainEnd(e, ctx) {
  let rec = M.chains.get(e.chain);
  M.chains.delete(e.chain);
  if (!rec && Array.isArray(e.order)) {
    // 記録がないとき（ふつうは起きない）は、倒れた順（order）だけから等間隔で
    rec = e.order.map((id, i) => {
      const p = ctx.sim.byId.get(id);
      const m = p?.meta;
      return m ? { tick: i * 10, id, midi: m.midi, size: p.size, lane: m.lane, silent: !!m.silent, x: p.body.translation().x } : null;
    }).filter(Boolean);
  }
  if (!rec) return;
  const notes = rec.filter((r) => !r.silent);
  if (notes.length === 0) return;
  const events = quantizeTake(notes);
  M.take = { events, count: notes.length };
  setReplayButton();
  if (hasTwinkle(events)) {
    // 少し待って（連鎖の締めの和音のあとに）ごほうびの鈴
    M.visuals.push({ perf: perfNow() + 0.9, kind: 'twinkle', x: e.x, z: e.z });
  }
}

function celebrate(v, ctx) {
  ctx.floatLabel('きらきら星！', v.x, 2.6, v.z, 'big', 3200);
  const s = M.synth;
  const t = s.now() + 0.02;
  [84, 88, 91, 96].forEach((m, i) => s.note(m, 's', { t: t + i * 0.13, vel: 0.5 }));
  if (!M.twinkleDone) {
    M.twinkleDone = true;
    ctx.view.room.sticky.setLines(['できた！', 'きらきら星', 'つぎは', 'じゆうに']);
  }
}

// ---------- おさらい ----------

function toggleReplay(ctx) {
  if (M.replay) {
    M.replay = null;
    setReplayButton();
    return;
  }
  const s = M.synth;
  if (!M.take || !M.take.events.length || !s.ready()) return;
  const first = s.nextStep(s.now() + 0.08, 2);     // 次の8分から
  M.replay = { events: M.take.events, i: 0, startStep: first.step, t0: first.t, endAt: Infinity };
  setReplayButton();
}

function replayTime(r, step) {
  return r.startStep >= 0 ? M.synth.stepTime(r.startStep + step) : r.t0 + step * (60 / 72 / 4);
}

function runReplay(ctx) {
  const r = M.replay;
  if (!r) return;
  const s = M.synth;
  if (!s.ready()) {
    M.replay = null;
    setReplayButton();
    return;
  }
  const now = s.now();
  while (r.i < r.events.length) {
    const ev = r.events[r.i];
    const t = replayTime(r, ev.step);
    if (t > now + 0.15) break;
    s.note(ev.midi, ev.size, { t, vel: LOOK.replayVel, pan: (ev.x || 0) / 14 });
    M.visuals.push({ perf: perfNow() + Math.max(0, t - now), lane: ev.lane, id: ev.id, color: lighten(LANE_COLOR[ev.lane], 0.55), replay: true });
    r.i++;
    if (r.i >= r.events.length) r.endAt = t + 1.0;
  }
  if (now > r.endAt) {
    M.replay = null;
    setReplayButton();
  }
}

// 音に合わせて帯とドミノを光らせる
function runVisuals(ctx) {
  const t = perfNow();
  const { sim, view } = ctx;
  for (let i = M.visuals.length - 1; i >= 0; i--) {
    const v = M.visuals[i];
    if (v.perf > t) continue;
    M.visuals.splice(i, 1);
    if (v.kind === 'twinkle') { celebrate(v, ctx); continue; }
    if (v.lane >= 0) M.pulse[v.lane] = Math.min(1.2, M.pulse[v.lane] + (v.replay ? 0.55 : 0.45));
    const p = sim.byId.get(v.id);
    if (!p) continue;
    view.flash(v.id, v.color, v.replay ? 0.6 : 0.4);
    if (v.replay) {
      const pos = p.body.translation();
      view.ring(pos.x, Math.max(0, pos.y - 0.12), pos.z, { color: v.color, r0: 0.2, r1: 0.8, life: 0.55, a: 0.5, n: p.n });
    }
  }
  if (M.visuals.length > 400) M.visuals.splice(0, M.visuals.length - 400);
}

// ---------- 毎フレーム ----------

const _ghost = new THREE.Color();

function onFrame(dt, ctx) {
  const { sim, view, state, input } = ctx;
  const h = sim.hand;
  const silent = silentNow();
  const inside = inTray(h.x, h.z);
  const lane = inside ? laneOf(h.z) : -1;
  const baseColor = silent ? WOOD : LANE_COLOR[lane >= 0 ? lane : 0];
  // 手に持っているドミノの色 ＝ いま置いたら鳴る帯の色（つなぎなら白木）
  state.color = baseColor;

  // 置く場所の見本も、帯の色に（届かない・ふさがっているときは土台の色のまま）
  const g = view.ghosts[state.size];
  if (g && g.visible) {
    const chk = sim.checkPlacement(h.x, h.z, h.yaw, state.size);
    if (chk.status === 'ok' || chk.status === 'free' || chk.status === 'nice') {
      const nice = chk.status === 'nice';
      _ghost.set(baseColor);
      if (nice) _ghost.lerp(WHITE, 0.35);
      g.material.color.copy(_ghost);
      g.userData.edges.material.color.copy(_ghost);
      g.material.opacity = nice ? 0.34 : 0.2;
    }
  }

  // 帯をなぞる音（手が別の帯へ移ったとき、ごく小さく）
  if (lane !== M.hoverLane) {
    const t = perfNow();
    if (lane >= 0 && M.hoverLane >= 0 && M.hoverOn && LOOK.pluckGain > 0 && !silent && state.started
      && !input.poke && !input.primary && t - M.lastPluck > 0.07) {
      M.synth.pluck(midiFor(lane, state.size), { pan: h.x / 14, gain: LOOK.pluckGain });
      M.lastPluck = t;
      M.pulse[lane] = Math.min(1.2, M.pulse[lane] + 0.12);
    }
    M.hoverLane = lane;
  }

  runReplay(ctx);
  runVisuals(ctx);

  // 帯の濃さ：手の下は少し濃く、音が鳴ると光る
  const kh = 1 - Math.exp(-dt * 10);
  const kp = Math.exp(-dt * LOOK.pulseDecay);
  for (let i = 0; i < LANE_COUNT; i++) {
    M.hoverVal[i] += ((i === lane ? LOOK.bandHover : 0) - M.hoverVal[i]) * kh;
    M.pulse[i] *= kp;
    M.bands[i].material.opacity = LOOK.bandBase + M.hoverVal[i] + LOOK.bandPulse * Math.min(1, M.pulse[i]);
  }

  // 左下の表示：いま置いたら鳴る音
  let hud;
  if (silent) hud = `つなぎ（おとなし）|${M.silentToggle ? 'X でもどす' : 'Shift をはなすと もどる'}`;
  else if (lane >= 0) hud = `♪ ${LANE_NAME[lane]}|${SIZE_VOICE[state.size]}${M.hoverOn ? '' : '・なぞり音なし'}`;
  else hud = `♪ ー|${SIZE_VOICE[state.size]}`;
  if (hud !== M.lastHud) {
    M.lastHud = hud;
    const [a, b] = hud.split('|');
    M.ui.now.textContent = a;
    M.ui.now.style.color = silent ? lighten(WOOD, 0.3) : lane >= 0 ? lighten(LANE_COLOR[lane], 0.2) : '';
    M.ui.sub.textContent = b;
  }

  // お手本の押し方（最初に倒れるまで）
  const hint = M.ui.hint;
  const show = state.started && !M.sampleTouched;
  hint.style.opacity = show ? '1' : '0';
  if (show) {
    const r = view.renderer.domElement.getBoundingClientRect();
    const pr = view.project(sample.start.x, 2.3, sample.start.z, r.width, r.height);
    hint.style.transform = `translate(${pr.x}px, ${pr.y}px) translate(-50%, -100%)`;
  }
}

// ---------- 起動 ----------

startProto({
  title: 'ドミノが音符',
  desc: '置くと鳴る、倒すと演奏。手前が低い音、奥が高い音。おてほん「ドドソソ」の つづき（ララソー）を ならべてみよう',
  trace: true,
  layers: 2,
  camera: { dist: 14, pitch: 0.92 },
  keys: [
    ['X', 'おとなしの つなぎ に切り替え'],
    ['Shift（おしながら）', 'つなぎ を置く'],
    ['P', 'おさらい（さっきの曲を拍にそろえて）'],
    ['V', '帯をなぞる音 オン・オフ'],
    ['M', '音を消す'],
  ],
  stage: { solids, props, dominoes: sample.dominoes },

  setup(ctx) {
    const { sim, view, sound } = ctx;
    M.synth = new MusicSynth(sound);
    // 出来事に、それが起きたティックを書き込む（1フレームに何ステップ進んでも、倒れた間隔を正しく測れるように）
    const step0 = sim.step.bind(sim);
    sim.step = () => {
      const n = sim.events.length;
      step0();
      for (let i = n; i < sim.events.length; i++) {
        if (sim.events[i].tick === undefined) sim.events[i].tick = sim.tick;
      }
    };
    buildBands(view.scene);
    buildLabels(view.scene);
    buildDecals(view.scene, sim.solids);
    buildUI(ctx);
    view.follow = 0.42;
    view.room.sticky.setLines(['ならべて', 'きょくを', 'つくろう']);

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Shift') { M.shift = true; return; }
      if (e.repeat) return;
      if (e.code === 'KeyX') M.silentToggle = !M.silentToggle;
      else if (e.code === 'KeyP') toggleReplay(ctx);
      else if (e.code === 'KeyV') M.hoverOn = !M.hoverOn;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') M.shift = false;
    });
    window.addEventListener('blur', () => { M.shift = false; });
  },

  onEvent(e, ctx) {
    switch (e.type) {
      case 'place': return onPlace(e, ctx);
      case 'hit': return onHit(e, ctx);
      case 'rock':
        // ぐらついたときのカタッは、音符が聞こえるように小さめに
        M.synth.click(e.size, { pan: e.x / 14, gain: 0.6 });
        return true;
      case 'chainEnd': onChainEnd(e, ctx); return false;   // 締めの和音と「○れん」は土台のまま
      case 'reset': M.chains.clear(); return false;
      default: return false;
    }
  },

  onFrame,
});
