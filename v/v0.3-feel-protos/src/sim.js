// 物理とゲームのルール本体。
// three.js や DOM に依存しない。プレイヤーごとの入力と命令だけで 1/120 秒刻みに進むので、
// 将来はサーバーで同じものを動かせる。決定性のため Math.random や時刻は使わない。
//
// 世界（みんなの共有）：盆の上の駒、箱の在庫、今日の最長、写真
// 個人：ポイントと強化（profile）。手は「席」で、人間・見習いのボットが同じ仕組みで座る。

import {
  DOMINO, STOPPER, WORLD, HAND, CHAIN, PLACEMENT, LAYOUT,
  STOCK_STAGES, STOCK_ADVANCE_RATIO, pointsFor, UPGRADES,
  DOMINO_COLORS, FIRST_DOMINO_COLOR, APPRENTICE_COLOR,
} from './config.js';

const SHAPES = {
  domino: { hx: DOMINO.w / 2, hy: DOMINO.h / 2, hz: DOMINO.t / 2, density: DOMINO.density, friction: DOMINO.friction },
  stopper: { hx: STOPPER.w / 2, hy: STOPPER.h / 2, hz: STOPPER.t / 2, density: STOPPER.density, friction: STOPPER.friction },
};
const MAX_PIECES = 3600;
const ZERO = { x: 0, y: 0, z: 0 };
const deg = (d) => (d * Math.PI) / 180;
const COS = {
  wobble: Math.cos(deg(CHAIN.wobbleDeg)),
  fall: Math.cos(deg(CHAIN.fallDeg)),
  restFall: Math.cos(deg(CHAIN.restFallDeg)),
  back: Math.cos(deg(CHAIN.backDeg)),
  tick: Math.cos(deg(CHAIN.tickDeg)),
  upright: Math.cos(deg(1.5)),
};

// 手の当たり判定の配置（手の原点からの相対位置）
const PALM_HOLD = { x: 0, y: HAND.palmY, z: -0.02 };
const PALM_POKE = { x: 0, y: 0.22, z: -0.12 };
const HOVER_ORIGIN_Y = HAND.hoverY + DOMINO.h;       // 待機中の手の原点の高さ（どのポーズでも同じ）
const POKE_HOVER_TIP = HOVER_ORIGIN_Y - HAND.pokeLen;
const PAD_BOTTOM = -HAND.padY + HAND.padHalf.y;       // 手の原点から指パッドの下端まで

const padZ = (kind) => SHAPES[kind].hz + HAND.padGap + HAND.padHalf.z;
const thumbZ = (kind) => SHAPES[kind].hz + HAND.padGap + HAND.thumbHalf.z;
const pieceH = (kind) => SHAPES[kind].hy * 2;

export function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// 回転から「床の上で向いている角度」を取り出す。前に倒れても水平のままの幅方向（ローカル x 軸）から求める
export function yawOf(q) {
  const xx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const xz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(-xz, xx);
}

const upYOf = (q) => 1 - 2 * (q.x * q.x + q.z * q.z);

function inRect(o, x, z, margin = 0) {
  return Math.abs(x - o.x) <= o.hx + margin && Math.abs(z - o.z) <= o.hz + margin;
}

// 箱から出てくるドミノの色（4色をむらなく混ぜる。決定的）
function colorFor(n) {
  return DOMINO_COLORS[(n * 7 + (n >> 2) + (n >> 4)) % DOMINO_COLORS.length];
}

// 強化の段階から、手の性能を計算する
export function handParams(upgrades, isBot = false) {
  const lv = (id) => upgrades?.[id] ?? 0;
  const val = (id) => UPGRADES.find((u) => u.id === id).levels[lv(id)];
  if (isBot) return { carryMax: 3, speed: 0.55, scoop: 1, stoppers: 0 };
  return { carryMax: val('bigHand'), speed: val('deft'), scoop: val('scoop'), stoppers: val('stopper') };
}

