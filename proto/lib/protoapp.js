// 試作ページの共通の起動処理。各試作は startProto({...}) を呼ぶだけで、
// 物理・描画・操作・音・画面の文字がそろう。試作ごとの違いは stage と hooks で入れる。
//
// startProto({
//   title, desc,            // 左上に出す名前と一言
//   stage,                  // { solids, props, dominoes }（protosim.js の ramp / block で組める）
//   trace: false,           // なぞり置きを使えるか（T で切り替え）
//   colorFor(size, n),      // 置くドミノの色（n は通し番号）
//   palette: [..],          // 色を選べるようにする場合（4〜9 のキー）
//   keys: [[キー, 説明], ..], // 右下の操作一覧に足す
//   setup(ctx),             // 起動後に1回（床に下絵を描く、など）
//   onEvent(e, ctx),        // 出来事ごと。true を返すと既定の音・演出をしない
//   onFrame(dt, ctx),       // 毎フレーム
//   layers: 2,              // BGM のパート数（0〜4）
// })

import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { WORLD } from '../../src/config.js';
import { Input } from '../../src/input.js';
import { Sound } from '../../src/audio.js';
import { mountFilmOverlay } from '../../src/look.js';
import { ProtoSim, SIZES, FEEL } from './protosim.js';
import { ProtoView } from './protoview.js';

const ROT_STEP = (15 * Math.PI) / 180;
const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// 置く手触りの音（木の「コトッ」はサイズで重さが変わる。ちょうどいい間隔は「チッ」）
export class FeelSound {
  constructor(sound) {
    this.sound = sound;
    this.noise = null;
  }
  get ctx() {
    return this.sound.ctx;
  }
  out() {
    return this.sound._sfxVol || this.ctx.destination;
  }
  _noise() {
    if (this.noise) return this.noise;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.08);
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    return (this.noise = b);
  }
  knock(freq, gain, dur = 0.08, q = 3) {
    const ctx = this.ctx;
    if (!ctx || this.sound.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noise();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * 6;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.out());
    src.start(t);
    src.stop(t + dur + 0.02);
    // 胴鳴り
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.8, t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(gain * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.0008, t + dur * 1.4);
    o.connect(og).connect(this.out());
    o.start(t);
    o.stop(t + dur * 1.5);
  }
  place(size, speed = 0) {
    const base = { s: 240, m: 150, l: 95 }[size] || 150;
    const j = 1 + (Math.random() - 0.5) * 0.08;
    this.knock(base * j, 0.55, size === 'l' ? 0.13 : 0.08);
    // 急いで置くと、もう一度「カタッ」
    if (speed > 3) setTimeout(() => this.knock(base * 1.3 * j, 0.25, 0.05), 45 + Math.random() * 30);
  }
  nice() {
    const ctx = this.ctx;
    if (!ctx || this.sound.muted) return;
    const t = ctx.currentTime + 0.01;
    for (const [fq, gn] of [[2637, 0.12], [3951, 0.05]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gn, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g).connect(this.out());
      o.start(t);
      o.stop(t + 0.1);
    }
  }
}

function injectUI(opts) {
  const keys = [
    ['クリック', 'ドミノを置く'],
    ...(opts.trace ? [['押したまま動かす', 'なぞり置き（T で切り替え）']] : []),
    ['1 / 2 / 3', 'ドミノの大きさ（小・中・大）'],
    ['Space（ながおし）', '指で押す'],
    ['Q / E', '向きを回す'],
    ['右クリック', '1つ片付ける'],
    ['Z / C', '1つ戻す / 置いた分を全部消す'],
    ['R', '並べ直す（試作用）'],
    ['ホイール', 'ズーム'],
    ...(opts.keys || []),
  ];
  const wrapEl = document.createElement('div');
  wrapEl.innerHTML = `
    <div class="p-head"><div class="p-title"></div><div class="p-desc"></div></div>
    <dl class="p-keys"></dl>
    <div class="p-status"><span class="p-size"></span><span class="p-mode"></span></div>
    <div id="p-labels" aria-hidden="true"></div>
    <button type="button" class="p-veil" id="p-start"><span><span class="p-veil-title"></span><br><span class="p-veil-sub">クリックして はじめる（音が出ます）</span></span></button>`;
  document.body.appendChild(wrapEl);
  wrapEl.querySelector('.p-title').textContent = opts.title || '試作';
  wrapEl.querySelector('.p-desc').textContent = opts.desc || '';
  wrapEl.querySelector('.p-veil-title').textContent = opts.title || '試作';
  const dl = wrapEl.querySelector('.p-keys');
  for (const [k, v] of keys) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  return wrapEl;
}

