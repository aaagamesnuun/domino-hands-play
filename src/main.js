import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import { DominoSim } from './sim.js';
import { View } from './view.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { mountFilmOverlay } from './look.js';
import { WORLD, LAYOUT, UPGRADES, PLAYER_COLORS, STOCK_STAGES } from './config.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'domino-hands.save.v2';
const SETTINGS_KEY = 'domino-hands.settings.v1';
const LOCAL = 'me';
const ROT_STEP = (15 * Math.PI) / 180;
// 在庫の段階ごとの BGM のパート数（箱が届くたびに増える）
const LAYERS_BY_STAGE = [0, 1, 1, 2, 2, 3, 3, 4];
// ひと休みのあとに写真を貼りに行くときのカメラ（奥の壁のコルクボード。room.js の CORK と 8×5 の並びに合わせる）
const CORK = { x: 14, y: 12.8, z: -17.5, w: 16, h: 11, cols: 8, rows: 5 };
function corkView(i) {
  const col = i % CORK.cols, row = Math.min(CORK.rows - 1, Math.floor(i / CORK.cols));
  const x = CORK.x - CORK.w / 2 + (col + 0.5) * (CORK.w / CORK.cols);
  const y = CORK.y + CORK.h / 2 - (row + 0.5) * (CORK.h / CORK.rows);
  // 写真の少し下を見て、まわりのボードも少し入るくらいの距離
  return { target: [x * 0.7 + CORK.x * 0.3, y - 0.6, CORK.z], pitch: 0.1, dist: 11 };
}

const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

function showFatal(msg) {
  window.__dominoFailed = true;
  $('loading').hidden = true;
  const el = $('fatal');
  el.querySelector('p').textContent = msg;
  el.hidden = false;
}

function loadJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存できなくても遊べる
  }
}

// ひと休みのたびの「写真」：その日の盆を真上から見た絵（240×200。枠と番号は room のポラロイドが付ける）
function drawPhoto(photo) {
  const W = 240, H = 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#2a2420';
  g.fillRect(0, 0, W, H);
  const t = LAYOUT.tray;
  const tw = W - 16, th = tw * (t.z1 - t.z0) / (t.x1 - t.x0);
  const ox = 8, oz = 22;
  g.fillStyle = '#4c5a4a';
  g.fillRect(ox, oz, tw, th);
  const sx = tw / (t.x1 - t.x0);
  for (const [x, z, yaw, fallen, color] of photo.pieces || []) {
    g.save();
    g.translate(ox + (x - t.x0) * sx, oz + (z - t.z0) * sx);
    g.rotate(-yaw);
    g.fillStyle = color === 's' ? '#8a6446' : color;
    // 立っているドミノは細い線、寝ているドミノは長い四角
    if (fallen) g.fillRect(-0.25 * sx, -0.5 * sx, 0.5 * sx, 1.0 * sx);
    else g.fillRect(-0.25 * sx, -0.08 * sx, 0.5 * sx, 0.16 * sx);
    g.restore();
  }
  g.fillStyle = '#f4efe4';
  g.font = '26px Yomogi, "Hiragino Maru Gothic ProN", sans-serif';
  g.textAlign = 'right';
  g.fillText(`${photo.longest} れん`, W - 14, H - 18);
  return c;
}

// 写真に残す価値のある日か（何も並べずに鳴らした呼び鈴は撮らない）
const worthPhoto = (photo) => photo.longest > 0 || (photo.pieces || []).length > 0;

