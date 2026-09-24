// 試作用の物理（「置く気持ちよさ」を比べるための軽い土台）。
// 本体（src/sim.js）の箱・運ぶ・呼び鈴・強化は入れていない。ドミノはいくらでも置ける。
// 置く瞬間の手触り（地面に合わせて立つ・急ぐとぐらつく・ちょうどいい間隔の手応え）と、
// 坂・段差・最初から置いてある物・3つのサイズを扱う。

import { WORLD, CHAIN, LAYOUT, HAND } from '../../src/config.js';

// ドミノの大きさ（比は本体と同じ 高さ:幅:厚み = 1 : 0.5 : 0.15）
export const SIZES = {
  s: { h: 0.62, w: 0.31, t: 0.093, label: '小' },
  m: { h: 1.0, w: 0.5, t: 0.15, label: '中' },
  l: { h: 1.6, w: 0.8, t: 0.24, label: '大' },
};

const FRICTION = 0.42;
const deg = (d) => (d * Math.PI) / 180;
const COS = {
  wobble: Math.cos(deg(CHAIN.wobbleDeg)),
  fall: Math.cos(deg(CHAIN.fallDeg)),
  restFall: Math.cos(deg(CHAIN.restFallDeg)),
  back: Math.cos(deg(CHAIN.backDeg)),
  tick: Math.cos(deg(CHAIN.tickDeg)),
};
const ZERO = { x: 0, y: 0, z: 0 };

// 手触りの数値
export const FEEL = {
  dropGap: 0.02,          // 地面のこれだけ上で離す（コトッと着地する）
  calmSpeed: 2.2,         // この速さ（単位/秒）までの手の動きは、ドミノに伝わらない（ゆっくりなら安定）
  carryVel: 0.2,          // それを超えた分のどれだけがドミノに乗るか（急ぐとぐらつく）
  carrySpin: 0.15,        // 同じく、前のめりの回転
  clickCooldown: 6,       // クリックで置ける最短の間隔（ティック）
  traceCooldown: 14,      // なぞり置きで1個落とすのにかかる時間（ティック）。速すぎると間隔が空く
  traceSpacing: 0.6,      // なぞり置きの間隔（高さに対する比）
  nice: [0.45, 0.72],     // 「ちょうどいい間隔」の範囲（前のドミノとの距離 ÷ 高さ）
  far: 0.95,              // これより離れると届かない
  follow: 40,             // 手がカーソルに追いつく速さ
};