export async function startProto(opts = {}) {
  await RAPIER.init();
  const canvas = document.getElementById('scene');
  const sim = new ProtoSim(RAPIER, opts.stage || {});
  if (opts.colorFor) sim.colorFor = opts.colorFor;
  const view = new ProtoView(canvas, sim, opts.camera || {});
  mountFilmOverlay(document.body);
  const sound = new Sound();
  sound.setVolumes({ master: 0.8, music: 0.55, sfx: 0.9 });
  const feel = new FeelSound(sound);
  const ui = injectUI(opts);
  const labels = document.getElementById('p-labels');
  const floating = [];

  const state = {
    size: 'm', trace: !!opts.trace, target: { x: 0, z: 2 }, lastYaw: Math.PI / 2, yawOffset: 0,
    color: opts.palette ? opts.palette[0] : null, started: false,
  };
  const ctx = { sim, view, sound, feel, state, opts, RAPIER, SIZES, FEEL };

  ctx.floatLabel = (text, x, y, z, cls = '', life = 2400) => {
    const el = document.createElement('div');
    el.className = `p-float ${cls}`;
    el.textContent = text;
    labels.appendChild(el);
    floating.push({ el, x, y, z, born: performance.now(), life });
  };

  const input = new Input(canvas, view, (name) => {
    if (name === 'pointerdown') sound.unlock();
    if (name === 'rotL') state.yawOffset += ROT_STEP;
    if (name === 'rotR') state.yawOffset -= ROT_STEP;
    if (name === 'mute') sound.muted = !sound.muted;
  });
  ctx.input = input;
  let lastAlt = 0;

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.code;
    if (k === 'Digit1') state.size = 's';
    else if (k === 'Digit2') state.size = 'm';
    else if (k === 'Digit3') state.size = 'l';
    else if (k === 'KeyR') sim.resetAll();
    else if (k === 'KeyC') sim.clearMine();
    else if (k === 'KeyZ') sim.undo();
    else if (k === 'KeyT' && opts.trace) state.trace = !state.trace;
    else if (opts.palette && /^Digit[4-9]$/.test(k)) {
      const i = Number(k.slice(5)) - 4;
      if (opts.palette[i]) state.color = opts.palette[i];
    }
  });

  const start = document.getElementById('p-start');
  start.addEventListener('click', () => {
    sound.unlock();
    sound.setLayers(opts.layers ?? 2);
    start.hidden = true;
    state.started = true;
    canvas.focus();
  });

  const sizeEl = ui.querySelector('.p-size');
  const modeEl = ui.querySelector('.p-mode');

  function pushInput() {
    if (input.hasPointer && !view.rig.glancing) {
      const gp = input.groundPoint();
      if (gp) state.target = gp;
    }
    const t = state.target;
    let yaw = sim.autoYaw(t.x, t.z, state.lastYaw) + state.yawOffset;
    // ドミノは前後対称。手が無駄に半回転しないよう、今の手の向きに近い方を選ぶ
    if (Math.abs(wrap(yaw - sim.hand.yaw)) > Math.PI / 2) yaw += Math.PI;
    sim.setInput({
      x: t.x, z: t.z, yaw: wrap(yaw),
      primary: input.primary, pressSeq: input.pressSeq, poke: input.poke,
      size: state.size, trace: state.trace, color: state.color,
    });
    if (input.altSeq !== lastAlt) {
      lastAlt = input.altSeq;
      sim.pickAt(t.x, t.z);
    }
  }

  function handle(e) {
    if (opts.onEvent && opts.onEvent(e, ctx) === true) return;
    switch (e.type) {
      case 'place': {
        feel.place(e.size, e.speed);
        const p = sim.byId.get(e.id);
        const n = p?.n;
        if (e.status === 'nice') {
          feel.nice();
          view.flash(e.id, '#fff2c8', 0.5);
          view.ring(e.x, e.y, e.z, { color: '#ffd68a', r0: 0.2, r1: 0.9, life: 0.55, a: 0.9, n });
        } else {
          view.ring(e.x, e.y, e.z, { color: '#fff4e0', r0: 0.1, r1: 0.5, life: 0.35, a: 0.35, n });
        }
        state.lastYaw = e.yaw;
        state.yawOffset = 0;
        break;
      }
      case 'rock': sound.wobble(); break;
      case 'hit': sound.topple(e.depth); break;
      case 'chainEnd':
        sound.chainEnd(e.longest);
        ctx.floatLabel(`${e.longest}れん`, e.x, 1.6, e.z, e.longest >= 20 ? 'big' : '');
        break;
      case 'propHit':
        if (e.name === 'bell') sound.bellRing();
        else sound.pick();
        break;
      case 'pick': sound.pick(); break;
      case 'reset': break;
    }
  }

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    view.resize(Math.max(1, r.width), Math.max(1, r.height));
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.update(dt);
    view.followHand(dt);
    view.rig.apply(dt);
    view.camera.updateMatrixWorld();
    pushInput();
    acc += dt;
    let steps = 0;
    while (acc >= WORLD.dt && steps < 10) {
      sim.step();
      acc -= WORLD.dt;
      steps++;
    }
    if (steps === 10) acc = 0;
    for (const e of sim.drainEvents()) handle(e);
    view.sync(dt);
    // 置く場所の見本
    const h = sim.hand;
    if (!input.poke && state.started) view.setGhost(state.size, sim.checkPlacement(h.x, h.z, h.yaw, state.size));
    else view.setGhost(state.size, null);
    opts.onFrame?.(dt, ctx);
    // 文字
    sizeEl.textContent = `ドミノ：${SIZES[state.size].label}`;
    modeEl.textContent = opts.trace ? (state.trace ? '・なぞり置き' : '・1つずつ置く') : '';
    const r = canvas.getBoundingClientRect();
    const tnow = performance.now();
    for (let i = floating.length - 1; i >= 0; i--) {
      const f = floating[i];
      const age = (tnow - f.born) / f.life;
      if (age >= 1) { f.el.remove(); floating.splice(i, 1); continue; }
      const p = view.project(f.x, f.y + age * 0.8, f.z, r.width, r.height);
      f.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(age < 0.1 ? age / 0.1 : age > 0.7 ? (1 - age) / 0.3 : 1);
    }
    sound.update(dt);
    view.render();
    requestAnimationFrame(frame);
  }

  opts.setup?.(ctx);
  document.getElementById('p-loading')?.remove();
  requestAnimationFrame(frame);

  // デバッグ・自動テスト用。advance(秒) は画面が裏にあっても時間を進める
  ctx.advance = (seconds) => {
    const n = Math.round(seconds / WORLD.dt);
    for (let i = 0; i < n; i++) {
      view.followHand(WORLD.dt);
      view.rig.apply(WORLD.dt);
      view.camera.updateMatrixWorld();
      pushInput();
      sim.step();
      for (const e of sim.drainEvents()) handle(e);
    }
    view.sync(seconds);
    view.render();
  };
  window.__proto = ctx;
  return ctx;
}