export class DominoSim {
  constructor(RAPIER) {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -WORLD.gravity, z: 0 });
    this.world.timestep = WORLD.dt;
    this.world.numSolverIterations = WORLD.solverIterations;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.tick = 0;
    this.nextId = 1;
    this.pieces = [];             // 盆の上の駒（ドミノと仕切り板）。手に持っている分は含まない
    this.byId = new Map();
    this.byBody = new Map();
    this.colliderOwner = new Map();
    this.hands = new Map();       // 手の席（人間とボット）
    this.profiles = new Map();    // 個人：ポイントと強化
    this.chains = new Map();      // 開いている連鎖
    this.nextChainId = 1;
    this.commands = [];
    this.events = [];
    this.version = 0;             // 駒の増減や色が変わるたびに増える

    // 共有の世界
    this.stage = 0;
    this.stock = STOCK_STAGES[0];
    this.boxCount = this.stock;
    this.dayBest = 0;
    this.bestEver = 0;
    this.day = 0;
    this.restsThisStage = 0;      // 今の在庫の段階になってからのひと休みの回数（時計を進める）
    this.drawn = 0;               // これまで箱から出したドミノの数（色を決める）
    this.firstPending = true;     // 今日まだ「はじめの一枚」を出していない
    this.dayLog = [];             // 今日の置く操作 [tick, handId, x, z, yaw, kind]
    this.photos = [];             // ひと休みのたびの配置

    this._probe = {};
    for (const kind of Object.keys(SHAPES)) {
      const s = SHAPES[kind];
      this._probe[kind] = new RAPIER.Cuboid(s.hx + 0.005, s.hy - 0.02, s.hz + HAND.padGap + 2 * HAND.padHalf.z + HAND.padOpen);
    }
    this._pickShape = new RAPIER.Cylinder(0.55, 0.1);
    this._createTable();
  }

  // ---------- 台と盆 ----------

  _createTable() {
    const R = this.R;
    const { table: t, tray } = LAYOUT;
    const fixed = (cx, cy, cz, hx, hy, hz, friction = 0.6) => {
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(cx, cy, cz));
      this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction), body);
    };
    // 天板（上面が y=0）
    fixed((t.x0 + t.x1) / 2, -0.5, (t.z0 + t.z1) / 2, (t.x1 - t.x0) / 2, 0.5, (t.z1 - t.z0) / 2);
    // 盆の縁：内側の面が盆の境界に一致し、外へ rimThickness だけ張り出す
    const rt = tray.rimThickness, rh = tray.rimHeight;
    const cx = (tray.x0 + tray.x1) / 2, cz = (tray.z0 + tray.z1) / 2;
    const hw = (tray.x1 - tray.x0) / 2 + rt, hd = (tray.z1 - tray.z0) / 2;
    fixed(cx, rh / 2, tray.z0 - rt / 2, hw, rh / 2, rt / 2);
    fixed(cx, rh / 2, tray.z1 + rt / 2, hw, rh / 2, rt / 2);
    fixed(tray.x0 - rt / 2, rh / 2, cz, rt / 2, rh / 2, hd);
    fixed(tray.x1 + rt / 2, rh / 2, cz, rt / 2, rh / 2, hd);
  }

  // 床面上の点が盆の中か（向きつきの足跡がはみ出さないか）
  _insideTray(x, z, yaw, kind) {
    const s = SHAPES[kind];
    const ex = s.hx * Math.abs(Math.cos(yaw)) + s.hz * Math.abs(Math.sin(yaw));
    const ez = s.hx * Math.abs(Math.sin(yaw)) + s.hz * Math.abs(Math.cos(yaw));
    const t = LAYOUT.tray;
    return x - ex > t.x0 + 0.02 && x + ex < t.x1 - 0.02 && z - ez > t.z0 + 0.02 && z + ez < t.z1 - 0.02;
  }

  // 向きつきの足跡が盆に収まる位置へ寄せる
  _clampToTray(x, z, yaw, kind) {
    const s = SHAPES[kind];
    const ex = s.hx * Math.abs(Math.cos(yaw)) + s.hz * Math.abs(Math.sin(yaw)) + 0.03;
    const ez = s.hx * Math.abs(Math.sin(yaw)) + s.hz * Math.abs(Math.cos(yaw)) + 0.03;
    const t = LAYOUT.tray;
    return {
      x: Math.min(Math.max(x, t.x0 + ex), t.x1 - ex),
      z: Math.min(Math.max(z, t.z0 + ez), t.z1 - ez),
    };
  }

  // ---------- 駒 ----------

  _pieceDesc(kind) {
    const s = SHAPES[kind];
    return this.R.ColliderDesc.cuboid(s.hx, s.hy, s.hz)
      .setFriction(s.friction)
      .setRestitution(0)
      .setDensity(s.density);
  }

  _register(body, collider, kind, color, extra = {}) {
    const p = {
      id: this.nextId++, kind, body, collider, color,
      state: 'standing',          // standing | wobbling | fallen
      chainId: 0, depth: 0, wobbleTick: -1e9, rocked: false,
      first: false, owner: null, placedBy: null,
      ...extra,
    };
    this.pieces.push(p);
    this.byId.set(p.id, p);
    this.byBody.set(body.handle, p);
    this.colliderOwner.set(collider.handle, { kind: 'piece', p });
    this.version++;
    return p;
  }

  // 直接置く（新しいゲームの最初の並びと、セーブの読み込み用）
  _spawnPiece(kind, pos, rot, color, extra) {
    if (this.pieces.length >= MAX_PIECES) return null;
    const body = this.world.createRigidBody(
      this.R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(rot),
    );
    const collider = this.world.createCollider(this._pieceDesc(kind), body);
    return this._register(body, collider, kind, color, extra);
  }

  _removePiece(p) {
    const pos = p.body.translation();
    const neighbors = [];
    this.world.collidersWithAabbIntersectingAabb({ x: pos.x, y: 0.5, z: pos.z }, { x: 1.3, y: 1, z: 1.3 }, (c) => {
      const o = this.colliderOwner.get(c.handle);
      if (o && o.kind === 'piece' && o.p !== p) neighbors.push(o.p);
      return true;
    });
    this.colliderOwner.delete(p.collider.handle);
    this.byBody.delete(p.body.handle);
    this.world.removeRigidBody(p.body);
    const i = this.pieces.indexOf(p);
    if (i >= 0) this.pieces.splice(i, 1);
    this.byId.delete(p.id);
    // もたれかかっていた駒が宙に浮いたまま眠らないように起こす
    for (const n of neighbors) n.body.wakeUp();
    this.version++;
  }

  standingCount() {
    let n = 0;
    for (const p of this.pieces) if (p.kind === 'domino' && p.state !== 'fallen') n++;
    return n;
  }

  onTableCount() {
    let n = 0;
    for (const p of this.pieces) if (p.kind === 'domino') n++;
    return n;
  }

  // 次の箱が届く条件（今日の最長がこれ以上でひと休み）
  get advanceAt() {
    return Math.ceil(this.stock * STOCK_ADVANCE_RATIO);
  }

  // ---------- プレイヤーと手 ----------

  addPlayer(id, { cuff = '#c98b5f', name = '' } = {}) {
    if (!this.profiles.has(id)) this.profiles.set(id, { id, name, points: 0, upgrades: {} });
    const prof = this.profiles.get(id);
    const h = this._addHand(id, { owner: id, cuff, bot: false });
    this._applyParams(h, prof);
    if ((prof.upgrades.apprentice ?? 0) > 0) this._ensureApprentice(id);
    return h;
  }

  _addHand(handId, { owner, cuff, bot, x = 0, z = 5 }) {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, HOVER_ORIGIN_Y, z),
    );
    const h = {
      id: handId, owner, cuff, bot,
      body, colliders: {},
      state: 'hover',             // hover | lowering | down | opening | raising | poke | grab | stash | pick | bell
      pose: 'hold',               // hold | poke
      x, z, y: HAND.hoverY,       // y: アンカー（持った駒の底、または指先）
      yaw: 0, open: 0, timer: 0,
      tool: 'domino',
      carry: 0,                   // 手に持っているドミノの数（指でつまんでいる1個も含む）
      bag: [],                    // 拾ったドミノの色と「はじめの一枚」か（置くときにそのまま出す）
      pocket: 0,                  // 手元にある仕切り板の数
      held: null,                 // 指でつまんでいる駒（物理つき）
      target: null,               // 箱・呼び鈴・拾う駒など、今向かっている物
      bellTicks: 0,
      wantPlace: false, dropX: x, dropZ: z, releaseOnArrive: false,
      lastPressSeq: 0, lastAltSeq: 0,
      justReleased: null, lastPlaced: null,
      params: handParams({}, bot),
      input: { x, z, yaw: 0, primary: false, pressSeq: 0, altSeq: 0, poke: false, tool: 'domino' },
      brain: bot ? { park: { x: LAYOUT.box.x + 2.6, z: LAYOUT.box.z - 1.2 } } : null,
    };
    const mk = (desc, part) => {
      const c = this.world.createCollider(desc.setFriction(0.9), body);
      this.colliderOwner.set(c.handle, { kind: 'hand', hand: h, part });
      return c;
    };
    const P = HAND.palmHalf, A = HAND.padHalf, T = HAND.thumbHalf, r = HAND.pokeRadius;
    const pokeTop = 0.05;
    const pokeHalf = (pokeTop + HAND.pokeLen) / 2;
    h.colliders.palm = mk(R.ColliderDesc.cuboid(P.x, P.y, P.z).setTranslation(PALM_HOLD.x, PALM_HOLD.y, PALM_HOLD.z), 'palm');
    h.colliders.padA = mk(R.ColliderDesc.cuboid(A.x, A.y, A.z).setTranslation(0, HAND.padY, padZ('domino')), 'finger');
    h.colliders.padB = mk(R.ColliderDesc.cuboid(T.x, T.y, T.z).setTranslation(0, HAND.padY, -thumbZ('domino')), 'finger');
    h.colliders.poke = mk(R.ColliderDesc.capsule(pokeHalf - r, r).setTranslation(0, pokeTop - pokeHalf, 0), 'poke');
    h.colliders.poke.setEnabled(false);
    this.hands.set(handId, h);
    return h;
  }

  _applyParams(h, prof) {
    h.params = handParams(prof?.upgrades, h.bot);
    if (!h.bot) {
      // 仕切り板の総数が増えた分だけ手元に足す
      // 手元の数（つまんでいる1枚を含む）＝ 持っている総数 − 盆の上にある数
      const onTable = this.pieces.filter((p) => p.kind === 'stopper' && p.owner === h.owner).length;
      h.pocket = Math.max(0, h.params.stoppers - onTable);
    }
  }

  _ensureApprentice(ownerId) {
    const id = `${ownerId}:apprentice`;
    if (this.hands.has(id)) return;
    const b = LAYOUT.box;
    const n = [...this.hands.values()].filter((h) => h.bot).length;
    const h = this._addHand(id, { owner: ownerId, cuff: APPRENTICE_COLOR, bot: true, x: b.x + 2.6 + n * 0.9, z: b.z - 1.2 });
    h.brain.park = { x: b.x + 2.6 + n * 0.9, z: b.z - 1.2 };
  }

  setInput(handId, input) {
    const h = this.hands.get(handId);
    if (h && !h.bot) Object.assign(h.input, input);
  }

  // 命令（買う、など）は次のティックの頭で処理する。通信版ではここに全員の命令が届く
  enqueue(cmd) {
    this.commands.push(cmd);
  }

  _applyCommand(cmd) {
    if (cmd.type === 'buy') {
      const prof = this.profiles.get(cmd.player);
      const up = UPGRADES.find((u) => u.id === cmd.id);
      if (!prof || !up) return;
      const lv = prof.upgrades[up.id] ?? 0;
      const cost = up.costs[lv];
      if (cost === undefined || prof.points < cost) return;
      prof.points -= cost;
      prof.upgrades[up.id] = lv + 1;
      for (const h of this.hands.values()) if (h.owner === prof.id && !h.bot) this._applyParams(h, prof);
      if (up.id === 'apprentice') this._ensureApprentice(prof.id);
      this.events.push({ type: 'bought', player: prof.id, id: up.id, level: lv + 1 });
    }
  }

  // ---------- 手に持つ駒 ----------

  _spawnHeld(h) {
    const kind = h.tool;
    if (kind === 'domino' && h.carry <= 0) return;
    if (kind === 'stopper' && h.pocket <= 0) return;
    const R = this.R;
    let color = '#a3845f';
    let first = false;
    if (kind === 'domino') {
      if (h.nextColor) {
        color = h.nextColor;
        first = h.nextFirst;
      } else if (h.bag.length) {
        ({ color, first } = h.bag.pop());
      } else if (this.firstPending && !h.bot) {
        color = FIRST_DOMINO_COLOR;
        first = true;
        this.firstPending = false;
      } else {
        color = colorFor(this.drawn++);
      }
      h.nextColor = null;
      h.nextFirst = false;
    }
    h.y = HOVER_ORIGIN_Y - pieceH(kind);
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(h.x, h.y + SHAPES[kind].hy, h.z)
        .setRotation(yawQuat(h.yaw)),
    );
    const collider = this.world.createCollider(this._pieceDesc(kind), body);
    this.colliderOwner.set(collider.handle, { kind: 'hand', hand: h, part: 'held' });
    h.held = { kind, body, collider, color, first };
    this._setPadsFor(h, kind);
  }

  // 持っている駒をしまう（手の中の数はそのまま。色は次に出すときに引き継ぐ）
  _tuckHeld(h) {
    if (!h.held) return;
    if (h.held.kind === 'domino') {
      h.nextColor = h.held.color;
      h.nextFirst = h.held.first;
    }
    this.colliderOwner.delete(h.held.collider.handle);
    this.world.removeRigidBody(h.held.body);
    h.held = null;
  }

  _release(h) {
    const R = this.R;
    const { kind, body, collider, color, first } = h.held;
    h.held = null;
    this.colliderOwner.delete(collider.handle);
    body.setBodyType(R.RigidBodyType.Dynamic, true);
    body.setTranslation({ x: h.x, y: SHAPES[kind].hy + 0.0005, z: h.z }, true);
    body.setRotation(yawQuat(h.yaw), true);
    body.setLinvel(ZERO, true);
    body.setAngvel(ZERO, true);
    const p = this._register(body, collider, kind, color, { first, owner: h.owner, placedBy: h.id });
    if (kind === 'domino') h.carry--;
    else h.pocket--;
    h.justReleased = p.id;
    h.lastPlaced = p.id;
    this.dayLog.push([this.tick, h.id, +h.x.toFixed(3), +h.z.toFixed(3), +h.yaw.toFixed(3), kind]);
    this.events.push({ type: 'place', hand: h.id, id: p.id, kind, x: h.x, z: h.z, yaw: h.yaw });
  }

  _setPadsFor(h, kind) {
    h.padKind = kind;
    this._setOpen(h, h.open, true);
  }

  _setPose(h, pose) {
    if (h.pose === pose) return;
    h.pose = pose;
    const { palm, padA, padB, poke } = h.colliders;
    const hold = pose === 'hold';
    padA.setEnabled(hold);
    padB.setEnabled(hold);
    poke.setEnabled(!hold);
    palm.setTranslationWrtParent(hold ? PALM_HOLD : PALM_POKE);
  }

  _setOpen(h, v, force = false) {
    if (h.open === v && !force) return;
    h.open = v;
    const kind = h.padKind || 'domino';
    const dz = v * HAND.padOpen;
    h.colliders.padA.setTranslationWrtParent({ x: 0, y: HAND.padY, z: padZ(kind) + dz });
    h.colliders.padB.setTranslationWrtParent({ x: 0, y: HAND.padY, z: -(thumbZ(kind) + dz) });
  }

  // ---------- クリックしたときに何をするか ----------

  // 手が (x, z) でクリックしたときの行き先。描画側もこれを使って、触れる物を光らせる
  resolveTarget(handId, x, z, alt = false) {
    const h = this.hands.get(handId);
    if (!h) return { type: 'none' };
    const { box, bell, note } = LAYOUT;
    if (alt) return inRect(box, x, z, 0.2) && h.carry > 0 ? { type: 'stash' } : { type: 'none' };
    if (Math.hypot(x - bell.x, z - bell.z) <= bell.r + 0.2) return { type: 'bell' };
    if (inRect(box, x, z, 0.2)) {
      const space = h.params.carryMax - h.carry;
      if (space <= 0) return { type: 'boxFull' };
      if (this.boxCount <= 0) return { type: 'boxEmpty' };
      return { type: 'grab', n: Math.min(space, this.boxCount) };
    }
    if (inRect(note, x, z, 0.2)) return { type: 'note' };
    const t = LAYOUT.tray;
    if (x < t.x0 || x > t.x1 || z < t.z0 || z > t.z1) return { type: 'none' };
    const piece = this._pieceAt(x, z, h);
    if (piece) {
      if (piece.kind === 'domino' && h.carry >= h.params.carryMax) return { type: 'handFull', piece };
      return { type: 'pick', piece };
    }
    const hasPiece = h.tool === 'stopper' ? h.pocket > 0 : h.carry > 0;
    return hasPiece ? { type: 'place' } : { type: 'empty' };
  }

  // カーソルの真下にある駒（細い円柱で探す）。ほかの手が拾いに行っている駒は除く
  _pieceAt(x, z, h) {
    let best = null;
    let bestD = Infinity;
    this.world.intersectionsWithShape({ x, y: 0.55, z }, { x: 0, y: 0, z: 0, w: 1 }, this._pickShape, (c) => {
      const o = this.colliderOwner.get(c.handle);
      if (!o || o.kind !== 'piece') return true;
      const taken = [...this.hands.values()].some((o2) => o2 !== h && o2.target?.piece === o.p);
      if (taken) return true;
      const p = o.p.body.translation();
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) {
        bestD = d;
        best = o.p;
      }
      return true;
    });
    return best;
  }

  // ---------- 手の動き（1ティック） ----------

  _updateHand(h) {
    const dt = WORLD.dt;
    const inp = h.input;
    const sp = h.params.speed;

    if (inp.pressSeq !== h.lastPressSeq) {
      h.lastPressSeq = inp.pressSeq;
      if (h.state === 'hover' && !inp.poke) this._onPress(h, inp.x, inp.z);
    }
    if (inp.altSeq !== h.lastAltSeq) {
      h.lastAltSeq = inp.altSeq;
      if (h.state === 'hover' && !inp.poke) {
        const t = this.resolveTarget(h.id, inp.x, inp.z, true);
        if (t.type === 'stash') this._begin(h, 'stash', { x: LAYOUT.box.x, z: LAYOUT.box.z });
      }
    }

    // 持つ道具（ドミノ / 仕切り板）の切り替えは待機中だけ
    const wantTool = inp.tool === 'stopper' && h.pocket > 0 ? 'stopper' : 'domino';
    if (h.state === 'hover' && wantTool !== h.tool) {
      this._tuckHeld(h);
      h.tool = wantTool;
      h.timer = 0;
    }

    const hoverAnchor = HOVER_ORIGIN_Y - pieceH(h.held ? h.held.kind : 'domino');

    switch (h.state) {
      case 'hover':
        h.y = hoverAnchor;
        if (inp.poke) {
          this._tuckHeld(h);
          this._setPose(h, 'poke');
          h.y = POKE_HOVER_TIP;
          h.wantPlace = false;
          h.state = 'poke';
        } else if (!h.held && (h.tool === 'stopper' ? h.pocket > 0 : h.carry > 0)) {
          if (++h.timer >= HAND.reloadTicks / sp) {
            h.timer = 0;
            this._spawnHeld(h);
          }
        } else if (h.wantPlace && h.held) {
          h.wantPlace = false;
          h.releaseOnArrive = !inp.primary;
          h.state = 'lowering';
        } else if (h.wantPlace && !h.held && !(h.tool === 'stopper' ? h.pocket > 0 : h.carry > 0)) {
          h.wantPlace = false;
        }
        break;
      case 'lowering':
        if (!inp.primary) h.releaseOnArrive = true;
        if (h.y < hoverAnchor - 1e-6 || Math.hypot(h.dropX - h.x, h.dropZ - h.z) < 0.04) {
          h.y -= HAND.lowerSpeed * sp * dt;
        }
        if (h.y <= 0) {
          h.y = 0;
          if (h.releaseOnArrive || !inp.primary) this._beginRelease(h);
          else h.state = 'down';
        }
        break;
      case 'down':
        if (!inp.primary) this._beginRelease(h);
        break;
      case 'opening':
        this._setOpen(h, Math.min(1, h.open + sp / HAND.openTicks));
        if (++h.timer >= HAND.openTicks / sp) {
          h.timer = 0;
          h.state = 'raising';
        }
        break;
      case 'raising':
        h.y += HAND.raiseSpeed * sp * dt;
        if (h.y > HAND.clearY) this._setOpen(h, Math.max(0, h.open - 0.12));
        if (h.y >= hoverAnchor) {
          h.y = hoverAnchor;
          this._setOpen(h, 0);
          this._setPadsFor(h, 'domino');
          h.state = 'hover';
          h.timer = 0;
          h.target = null;
        }
        break;
      case 'poke':
        if (inp.poke) {
          h.y = Math.max(HAND.pokeY, h.y - HAND.pokeLowerSpeed * dt);
        } else {
          h.y += HAND.raiseSpeed * dt;
          if (h.y >= POKE_HOVER_TIP) {
            this._setPose(h, 'hold');
            h.y = hoverAnchor;
            h.state = 'hover';
            h.timer = 0;
          }
        }
        break;
      case 'grab':
      case 'stash':
      case 'pick':
      case 'bell':
        this._updateErrand(h, sp, dt, hoverAnchor);
        break;
    }

    // --- 水平移動 ---
    const letGo = h.state === 'opening' || (h.state === 'raising' && h.y < HAND.clearY);
    const low = h.y < hoverAnchor - 1e-6;
    let tx = inp.x, tz = inp.z;
    if (h.state === 'lowering') { tx = h.dropX; tz = h.dropZ; }
    // 駒を持って下りている間は、盆の縁を越えられない（縁をすり抜けて台の外へ持ち出さない）
    if ((h.state === 'lowering' || h.state === 'down') && h.held) {
      const c = this._clampToTray(tx, tz, h.yaw, h.held.kind);
      tx = c.x; tz = c.z;
    }
    if (h.target && (h.state === 'grab' || h.state === 'stash' || h.state === 'pick' || h.state === 'bell')) {
      tx = h.target.x; tz = h.target.z;
    }
    const dx = tx - h.x;
    const dz = tz - h.z;
    const k = low ? 1 : 1 - Math.exp(-HAND.followRate * dt);
    let mx = dx * k;
    let mz = dz * k;
    const maxStep = (low ? HAND.maxSpeedLow : HAND.maxSpeedHover) * dt;
    const len = Math.hypot(mx, mz);
    if (len > maxStep) {
      mx *= maxStep / len;
      mz *= maxStep / len;
    }
    if (!letGo) {
      h.x += mx;
      h.z += mz;
    }

    // --- 向き（下ろしている間と、指が駒から抜けるまでは固定） ---
    if (h.state === 'hover' || h.state === 'poke' || (h.state === 'raising' && !letGo)) {
      const dy = wrapAngle(inp.yaw - h.yaw);
      h.yaw = wrapAngle(h.yaw + dy * (1 - Math.exp(-HAND.yawRate * dt)));
    } else if (h.state === 'pick' && h.target?.yaw !== undefined && h.y >= hoverAnchor - 1e-6) {
      const dy = wrapAngle(h.target.yaw - h.yaw);
      h.yaw = wrapAngle(h.yaw + dy * (1 - Math.exp(-HAND.yawRate * dt)));
    }

    const kind = h.held ? h.held.kind : 'domino';
    const originY = h.pose === 'poke' ? h.y + HAND.pokeLen : h.y + pieceH(kind);
    const rot = yawQuat(h.yaw);
    h.body.setNextKinematicTranslation({ x: h.x, y: originY, z: h.z });
    h.body.setNextKinematicRotation(rot);
    if (h.held) {
      h.held.body.setNextKinematicTranslation({ x: h.x, y: h.y + SHAPES[kind].hy, z: h.z });
      h.held.body.setNextKinematicRotation(rot);
    }
  }

  _onPress(h, x, z) {
    const t = this.resolveTarget(h.id, x, z);
    if (h.bot && t.type !== 'pick') return;
    switch (t.type) {
      case 'place': {
        if (h.bot) break;
        const c = this._clampToTray(x, z, h.yaw, h.tool);
        h.wantPlace = true;
        h.dropX = c.x;
        h.dropZ = c.z;
        break;
      }
      case 'grab':
        this._begin(h, 'grab', { x: LAYOUT.box.x, z: LAYOUT.box.z });
        break;
      case 'bell':
        this._begin(h, 'bell', { x: LAYOUT.bell.x, z: LAYOUT.bell.z });
        break;
      case 'pick': {
        const pos = t.piece.body.translation();
        this._begin(h, 'pick', { x: pos.x, z: pos.z, piece: t.piece, yaw: yawOf(t.piece.body.rotation()) });
        break;
      }
      default:
        break;
    }
  }

  _begin(h, state, target) {
    this._tuckHeld(h);
    h.state = state;
    h.target = { ...target, phase: 'travel' };
    h.timer = 0;
    h.bellTicks = 0;
  }

  // 箱・呼び鈴・拾う：目的地まで行き、下ろして、用事を済ませて、上げる
  _updateErrand(h, sp, dt, hoverAnchor) {
    const t = h.target;
    if (t.piece) {
      if (!this.byId.has(t.piece.id)) {
        t.phase = 'up';
      } else if (t.phase === 'travel') {
        const pos = t.piece.body.translation();
        t.x = pos.x;
        t.z = pos.z;
      }
    }
    // 下ろす高さ（手の原点）
    let bottom;
    if (h.state === 'grab' || h.state === 'stash') bottom = LAYOUT.box.height + 0.25;
    else if (h.state === 'bell') bottom = LAYOUT.bell.height + 0.2;
    else bottom = this._pieceTop(t.piece) + PAD_BOTTOM + 0.01;
    const bottomAnchor = bottom - DOMINO.h;

    if (t.phase === 'travel') {
      h.y = hoverAnchor;
      if (Math.hypot(t.x - h.x, t.z - h.z) < 0.05) t.phase = 'down';
    } else if (t.phase === 'down') {
      h.y = Math.max(bottomAnchor, h.y - HAND.lowerSpeed * sp * dt);
      if (h.y <= bottomAnchor + 1e-6) {
        t.phase = 'act';
        h.timer = 0;
      }
    } else if (t.phase === 'act') {
      h.timer++;
      if (h.state === 'grab' && h.timer >= HAND.grabTicks / sp) {
        const n = Math.min(h.params.carryMax - h.carry, this.boxCount);
        if (n > 0) {
          h.carry += n;
          this.boxCount -= n;
          this.events.push({ type: 'grab', hand: h.id, n });
        }
        t.phase = 'up';
      } else if (h.state === 'stash' && h.timer >= HAND.stashTicks / sp) {
        const n = h.carry;
        this.boxCount += n;
        h.carry = 0;
        // はじめの一枚は、箱に戻してもいちばん上に来る
        if (h.nextFirst || h.bag.some((b) => b.first)) this.firstPending = true;
        h.bag = [];
        h.nextColor = null;
        h.nextFirst = false;
        if (n > 0) this.events.push({ type: 'stash', hand: h.id, n, fill: this.boxCount / this.stock });
        t.phase = 'up';
      } else if (h.state === 'pick' && h.timer >= HAND.pickHoldTicks / sp) {
        this._pickUp(h, t.piece);
        t.phase = 'up';
      } else if (h.state === 'bell') {
        if (h.input.primary) {
          h.bellTicks++;
          this._maybeRest();
        } else {
          t.phase = 'up';
        }
      }
    } else if (t.phase === 'up') {
      h.bellTicks = 0;
      h.y = Math.min(hoverAnchor, h.y + HAND.raiseSpeed * sp * dt);
      if (h.y >= hoverAnchor - 1e-6) {
        h.y = hoverAnchor;
        h.state = 'hover';
        h.target = null;
        h.timer = 0;
      }
    }
  }

  _pieceTop(p) {
    if (!p || !this.byId.has(p.id)) return 0.2;
    const pos = p.body.translation();
    const q = p.body.rotation();
    const s = SHAPES[p.kind];
    // 回転した直方体の上端（ローカル軸の y 成分から）
    const ax = Math.abs(2 * (q.x * q.y + q.w * q.z));
    const ay = Math.abs(1 - 2 * (q.x * q.x + q.z * q.z));
    const az = Math.abs(2 * (q.y * q.z - q.w * q.x));
    return pos.y + s.hx * ax + s.hy * ay + s.hz * az;
  }

  _pickUp(h, piece) {
    if (!piece || !this.byId.has(piece.id)) return;
    if (piece.kind === 'stopper') {
      const owner = [...this.hands.values()].find((o) => o.owner === piece.owner && !o.bot);
      this._removePiece(piece);
      if (owner) owner.pocket++;
      this.events.push({ type: 'pick', hand: h.id, n: 1, kind: 'stopper' });
      return;
    }
    const space = h.params.carryMax - h.carry;
    if (space <= 0) return;
    const taken = [piece];
    // すくい拾い：くっついて寝ているドミノをまとめて
    if (piece.state === 'fallen' && h.params.scoop > 1) {
      const c = piece.body.translation();
      const near = this.pieces
        .filter((p) => p !== piece && p.kind === 'domino' && p.state === 'fallen')
        .map((p) => ({ p, d: Math.hypot(p.body.translation().x - c.x, p.body.translation().z - c.z) }))
        .filter((o) => o.d < 0.95)
        .sort((a, b) => a.d - b.d || a.p.id - b.p.id);
      for (const o of near) {
        if (taken.length >= Math.min(space, h.params.scoop)) break;
        taken.push(o.p);
      }
    }
    for (const p of taken) {
      h.bag.push({ color: p.color, first: p.first });
      this._removePiece(p);
    }
    h.carry += taken.length;
    this.events.push({ type: 'pick', hand: h.id, n: taken.length, kind: 'domino' });
  }

  _beginRelease(h) {
    if (!h.held) {
      h.state = 'raising';
      h.timer = 0;
      return;
    }
    this._release(h);
    h.state = 'opening';
    h.timer = 0;
  }

  // ---------- ひと休み（まっさら＋ポイント） ----------

  // 人間の手が全員、呼び鈴を 1.5 秒押し続けたら鳴る
  _maybeRest() {
    const humans = [...this.hands.values()].filter((h) => !h.bot);
    if (!humans.length) return;
    if (humans.every((h) => h.state === 'bell' && h.target?.phase === 'act' && h.bellTicks >= HAND.bellTicks)) {
      this.rest();
    }
  }

  rest() {
    // 閉じていない連鎖も数に入れる
    for (const c of this.chains.values()) this._closeChain(c);
    const longest = this.dayBest;
    const points = pointsFor(longest);
    for (const prof of this.profiles.values()) prof.points += points;

    const photo = {
      day: this.day,
      longest,
      pieces: this.pieces.map((p) => {
        const pos = p.body.translation();
        const q = p.body.rotation();
        return [+pos.x.toFixed(2), +pos.z.toFixed(2), +yawOf(q).toFixed(2), p.state === 'fallen' ? 1 : 0, p.kind === 'stopper' ? 's' : p.color];
      }),
      log: this.dayLog,
    };
    this.photos.push(photo);

    let advanced = false;
    if (longest >= this.advanceAt && this.stage < STOCK_STAGES.length - 1) {
      this.stage++;
      this.stock = STOCK_STAGES[this.stage];
      advanced = true;
      this.restsThisStage = 0;
    } else {
      this.restsThisStage++;
    }
    for (const p of [...this.pieces]) this._removePiece(p);
    for (const h of this.hands.values()) {
      this._tuckHeld(h);
      h.carry = 0;
      h.bag = [];
      h.nextColor = null;
      h.nextFirst = false;
      if (!h.bot) {
        const prof = this.profiles.get(h.owner);
        h.pocket = handParams(prof?.upgrades).stoppers;
      }
      if (h.state === 'bell' && h.target) h.target.phase = 'up';
    }
    this.boxCount = this.stock;
    this.chains.clear();
    this.day++;
    this.dayBest = 0;
    this.dayLog = [];
    this.firstPending = true;
    this.events.push({ type: 'rest', longest, points, advanced, stock: this.stock, day: this.day, photo });
  }

  // ---------- 連鎖の数え方 ----------

  _scanTilts() {
    // コールバックの中では他の問い合わせをしない（WASM 側の二重借用を避ける）
    const moving = [];
    this.world.forEachActiveRigidBody((body) => {
      const p = this.byBody.get(body.handle);
      if (!p || p.kind !== 'domino' || p.state === 'fallen') return;
      moving.push(p, upYOf(body.rotation()));
    });
    for (let i = 0; i < moving.length; i += 2) {
      const p = moving[i];
      const upY = moving[i + 1];
      if (p.state === 'standing') {
        if (upY < COS.wobble) {
          this._startWobble(p);
        } else if (!p.rocked && upY < COS.tick) {
          p.rocked = true;
          const pos = p.body.translation();
          this.events.push({ type: 'rock', id: p.id, x: pos.x, z: pos.z });
        } else if (p.rocked && upY > COS.upright) {
          p.rocked = false;
        }
      }
      if (p.state === 'wobbling') {
        const resting = p.body.isSleeping() || (Math.hypot(...Object.values(p.body.angvel())) < 0.05);
        if (upY < COS.fall || (upY < COS.restFall && resting)) {
          this._confirmFall(p);
        } else if (upY > COS.back) {
          // 倒れずに立ち直った
          p.state = 'standing';
          p.chainId = 0;
          p.depth = 0;
        }
      }
    }
    for (const c of [...this.chains.values()]) {
      if (this.tick - c.lastTick > CHAIN.closeTicks) this._closeChain(c);
    }
  }

  _startWobble(p) {
    // 直前まで触れていた「倒れ始めたばかりのドミノ」を親にする（深さが最大のもの）
    let parent = null;
    this.world.contactPairsWith(p.collider, (other) => {
      const o = this.colliderOwner.get(other.handle);
      if (!o || o.kind !== 'piece') return;
      const q = o.p;
      if (q.kind !== 'domino' || q.state === 'standing' || !this.chains.has(q.chainId)) return;
      if (this.tick - q.wobbleTick > CHAIN.parentWindowTicks) return;
      let touching = false;
      this.world.contactPair(p.collider, other, (m) => {
        if (m.numContacts() > 0) touching = true;
      });
      if (touching && (!parent || q.depth > parent.depth)) parent = q;
    });
    p.state = 'wobbling';
    p.wobbleTick = this.tick;
    if (parent) {
      p.chainId = parent.chainId;
      p.depth = parent.depth + 1;
    } else {
      const c = { id: this.nextChainId++, startTick: this.tick, lastTick: this.tick, longest: 0, total: 0, lastPos: null };
      this.chains.set(c.id, c);
      p.chainId = c.id;
      p.depth = 1;
    }
    const c = this.chains.get(p.chainId);
    c.lastTick = this.tick;
    const pos = p.body.translation();
    this.events.push({ type: 'hit', id: p.id, depth: p.depth, chain: p.chainId, x: pos.x, z: pos.z });
  }

  _confirmFall(p) {
    p.state = 'fallen';
    const c = this.chains.get(p.chainId);
    if (!c) return;
    c.total++;
    c.lastTick = this.tick;
    if (p.depth > c.longest) {
      c.longest = p.depth;
      const pos = p.body.translation();
      c.lastPos = { x: pos.x, z: pos.z };
    }
  }

  _closeChain(c) {
    this.chains.delete(c.id);
    if (c.longest <= 0) return;
    const record = c.longest > this.dayBest;
    if (record) this.dayBest = c.longest;
    if (c.longest > this.bestEver) this.bestEver = c.longest;
    this.events.push({ type: 'chainEnd', chain: c.id, longest: c.longest, total: c.total, record, x: c.lastPos?.x ?? 0, z: c.lastPos?.z ?? 0 });
  }

  // ---------- 見習いの手（ボット）：寝ているドミノを箱へ片付ける ----------

  _thinkBot(h) {
    const inp = h.input;
    const park = h.brain.park;
    if (h.state !== 'hover') return;
    // 連鎖が倒れている間は待つ
    if (this.chains.size > 0) {
      inp.x = park.x; inp.z = park.z;
      return;
    }
    const near = (x, z) => Math.hypot(h.x - x, h.z - z) < 0.08;
    const target = h.carry < h.params.carryMax ? this._botTarget(h) : null;
    if (target) {
      const pos = target.body.translation();
      inp.x = pos.x; inp.z = pos.z;
      inp.yaw = yawOf(target.body.rotation());
      if (near(pos.x, pos.z)) {
        // 真上に来ても拾えない駒（ほかの駒の陰など）は、今日はもう狙わない
        const r = this.resolveTarget(h.id, pos.x, pos.z);
        if (r.type === 'pick' && r.piece === target) inp.pressSeq++;
        else target.botSkip = true;
      }
      return;
    }
    if (h.carry > 0) {
      inp.x = LAYOUT.box.x; inp.z = LAYOUT.box.z;
      if (near(inp.x, inp.z)) inp.altSeq++;
      return;
    }
    inp.x = park.x; inp.z = park.z;
  }

  _botTarget(h) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.pieces) {
      if (p.kind !== 'domino' || p.state !== 'fallen' || p.botSkip) continue;
      if ([...this.hands.values()].some((o) => o !== h && o.target?.piece === p)) continue;
      const pos = p.body.translation();
      const t = LAYOUT.tray;
      if (pos.x < t.x0 || pos.x > t.x1 || pos.z < t.z0 || pos.z > t.z1) continue;
      if (this.nearestStanding(pos.x, pos.z, 1.1)) continue;   // 立っている列の近くは触らない
      const d = Math.hypot(pos.x - h.x, pos.z - h.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // ---------- 1ステップ ----------

  step() {
    for (const cmd of this.commands.splice(0)) this._applyCommand(cmd);
    for (const h of this.hands.values()) if (h.bot) this._thinkBot(h);
    for (const h of this.hands.values()) this._updateHand(h);
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents(() => {});
    this._scanTilts();
    if (this.tick % 60 === 0) this._recoverLost();
    this.tick++;
  }

  // 台の外へ落ちた駒は箱（仕切り板は持ち主）へ戻す。在庫の数を狂わせないため
  _recoverLost() {
    for (const p of [...this.pieces]) {
      if (p.body.translation().y > -1) continue;
      this._removePiece(p);
      if (p.kind === 'domino') this.boxCount++;
      else {
        const owner = [...this.hands.values()].find((o) => o.owner === p.owner && !o.bot);
        if (owner) owner.pocket++;
      }
    }
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ---------- 描画・クライアント用の読み出し ----------

  handViews() {
    const out = [];
    for (const h of this.hands.values()) {
      const kind = h.held ? h.held.kind : 'domino';
      out.push({
        id: h.id, owner: h.owner, bot: h.bot, cuff: h.cuff,
        state: h.state, pose: h.pose, open: h.open,
        x: h.x, z: h.z, yaw: h.yaw, anchorY: h.y,
        originY: h.pose === 'poke' ? h.y + HAND.pokeLen : h.y + pieceH(kind),
        held: h.held ? { kind, y: h.y + SHAPES[kind].hy, color: h.held.color, first: h.held.first } : null,
        carry: h.carry, carryMax: h.params.carryMax, pocket: h.pocket, tool: h.tool,
        targetPiece: h.target?.piece?.id ?? null,
        bell: h.state === 'bell' ? Math.min(1, h.bellTicks / HAND.bellTicks) : 0,
        errandPhase: h.target?.phase ?? null,
      });
    }
    return out;
  }

  nearestStanding(x, z, radius) {
    let best = null;
    let bestD2 = radius * radius;
    this.world.collidersWithAabbIntersectingAabb({ x, y: 0.5, z }, { x: radius, y: 0.5, z: radius }, (c) => {
      const o = this.colliderOwner.get(c.handle);
      if (!o || o.kind !== 'piece' || o.p.kind !== 'domino' || o.p.state !== 'standing') return true;
      const p = o.p.body.translation();
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { p: o.p, x: p.x, z: p.z, dist: Math.sqrt(d2) };
      }
      return true;
    });
    return best;
  }

  // 向きを合わせる基準。自分が最後に置いたものが近ければそれ、なければ一番近い立っているもの
  orientAnchor(handId, x, z) {
    const h = this.hands.get(handId);
    const last = h && this.byId.get(h.lastPlaced);
    if (last && last.kind === 'domino' && last.state === 'standing') {
      const p = last.body.translation();
      const dist = Math.hypot(p.x - x, p.z - z);
      if (dist < PLACEMENT.neighborRadius) return { p: last, x: p.x, z: p.z, dist };
    }
    return this.nearestStanding(x, z, PLACEMENT.neighborRadius);
  }

  // 置こうとしている場所: outside（盆の外）/ blocked（指か駒が当たる）/ far（届かない）/ ok / free
  checkPlacement(x, z, yaw, kind = 'domino') {
    if (!this._insideTray(x, z, yaw, kind)) return { status: 'outside' };
    let blocked = false;
    this.world.intersectionsWithShape({ x, y: SHAPES[kind].hy, z }, yawQuat(yaw), this._probe[kind], (c) => {
      const o = this.colliderOwner.get(c.handle);
      if (o && o.kind === 'piece') {
        blocked = true;
        return false;
      }
      return true;
    });
    if (blocked) return { status: 'blocked' };
    if (kind !== 'domino') return { status: 'ok' };
    const n = this.nearestStanding(x, z, PLACEMENT.neighborRadius);
    if (!n) return { status: 'free' };
    return { status: n.dist > PLACEMENT.farSpacing ? 'far' : 'ok', dist: n.dist };
  }

  // ---------- 新しいゲーム・セーブ ----------

  // 最初の日は、盆にゆるいカーブで10個だけ立てておく（押してみたくなるように）
  newGame() {
    const rows = [];
    let x = -4.5, z = -1.2, th = Math.PI / 2 - 0.25;
    for (let i = 0; i < 10; i++) {
      rows.push([x, z, th]);
      x += Math.sin(th) * 0.6;
      z += Math.cos(th) * 0.6;
      th += 0.055;
    }
    rows.forEach(([px, pz, pyaw], i) => {
      const first = i === 0;
      const color = first ? FIRST_DOMINO_COLOR : colorFor(this.drawn++);
      this._spawnPiece('domino', { x: px, y: SHAPES.domino.hy + 0.0005, z: pz }, yawQuat(pyaw), color, { first });
    });
    this.firstPending = false;
    this.boxCount = this.stock - rows.length;
  }

  serialize() {
    return {
      v: 2,
      tick: this.tick,
      world: {
        stage: this.stage, stock: this.stock, dayBest: this.dayBest, bestEver: this.bestEver,
        day: this.day, drawn: this.drawn, restsThisStage: this.restsThisStage,
        firstPending: this.firstPending || [...this.hands.values()].some((h) => h.held?.first || h.nextFirst || h.bag.some((b) => b.first)),
        pieces: this.pieces.map((p) => {
          const pos = p.body.translation();
          const q = p.body.rotation();
          return [p.kind, +pos.x.toFixed(4), +pos.y.toFixed(4), +pos.z.toFixed(4),
            +q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5), +q.w.toFixed(5),
            p.color, p.state === 'fallen' ? 1 : 0, p.first ? 1 : 0, p.owner];
        }),
        dayLog: this.dayLog,
        photos: this.photos,
      },
      profiles: [...this.profiles.values()],
      hands: [...this.hands.values()].filter((h) => !h.bot).map((h) => ({ id: h.id, carry: h.carry })),
    };
  }

  // addPlayer より前に呼ぶ。壊れていたら false
  deserialize(data) {
    if (!data || data.v !== 2 || !data.world) return false;
    const w = data.world;
    const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
    this.stage = Math.min(Math.max(0, num(w.stage)), STOCK_STAGES.length - 1);
    this.stock = STOCK_STAGES[this.stage];
    this.dayBest = num(w.dayBest);
    this.bestEver = num(w.bestEver);
    this.day = num(w.day);
    this.restsThisStage = num(w.restsThisStage);
    this.drawn = num(w.drawn);
    this.firstPending = !!w.firstPending;
    this.dayLog = Array.isArray(w.dayLog) ? w.dayLog : [];
    this.photos = Array.isArray(w.photos) ? w.photos : [];
    for (const r of Array.isArray(w.pieces) ? w.pieces : []) {
      const [kind, x, y, z, qx, qy, qz, qw, color, fallen, first, owner] = r;
      if (!SHAPES[kind] || ![x, y, z, qx, qy, qz, qw].every(Number.isFinite)) continue;
      if (kind === 'domino' && this.onTableCount() >= this.stock) continue;
      const p = this._spawnPiece(kind, { x, y, z }, { x: qx, y: qy, z: qz, w: qw }, String(color), { first: !!first, owner: owner ?? null });
      if (p && fallen) p.state = 'fallen';
    }
    for (const prof of Array.isArray(data.profiles) ? data.profiles : []) {
      if (!prof?.id) continue;
      this.profiles.set(prof.id, { id: prof.id, name: prof.name || '', points: num(prof.points), upgrades: { ...(prof.upgrades || {}) } });
    }
    this._savedCarry = new Map((data.hands || []).map((h) => [h.id, num(h.carry)]));
    this.boxCount = this.stock - this.onTableCount();
    this.tick = num(data.tick);
    return true;
  }

  // deserialize のあと addPlayer してから呼ぶ：手に持っていた数を戻す
  restoreCarry() {
    for (const h of this.hands.values()) {
      const n = Math.min(this._savedCarry?.get(h.id) ?? 0, this.boxCount, h.params.carryMax);
      h.carry = n;
      this.boxCount -= n;
    }
    this._savedCarry = null;
  }
}