export function yawQuat(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

export function qmul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

// 真上 (0,1,0) を法線 n に向ける回転
export function alignUp(n) {
  const d = n.y;
  if (d > 0.99999) return { x: 0, y: 0, z: 0, w: 1 };
  const s = Math.sqrt((1 + d) * 2);
  return { x: n.z / s, y: 0, z: -n.x / s, w: s / 2 };
}

// x 軸まわりの傾き
function tiltX(a) {
  return { x: Math.sin(a / 2), y: 0, z: 0, w: Math.cos(a / 2) };
}

const upYOf = (q) => 1 - 2 * (q.x * q.x + q.z * q.z);
// 回転したドミノの「上」方向と、地面の法線の内積（傾きの判定は置いた地面に対して行う）
function tiltCos(q, n) {
  const ux = 2 * (q.x * q.y - q.w * q.z);
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  const uz = 2 * (q.y * q.z + q.w * q.x);
  return ux * n.x + uy * n.y + uz * n.z;
}

const wrap = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// ---------- ステージを組むための部品 ----------

// (x0,z0) の高さ h0 から (x1,z1) の高さ h1 へ上る坂の板（上面が坂の面）
export function ramp(x0, z0, x1, z1, h0, h1, width = 2, color = '#b98a5e') {
  const dx = x1 - x0, dz = z1 - z0;
  const run = Math.hypot(dx, dz);
  const rise = h1 - h0;
  const len = Math.hypot(run, rise);
  const th = 0.3;
  const tilt = -Math.atan2(rise, run);
  const yaw = Math.atan2(dx, dz);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, cy = (h0 + h1) / 2;
  // 上面の中心が (cx, cy, cz) に来るよう、板の中心を法線方向に半分下げる
  const nx = Math.sin(yaw) * Math.sin(-tilt), ny = Math.cos(tilt), nz = Math.cos(yaw) * Math.sin(-tilt);
  return {
    type: 'box', name: 'ramp', color,
    x: cx - nx * th / 2, y: cy - ny * th / 2, z: cz - nz * th / 2,
    hx: width / 2, hy: th / 2, hz: len / 2,
    rot: qmul(yawQuat(yaw), tiltX(tilt)),
  };
}

// 上面の高さが top の台（本・積んだ板など）
export function block(x, z, hx, hz, top, color = '#8a6446', yaw = 0, name = 'block') {
  return { type: 'box', name, color, x, y: top / 2, z, hx, hy: top / 2, hz, rot: yawQuat(yaw) };
}

export class ProtoSim {
  constructor(RAPIER, stage = {}) {
    this.R = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: -WORLD.gravity, z: 0 });
    this.world.timestep = WORLD.dt;
    this.world.numSolverIterations = WORLD.solverIterations;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.tick = 0;
    this.nextId = 1;
    this.pieces = [];
    this.byId = new Map();
    this.byBody = new Map();
    this.owner = new Map();       // collider handle → { kind: 'ground'|'piece', p? }
    this.solids = [];             // 描画用：固定物の定義
    this.chains = new Map();
    this.nextChainId = 1;
    this.events = [];
    this.version = 0;
    this.stage = stage;
    this.hand = {
      x: 0, z: 2, vx: 0, vz: 0, yaw: Math.PI / 2, size: 'm',
      groundY: 0, down: 0, poke: false, pokeY: 0,
      lastPress: 0, lastPlaceTick: -1e9, lastPlaced: null, tracing: false, traceFrom: null,
    };
    this.input = { x: 0, z: 2, yaw: Math.PI / 2, primary: false, pressSeq: 0, poke: false, size: 'm', trace: false, color: '#e9e0cf' };
    this.colorFor = (size, n) => '#e9e0cf';
    this.drawn = 0;
    this._rayDown = new RAPIER.Ray({ x: 0, y: 40, z: 0 }, { x: 0, y: -1, z: 0 });
    this._createGround();
    this._createFinger();
    for (const s of stage.solids || []) this.addSolid(s);
    // 1回進めて、地面を探す光線が固定物に当たるようにする（それまでは当たり判定の索引が空）
    this.world.step(this.eventQueue);
    for (const p of stage.props || []) this.addProp(p);
    for (const d of stage.dominoes || []) this.placeAt(d.x, d.z, d.yaw, d.size || 'm', d.color, { byStage: true, meta: d.meta });
  }

  // ---------- 地面 ----------

  _fixed(def) {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.fixed().setTranslation(def.x, def.y, def.z).setRotation(def.rot || { x: 0, y: 0, z: 0, w: 1 }),
    );
    const c = this.world.createCollider(R.ColliderDesc.cuboid(def.hx, def.hy, def.hz).setFriction(def.friction ?? 0.7), body);
    this.owner.set(c.handle, { kind: 'ground' });
    return c;
  }

  _createGround() {
    const { table: t, tray } = LAYOUT;
    this._fixed({ x: (t.x0 + t.x1) / 2, y: -0.5, z: (t.z0 + t.z1) / 2, hx: (t.x1 - t.x0) / 2, hy: 0.5, hz: (t.z1 - t.z0) / 2 });
    const rt = tray.rimThickness, rh = tray.rimHeight;
    const cx = (tray.x0 + tray.x1) / 2, cz = (tray.z0 + tray.z1) / 2;
    const hw = (tray.x1 - tray.x0) / 2 + rt, hd = (tray.z1 - tray.z0) / 2;
    this._fixed({ x: cx, y: rh / 2, z: tray.z0 - rt / 2, hx: hw, hy: rh / 2, hz: rt / 2 });
    this._fixed({ x: cx, y: rh / 2, z: tray.z1 + rt / 2, hx: hw, hy: rh / 2, hz: rt / 2 });
    this._fixed({ x: tray.x0 - rt / 2, y: rh / 2, z: cz, hx: rt / 2, hy: rh / 2, hz: hd });
    this._fixed({ x: tray.x1 + rt / 2, y: rh / 2, z: cz, hx: rt / 2, hy: rh / 2, hz: hd });
  }

  // 固定物（坂・台・本など）。上にドミノを置ける
  addSolid(def) {
    this._fixed(def);
    this.solids.push(def);
  }

  // 動く物（積み木・ボール・鐘など）。ドミノに当たると 'propHit' が出る
  addProp(def) {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(def.x, def.y, def.z).setRotation(def.rot || { x: 0, y: 0, z: 0, w: 1 }),
    );
    const desc = def.type === 'ball'
      ? R.ColliderDesc.ball(def.r)
      : R.ColliderDesc.cuboid(def.hx, def.hy, def.hz);
    desc.setDensity(def.density ?? 1).setFriction(def.friction ?? 0.6).setRestitution(def.restitution ?? 0.05)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    const p = this._register(body, collider, 'prop', null, def.color || '#a3845f', { def, name: def.name || 'prop', home: this._pose(body) });
    return p;
  }

  // 真上から見た (x, z) の地面の高さと向き（固定物だけを見る）
  groundAt(x, z) {
    const R = this.R;
    this._rayDown.origin = { x, y: 40, z };
    const hit = this.world.castRayAndGetNormal(this._rayDown, 60, true, undefined, undefined, undefined, undefined,
      (c) => this.owner.get(c.handle)?.kind === 'ground');
    if (!hit) return null;
    const n = hit.normal;
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    return { y: 40 - hit.timeOfImpact, n: { x: n.x / len, y: n.y / len, z: n.z / len } };
  }

  // ---------- ドミノ ----------

  _register(body, collider, kind, size, color, extra = {}) {
    const p = {
      id: this.nextId++, kind, size, body, collider, color,
      state: 'standing', chainId: 0, depth: 0, wobbleTick: -1e9, rocked: false,
      byStage: false, n: { x: 0, y: 1, z: 0 },
      ...extra,
    };
    this.pieces.push(p);
    this.byId.set(p.id, p);
    this.byBody.set(body.handle, p);
    this.owner.set(collider.handle, { kind: 'piece', p });
    this.version++;
    return p;
  }

  _pose(body) {
    const t = body.translation();
    const q = body.rotation();
    return { pos: { x: t.x, y: t.y, z: t.z }, rot: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  // 地面に合わせてドミノを立てる。vel は離す瞬間の手の速さ（急ぐとぐらつく）
  placeAt(x, z, yaw, size = 'm', color = null, { vel = null, byStage = false, meta = null } = {}) {
    const g = this.groundAt(x, z);
    if (!g) return null;
    const s = SIZES[size];
    const R = this.R;
    const rot = qmul(alignUp(g.n), yawQuat(yaw));
    const lift = s.h / 2 + (byStage ? 0.0005 : FEEL.dropGap);
    const pos = { x: x + g.n.x * lift, y: g.y + g.n.y * lift, z: z + g.n.z * lift };
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    const collider = this.world.createCollider(
      R.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.t / 2).setFriction(FRICTION).setRestitution(0).setDensity(1), body,
    );
    if (vel) {
      // ゆっくりの手はそのまま静かに置ける。速い分だけ、手の動いていた向きへ滑って前のめりになる
      const sp = Math.hypot(vel.x, vel.z);
      const extra = Math.max(0, sp - FEEL.calmSpeed);
      if (extra > 0) {
        const ux = vel.x / sp, uz = vel.z / sp;
        body.setLinvel({ x: ux * extra * FEEL.carryVel, y: 0, z: uz * extra * FEEL.carryVel }, true);
        body.setAngvel({ x: uz * extra * FEEL.carrySpin, y: 0, z: -ux * extra * FEEL.carrySpin }, true);
      }
    }
    const c = color || this.colorFor(size, this.drawn++);
    const p = this._register(body, collider, 'domino', size, c, {
      byStage, meta, n: g.n,
      home: { pos, rot },
    });
    return p;
  }

  _removePiece(p) {
    const pos = p.body.translation();
    const near = [];
    this.world.collidersWithAabbIntersectingAabb(pos, { x: 2, y: 2, z: 2 }, (c) => {
      const o = this.owner.get(c.handle);
      if (o?.kind === 'piece' && o.p !== p) near.push(o.p);
      return true;
    });
    this.owner.delete(p.collider.handle);
    this.byBody.delete(p.body.handle);
    this.world.removeRigidBody(p.body);
    this.pieces.splice(this.pieces.indexOf(p), 1);
    this.byId.delete(p.id);
    for (const q of near) q.body.wakeUp();
    this.version++;
  }

  // カーソルの下の駒（ドミノ・動く物）
  pieceAt(x, z, radius = 0.3) {
    let best = null, bestD = Infinity;
    this.world.collidersWithAabbIntersectingAabb({ x, y: 2, z }, { x: radius, y: 4, z: radius }, (c) => {
      const o = this.owner.get(c.handle);
      if (o?.kind !== 'piece') return true;
      const t = o.p.body.translation();
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < bestD) { bestD = d; best = o.p; }
      return true;
    });
    return best;
  }

  // 片付ける：カーソルの下のドミノを1つ取り除く
  pickAt(x, z) {
    const p = this.pieceAt(x, z);
    if (!p || p.kind !== 'domino') return false;
    this._removePiece(p);
    this.events.push({ type: 'pick', x, z });
    return true;
  }

  // 試作用：全部のドミノと物を、置いたときの姿勢に戻す
  resetAll() {
    for (const p of this.pieces) {
      if (!p.home) continue;
      p.body.setTranslation(p.home.pos, true);
      p.body.setRotation(p.home.rot, true);
      p.body.setLinvel(ZERO, true);
      p.body.setAngvel(ZERO, true);
      p.state = 'standing';
      p.chainId = 0;
      p.depth = 0;
      p.rocked = false;
    }
    this.chains.clear();
    this.events.push({ type: 'reset' });
  }

  // 試作用：自分で置いたドミノを全部消す（最初からあるものは残す）
  clearMine() {
    for (const p of [...this.pieces]) if (p.kind === 'domino' && !p.byStage) this._removePiece(p);
    this.hand.lastPlaced = null;
  }

  undo() {
    const mine = this.pieces.filter((p) => p.kind === 'domino' && !p.byStage);
    const last = mine[mine.length - 1];
    if (last) this._removePiece(last);
  }

  // 置こうとしている場所の判定：outside / blocked / far / ok / nice / free
  checkPlacement(x, z, yaw, size) {
    const g = this.groundAt(x, z);
    const t = LAYOUT.tray;
    if (!g || x < t.x0 || x > t.x1 || z < t.z0 || z > t.z1) return { status: 'outside' };
    const s = SIZES[size];
    const rot = qmul(alignUp(g.n), yawQuat(yaw));
    const lift = s.h / 2 + 0.02;
    const pos = { x: x + g.n.x * lift, y: g.y + g.n.y * lift, z: z + g.n.z * lift };
    let blocked = false;
    this._probes ||= {};
    const probe = (this._probes[size] ||= new this.R.Cuboid(s.w / 2 + 0.01, s.h / 2 - 0.03, s.t / 2 + 0.04));
    this.world.intersectionsWithShape(pos, rot, probe, (c) => {
      const o = this.owner.get(c.handle);
      if (o?.kind === 'piece') { blocked = true; return false; }
      if (o?.kind === 'ground' && g.n.y > 0.999) { blocked = true; return false; }  // 段差の壁にめり込む
      return true;
    });
    if (blocked) return { status: 'blocked', g, rot, pos };
    const nb = this.nearestStanding(x, z, s.h * 1.6);
    if (!nb) return { status: 'free', g, rot, pos };
    const ratio = nb.dist / Math.max(s.h, SIZES[nb.p.size].h);
    const status = ratio > FEEL.far ? 'far' : ratio >= FEEL.nice[0] && ratio <= FEEL.nice[1] ? 'nice' : 'ok';
    return { status, g, rot, pos, dist: nb.dist, ratio };
  }

  nearestStanding(x, z, radius) {
    let best = null;
    for (const p of this.pieces) {
      if (p.kind !== 'domino' || p.state !== 'standing') continue;
      const t = p.body.translation();
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < radius && (!best || d < best.dist)) best = { p, x: t.x, z: t.z, dist: d };
    }
    return best;
  }

  // 向きの自動合わせ：直前に置いたドミノ（なければ一番近い立っているドミノ）から離れる向き
  autoYaw(x, z, fallback) {
    const last = this.hand.lastPlaced && this.byId.get(this.hand.lastPlaced);
    let from = null;
    if (last && last.state === 'standing') {
      const t = last.body.translation();
      if (Math.hypot(t.x - x, t.z - z) < 2.4) from = { x: t.x, z: t.z };
    }
    if (!from) {
      const nb = this.nearestStanding(x, z, 2.0);
      if (nb) from = nb;
    }
    if (!from || Math.hypot(x - from.x, z - from.z) < 0.15) return fallback;
    return Math.atan2(x - from.x, z - from.z);
  }

  // ---------- 手 ----------

  _createFinger() {
    const R = this.R;
    this.fingerBody = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 10, 0));
    const r = HAND.pokeRadius;
    const half = 0.4;
    this.fingerCollider = this.world.createCollider(R.ColliderDesc.capsule(half - r, r).setTranslation(0, -half, 0), this.fingerBody);
    this.fingerCollider.setEnabled(false);
  }

  setInput(input) {
    Object.assign(this.input, input);
  }

  _updateHand() {
    const h = this.hand;
    const inp = this.input;
    const dt = WORLD.dt;
    // 手はカーソルにすばやく追いつく。指を下ろしている間は速さに上限（すり抜け防止）
    const k = 1 - Math.exp(-FEEL.follow * dt);
    let mx = (inp.x - h.x) * k, mz = (inp.z - h.z) * k;
    const max = (h.poke ? HAND.maxSpeedLow : 80) * dt;
    const len = Math.hypot(mx, mz);
    if (len > max) { mx *= max / len; mz *= max / len; }
    h.x += mx;
    h.z += mz;
    // 速さ（少しならす）
    h.vx += (mx / dt - h.vx) * 0.35;
    h.vz += (mz / dt - h.vz) * 0.35;
    h.size = inp.size;
    const g = this.groundAt(h.x, h.z);
    const targetGround = g ? g.y : 0;
    h.groundY += (targetGround - h.groundY) * 0.25;
    h.down = Math.max(0, h.down - dt * 7);
    if (Math.abs(wrap(inp.yaw - h.yaw)) > 1e-4) h.yaw = wrap(h.yaw + wrap(inp.yaw - h.yaw) * 0.35);

    // 指で押す
    h.poke = inp.poke;
    const tipTarget = h.groundY + SIZES[h.size].h * 0.62;
    const tipTop = h.groundY + SIZES.l.h + 0.6;
    h.pokeY = h.poke ? Math.max(tipTarget, (h.pokeY || tipTop) - 7 * dt) : Math.min(tipTop, (h.pokeY || tipTop) + 9 * dt);
    this.fingerCollider.setEnabled(h.pokeY < tipTop - 0.01);
    this.fingerBody.setNextKinematicTranslation({ x: h.x, y: h.pokeY + 0.8, z: h.z });

    if (h.poke) return;
    const press = inp.pressSeq !== h.lastPress;
    h.lastPress = inp.pressSeq;
    const vel = { x: h.vx, z: h.vz };
    if (press && this.tick - h.lastPlaceTick >= FEEL.clickCooldown) {
      this._placeFromHand(h.x, h.z, h.yaw, vel);
      h.traceFrom = { x: h.x, z: h.z };
    }
    // なぞり置き：押している間、手が一定の距離進むごとに1個落とす（落とすのに時間がかかる）
    if (inp.trace && inp.primary && h.traceFrom) {
      const s = SIZES[h.size];
      const d = Math.hypot(h.x - h.traceFrom.x, h.z - h.traceFrom.z);
      if (d >= s.h * FEEL.traceSpacing && this.tick - h.lastPlaceTick >= FEEL.traceCooldown) {
        const yaw = Math.atan2(h.x - h.traceFrom.x, h.z - h.traceFrom.z);
        this._placeFromHand(h.x, h.z, yaw, vel);
        h.traceFrom = { x: h.x, z: h.z };
        h.yaw = yaw;
      }
    }
    if (!inp.primary) h.traceFrom = null;
  }

  _placeFromHand(x, z, yaw, vel) {
    const h = this.hand;
    const check = this.checkPlacement(x, z, yaw, h.size);
    if (check.status === 'outside') return null;
    const p = this.placeAt(x, z, yaw, h.size, this.input.color || null, { vel });
    if (!p) return null;
    h.lastPlaceTick = this.tick;
    h.lastPlaced = p.id;
    h.down = 1;
    const speed = Math.hypot(vel.x, vel.z);
    this.events.push({
      type: 'place', id: p.id, x, z, yaw, size: h.size, status: check.status,
      ratio: check.ratio ?? null, speed, y: check.g?.y ?? 0,
    });
    return p;
  }

  // ---------- 連鎖の数え方（本体と同じ：倒れ始めたドミノの親をたどる） ----------

  _scanTilts() {
    const moving = [];
    this.world.forEachActiveRigidBody((body) => {
      const p = this.byBody.get(body.handle);
      if (!p || p.kind !== 'domino' || p.state === 'fallen') return;
      moving.push(p, tiltCos(body.rotation(), p.n));
    });
    for (let i = 0; i < moving.length; i += 2) {
      const p = moving[i];
      const c = moving[i + 1];
      if (p.state === 'standing') {
        if (c < COS.wobble) this._startWobble(p);
        else if (!p.rocked && c < COS.tick) {
          p.rocked = true;
          const t = p.body.translation();
          this.events.push({ type: 'rock', id: p.id, x: t.x, z: t.z, size: p.size });
        }
      }
      if (p.state === 'wobbling') {
        const av = p.body.angvel();
        const resting = p.body.isSleeping() || Math.hypot(av.x, av.y, av.z) < 0.05;
        if (c < COS.fall || (c < COS.restFall && resting)) this._confirmFall(p);
        else if (c > COS.back) { p.state = 'standing'; p.chainId = 0; p.depth = 0; }
      }
    }
    for (const ch of [...this.chains.values()]) {
      if (this.tick - ch.lastTick > CHAIN.closeTicks) this._closeChain(ch);
    }
  }

  _startWobble(p) {
    let parent = null;
    this.world.contactPairsWith(p.collider, (other) => {
      const o = this.owner.get(other.handle);
      if (o?.kind !== 'piece' || o.p.kind !== 'domino') return;
      const q = o.p;
      if (q.state === 'standing' || !this.chains.has(q.chainId)) return;
      if (this.tick - q.wobbleTick > CHAIN.parentWindowTicks) return;
      let touching = false;
      this.world.contactPair(p.collider, other, (m) => { if (m.numContacts() > 0) touching = true; });
      if (touching && (!parent || q.depth > parent.depth)) parent = q;
    });
    p.state = 'wobbling';
    p.wobbleTick = this.tick;
    if (parent) {
      p.chainId = parent.chainId;
      p.depth = parent.depth + 1;
    } else {
      const ch = { id: this.nextChainId++, lastTick: this.tick, longest: 0, total: 0, order: [] };
      this.chains.set(ch.id, ch);
      p.chainId = ch.id;
      p.depth = 1;
    }
    const ch = this.chains.get(p.chainId);
    ch.lastTick = this.tick;
    ch.order.push(p.id);
    const t = p.body.translation();
    this.events.push({ type: 'hit', id: p.id, depth: p.depth, chain: p.chainId, x: t.x, y: t.y, z: t.z, size: p.size, meta: p.meta, color: p.color });
  }

  _confirmFall(p) {
    p.state = 'fallen';
    const ch = this.chains.get(p.chainId);
    if (!ch) return;
    ch.total++;
    ch.lastTick = this.tick;
    if (p.depth > ch.longest) {
      ch.longest = p.depth;
      const t = p.body.translation();
      ch.lastPos = { x: t.x, z: t.z };
    }
    this.events.push({ type: 'fall', id: p.id, chain: p.chainId, depth: p.depth });
  }

  _closeChain(ch) {
    this.chains.delete(ch.id);
    if (ch.longest <= 0) return;
    this.events.push({ type: 'chainEnd', chain: ch.id, longest: ch.longest, total: ch.total, order: ch.order, x: ch.lastPos?.x ?? 0, z: ch.lastPos?.z ?? 0 });
  }

  // ---------- 1ステップ ----------

  step() {
    this._updateHand();
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((a, b, started) => {
      if (!started) return;
      const oa = this.owner.get(a), ob = this.owner.get(b);
      for (const [o, other] of [[oa, ob], [ob, oa]]) {
        if (o?.kind === 'piece' && o.p.kind === 'prop' && other?.kind === 'piece') {
          const t = o.p.body.translation();
          this.events.push({ type: 'propHit', id: o.p.id, name: o.p.name, x: t.x, y: t.y, z: t.z });
        }
      }
    });
    this._scanTilts();
    // 台の外へ落ちた駒は消す
    if (this.tick % 60 === 0) {
      for (const p of [...this.pieces]) if (p.body.translation().y < -3 && p.kind === 'domino') this._removePiece(p);
    }
    this.tick++;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // 描画用：手の見た目
  handView() {
    const h = this.hand;
    const s = SIZES[h.size];
    const hoverAnchor = h.groundY + SIZES.l.h + 0.35;          // 持っているドミノの底の高さ（大きいドミノの上も通れる）
    const anchor = hoverAnchor - (hoverAnchor - (h.groundY + FEEL.dropGap)) * Math.sin(Math.min(1, h.down) * Math.PI / 2) * h.down;
    const poking = h.pokeY < h.groundY + SIZES.l.h + 0.59;
    return {
      x: h.x, z: h.z, yaw: h.yaw,
      pose: poking ? 'poke' : 'hold',
      open: h.down > 0.5 ? 1 : 0,
      originY: poking ? h.pokeY + HAND.pokeLen : anchor + s.h,
      held: poking ? null : { size: h.size, y: anchor + s.h / 2, color: this.input.color || this.colorFor(h.size, this.drawn) },
      speed: Math.hypot(h.vx, h.vz),
    };
  }
}