async function boot() {
  try {
    await RAPIER.init();
  } catch (err) {
    showFatal(`物理エンジンを読み込めませんでした（${err?.message || err}）`);
    return;
  }

  const canvas = $('scene');
  const view = new View(canvas);
  const room = view.room;
  const film = mountFilmOverlay(document.body);
  const sim = new DominoSim(RAPIER);
  const saved = loadJSON(SAVE_KEY);
  const loaded = sim.deserialize(saved);
  if (!loaded) sim.newGame();
  sim.addPlayer(LOCAL, { cuff: PLAYER_COLORS[0] });
  if (loaded) sim.restoreCarry();
  for (const photo of sim.photos.filter(worthPhoto).slice(-40)) room.corkboard.addPhoto(drawPhoto(photo));

  const sound = new Sound();
  const settings = { master: 0.8, music: 0.7, sfx: 0.9, ...(loadJSON(SETTINGS_KEY) || {}) };
  sound.setVolumes(settings);

  const ui = {
    target: { x: 0, z: 2 },
    yawOffset: 0,
    lastYaw: Math.PI / 2,
    tool: 'domino',
    started: false,
    noteOpen: false,
    settingsOpen: false,
    wipeArmedUntil: 0,
    lastSave: 0,
    hintTimer: 0,
  };

  let wiping = false;
  const save = () => {
    if (wiping) return;
    saveJSON(SAVE_KEY, sim.serialize());
    ui.lastSave = performance.now();
  };
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) save();
  });

  // ---------- 画面の文字（手書きのラベル） ----------
  const labels = $('labels');
  const floating = [];
  function floatLabel(text, x, z, cls = '', life = 2600) {
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    labels.appendChild(el);
    floating.push({ el, x, z, born: performance.now(), life });
  }
  const handHint = $('hand-hint');
  const carryTag = $('carry-tag');

  // ---------- ノート（強化） ----------
  const note = $('note');
  function renderNote() {
    const prof = sim.profiles.get(LOCAL);
    $('note-stamps').textContent = prof.points;
    const list = $('note-list');
    list.textContent = '';
    for (const up of UPGRADES) {
      const lv = prof.upgrades[up.id] ?? 0;
      const cost = up.costs[lv];
      const li = document.createElement('li');
      const now = up.levels[lv];
      const next = up.levels[lv + 1];
      const fmt = (v) => (up.unit === '倍' ? `${v}倍` : up.unit ? `${v}${up.unit}` : v ? 'あり' : 'なし');
      li.innerHTML = `
        <div class="up-head"><span class="up-name"></span><span class="up-level"></span></div>
        <p class="up-desc"></p>
        <button type="button" class="up-buy"></button>`;
      li.querySelector('.up-name').textContent = up.name;
      li.querySelector('.up-level').textContent = next === undefined ? `${fmt(now)}（さいご）` : `${fmt(now)} → ${fmt(next)}`;
      li.querySelector('.up-desc').textContent = up.desc;
      const btn = li.querySelector('.up-buy');
      if (cost === undefined) {
        btn.textContent = 'もう いっぱい';
        btn.disabled = true;
      } else {
        btn.textContent = `はんこ ${cost}こ で おぼえる`;
        btn.disabled = prof.points < cost;
        btn.addEventListener('click', () => {
          sim.enqueue({ type: 'buy', player: LOCAL, id: up.id });
          btn.disabled = true;
        });
      }
      list.appendChild(li);
    }
  }
  function openNote() {
    ui.noteOpen = true;
    input.setEnabled(false);
    renderNote();
    note.hidden = false;
    note.querySelector('.sheet').scrollTop = 0;
    note.querySelector('.note-close').focus({ preventScroll: true });
  }
  function closeNote() {
    ui.noteOpen = false;
    note.hidden = true;
    input.setEnabled(true);
    canvas.focus();
  }
  note.querySelector('.note-close').addEventListener('click', closeNote);
  note.addEventListener('click', (e) => {
    if (e.target === note) closeNote();
  });

  // ---------- 設定（Esc） ----------
  const settingsEl = $('settings');
  for (const key of ['master', 'music', 'sfx']) {
    const el = $(`vol-${key}`);
    el.value = String(Math.round(settings[key] * 100));
    el.addEventListener('input', () => {
      settings[key] = Number(el.value) / 100;
      sound.setVolumes({ [key]: settings[key] });
      saveJSON(SETTINGS_KEY, settings);
    });
  }
  $('wipe').addEventListener('click', () => {
    const now = performance.now();
    if (now < ui.wipeArmedUntil) {
      wiping = true;
      try { localStorage.removeItem(SAVE_KEY); } catch { /* 無視 */ }
      location.reload();
    } else {
      ui.wipeArmedUntil = now + 3000;
      $('wipe').textContent = 'もういちど押すと、ぜんぶ消えます';
      setTimeout(() => { $('wipe').textContent = 'さいしょから やりなおす'; }, 3000);
    }
  });
  function toggleSettings(open = !ui.settingsOpen) {
    ui.settingsOpen = open;
    settingsEl.hidden = !open;
    input.setEnabled(!open && !ui.noteOpen);
    if (open) $('vol-master').focus();
    else canvas.focus();
  }
  $('settings-close').addEventListener('click', () => toggleSettings(false));

  // ---------- 操作 ----------
  const actions = {
    pointerdown: () => sound.unlock(),
    press: () => {
      // ノートは画面の中の物なので、ここで開く（物理側は何もしない）
      const gp = input.groundPoint() || ui.target;
      const t = sim.resolveTarget(LOCAL, gp.x, gp.z);
      if (t.type === 'note') openNote();
    },
    rotL: () => { ui.yawOffset += ROT_STEP; },
    rotR: () => { ui.yawOffset -= ROT_STEP; },
    tool: () => { ui.tool = ui.tool === 'domino' ? 'stopper' : 'domino'; },
    toolDomino: () => { ui.tool = 'domino'; },
    toolStopper: () => { ui.tool = 'stopper'; },
    note: () => {
      if (ui.settingsOpen) return;
      if (ui.noteOpen) closeNote();
      else openNote();
    },
    mute: () => { sound.muted = !sound.muted; },
    escape: () => {
      if (ui.noteOpen) closeNote();
      else toggleSettings();
    },
  };
  const input = new Input(canvas, view, (name, arg) => actions[name]?.(arg));

  // はじめる（音を鳴らすにはクリックが必要）
  $('start').addEventListener('click', () => {
    sound.unlock();
    sound.setLayers(LAYERS_BY_STAGE[Math.min(sim.stage, LAYERS_BY_STAGE.length - 1)]);
    $('start').hidden = true;
    ui.started = true;
    canvas.focus();
  });

  // ---------- 出来事 → 音・表示 ----------
  function handleEvents(events) {
    for (const e of events) {
      switch (e.type) {
        case 'place':
          sound.place();
          // 置いたら、次の向きの基準を覚えておく
          if (e.hand === LOCAL) {
            ui.lastYaw = e.yaw;
            ui.yawOffset = 0;
            if (e.kind === 'stopper' && sim.hands.get(LOCAL).pocket <= 0) ui.tool = 'domino';
          }
          break;
        case 'pick': sound.pick(); break;
        case 'grab': sound.grab(e.n); break;
        case 'stash': sound.stash(e.fill); break;
        case 'rock': sound.wobble(); break;
        case 'hit': sound.topple(e.depth); break;
        case 'chainEnd':
          sound.chainEnd(e.longest);
          floatLabel(`${e.longest}れん`, e.x, e.z, e.record ? 'record' : '');
          if (e.record && e.longest >= 5) setTimeout(() => sound.stamp(), 350);
          break;
        case 'rest': {
          sound.bellRing();
          room.bell.ring();
          if (worthPhoto(e.photo)) {
            // カメラがコルクボードを見に行き、着いたところで写真を貼る
            const index = sim.photos.filter(worthPhoto).length - 1;
            if (index < 40) view.rig.glance(corkView(index));
            setTimeout(() => room.corkboard.addPhoto(drawPhoto(e.photo)), 850);
          }
          if (e.points > 0) floatLabel(`はんこ +${e.points}`, LAYOUT.note.x, LAYOUT.note.z - 1, 'stamp', 3200);
          if (e.advanced) {
            setTimeout(() => {
              sound.boxArrive();
              sound.setLayers(LAYERS_BY_STAGE[Math.min(sim.stage, LAYERS_BY_STAGE.length - 1)]);
              floatLabel(`あたらしい箱（${e.stock}こ）`, LAYOUT.box.x, LAYOUT.box.z - 1.4, 'stamp', 3600);
            }, 900);
          }
          save();
          break;
        }
        case 'bought':
          sound.stamp();
          if (ui.noteOpen) renderNote();
          save();
          break;
      }
    }
  }

  // ---------- 付箋・箱のラベル・時計 ----------
  function hintLine() {
    const prof = sim.profiles.get(LOCAL);
    const h = sim.hands.get(LOCAL);
    const standing = sim.standingCount();
    const fallen = sim.onTableCount() - standing;
    if (sim.day === 0 && sim.bestEver === 0) return 'Spaceで ゆびを おろして おす';
    const cheapest = Math.min(...UPGRADES.map((u) => u.costs[prof.upgrades[u.id] ?? 0] ?? Infinity));
    if (sim.day > 0 && prof.points >= cheapest) return 'ノートに はんこが たまった';
    if (sim.day === 0 && sim.dayBest >= 10) return 'よびりんを ながおし で ひと休み';
    if (h.carry === 0 && fallen > 0 && standing === 0) return 'たおれたのを ひろって ならべなおす';
    if (h.carry === 0 && sim.boxCount > 0) return '箱から つかむ';
    return `${sim.advanceAt}れんで つぎの箱`;
  }
  function updateDesk() {
    const prof = sim.profiles.get(LOCAL);
    room.sticky.setLines(['きょうの さいちょう', `${sim.dayBest} れん`, hintLine()]);
    room.box.setCount(sim.boxCount, sim.stock);
    room.box.setLabel(`のこり ${sim.boxCount} / ${sim.stock}`);
    room.note.setStamps(prof.points);
    const minutes = 19 * 60 + sim.stage * 12 + Math.min(11, sim.restsThisStage);
    room.clock.set(Math.floor(minutes / 60) % 24, minutes % 60);
    room.setTimeOfDay(minutes / 60);
  }

  // ---------- 入力 → 物理 ----------
  function pushInput() {
    if (input.hasPointer && !view.rig.glancing) {
      const gp = input.groundPoint();
      if (gp) ui.target = gp;
    }
    const t = ui.target;
    const hand = sim.hands.get(LOCAL);
    let yaw = ui.lastYaw;
    const nb = sim.orientAnchor(LOCAL, t.x, t.z);
    if (nb && nb.dist > 0.2) yaw = Math.atan2(t.x - nb.x, t.z - nb.z);
    yaw += ui.yawOffset;
    // ドミノは前後対称。今の手の向きに近い方を選び、手首がはっきり向こうを向くときだけ裏返す
    const f = view.rig.forward();
    if (Math.abs(wrap(yaw - hand.yaw)) > Math.PI / 2) yaw += Math.PI;
    if (-Math.sin(yaw) * f.x - Math.cos(yaw) * f.z > 0.3) yaw += Math.PI;
    sim.setInput(LOCAL, {
      x: t.x, z: t.z, yaw: wrap(yaw),
      primary: input.primary,
      pressSeq: input.pressSeq,
      altSeq: input.altSeq,
      poke: input.poke,
      tool: ui.tool,
    });
  }

  // ものさし：自分が最後に置いたドミノの先に、次の位置の目安
  function rulerGuide(hand) {
    const prof = sim.profiles.get(LOCAL);
    if (!(prof.upgrades.ruler > 0) || hand.carry <= 0 || hand.tool !== 'domino') return null;
    const last = sim.byId.get(hand.lastPlaced);
    if (!last || last.state !== 'standing') return null;
    const p = last.body.translation();
    const q = last.body.rotation();
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    let dir = { x: Math.sin(yaw), z: Math.cos(yaw) };
    // 前のドミノと反対側へ伸ばす
    const prev = sim.nearestStanding(p.x - dir.x * 0.6, p.z - dir.z * 0.6, 0.5);
    const back = sim.nearestStanding(p.x + dir.x * 0.6, p.z + dir.z * 0.6, 0.5);
    if (back && !prev) dir = { x: -dir.x, z: -dir.z };
    const g = { x: p.x + dir.x * 0.6, z: p.z + dir.z * 0.6, yaw };
    const st = sim.checkPlacement(g.x, g.z, g.yaw);
    return st.status === 'blocked' || st.status === 'outside' ? null : g;
  }

  const VERBS = {
    grab: 'つかむ', boxFull: '手が いっぱい', boxEmpty: '箱は からっぽ', pick: 'ひろう', handFull: '手が いっぱい',
    bell: 'ながおしで ひと休み', note: 'ノートを ひらく',
  };

  function updateAids(w, h) {
    const hv = sim.handViews().find((x) => x.id === LOCAL);
    const hand = sim.hands.get(LOCAL);
    const tgt = sim.resolveTarget(LOCAL, ui.target.x, ui.target.z);
    const idle = hv.state === 'hover' && !input.poke;
    room.box.setHighlight(idle && ['grab', 'boxFull', 'boxEmpty'].includes(tgt.type));
    room.bell.setHighlight(idle && tgt.type === 'bell');
    room.note.setHighlight(idle && tgt.type === 'note');
    view.setGlow(idle && (tgt.type === 'pick' || tgt.type === 'handFull') ? tgt.piece : null);
    if (idle && hv.held && tgt.type === 'place') {
      const st = sim.checkPlacement(hv.x, hv.z, hv.yaw, hv.held.kind);
      view.setGhost(hv.held.kind, hv.x, hv.z, hv.yaw, st.status);
    } else {
      view.setGhost('domino', 0, 0, 0, null);
    }
    view.setGuide(idle ? rulerGuide(hand) : null);
    const bellP = Math.max(0, ...sim.handViews().filter((x) => !x.bot).map((x) => x.bell));
    room.bell.setPress(bellP);
    sound.bellPress(bellP);

    // 手の横の小さな文字（何ができるか・いくつ持っているか）
    const sp = view.project(hv.x, hv.originY + 0.4, hv.z, w, h);
    let verb = idle ? VERBS[tgt.type] || '' : '';
    if (idle && tgt.type === 'empty') verb = '箱から つかもう';
    if (idle && hand.carry > 0 && Math.abs(ui.target.x - LAYOUT.box.x) <= LAYOUT.box.hx && Math.abs(ui.target.z - LAYOUT.box.z) <= LAYOUT.box.hz) {
      verb = tgt.type === 'boxFull' ? 'みぎクリックで しまう' : `${verb}・みぎクリックで しまう`;
    }
    handHint.textContent = verb;
    handHint.style.transform = `translate(${sp.x + 26}px, ${sp.y - 10}px)`;
    handHint.hidden = !verb || !ui.started || view.rig.glancing;
    const carryText = hv.tool === 'stopper' ? `しきり ×${hv.pocket}` : hand.carry > 0 ? `×${hand.carry}` : '';
    carryTag.textContent = carryText;
    carryTag.style.transform = `translate(${sp.x - 34}px, ${sp.y + 6}px)`;
    carryTag.hidden = !carryText || !ui.started || view.rig.glancing;

    // 緊張：立っている列に手が近いと、音がこもってランプが少し暗くなる
    const near = sim.standingCount() >= 8 ? sim.nearestStanding(hv.x, hv.z, 1.4) : null;
    const tension = near ? Math.max(0, 1 - near.dist / 1.4) : 0;
    sound.setTension(tension);
    room.setLampDim(tension);   // 部屋の側で最大35%までに抑えてある

    // 浮かぶ文字
    const now = performance.now();
    for (let i = floating.length - 1; i >= 0; i--) {
      const f = floating[i];
      const age = (now - f.born) / f.life;
      if (age >= 1) {
        f.el.remove();
        floating.splice(i, 1);
        continue;
      }
      const p = view.project(f.x, 1.4 + age * 0.8, f.z, w, h);
      f.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(age < 0.1 ? age / 0.1 : age > 0.7 ? (1 - age) / 0.3 : 1);
    }
  }

  // ---------- ループ ----------
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
    handleEvents(sim.drainEvents());
    view.sync(sim, dt);
    const r = canvas.getBoundingClientRect();
    updateAids(r.width, r.height);
    ui.hintTimer -= dt;
    if (ui.hintTimer <= 0) {
      ui.hintTimer = 0.25;
      updateDesk();
    }
    sound.update(dt);
    view.render(dt);
    if (now - ui.lastSave > 5000) save();
    requestAnimationFrame(frame);
  }

  updateDesk();
  $('loading').hidden = true;
  $('fatal').hidden = true;
  requestAnimationFrame(frame);

  // デバッグ・自動テスト用。advance(秒) は画面が裏にあっても時間を進める（描画も1回する）
  const advance = (seconds) => {
    const n = Math.round(seconds / WORLD.dt);
    for (let i = 0; i < n; i++) {
      view.rig.apply(WORLD.dt);
      view.camera.updateMatrixWorld();
      pushInput();
      sim.step();
      handleEvents(sim.drainEvents());
    }
    view.sync(sim, seconds);
    const r = canvas.getBoundingClientRect();
    updateAids(r.width, r.height);
    updateDesk();
    view.render();
  };
  window.__domino = { sim, view, input, ui, sound, room, film, save, advance, STOCK_STAGES };
}

boot().catch((err) => showFatal(`起動できませんでした（${err?.message || err}）`));
