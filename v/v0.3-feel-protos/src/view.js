// three.js による描画。物理の状態を読んで表示するだけで、物理には書き込まない。
// 部屋とちゃぶ台・卓上の物は room.js、手は hand-model.js。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DOMINO, STOPPER, LAYOUT } from './config.js';
import { HandModel } from './hand-model.js';
import { buildRoom } from './room.js';

const MAX_DOMINOES = 3200;
const MAX_STOPPERS = 64;
const GHOST_COLORS = { ok: '#fff4e0', free: '#fff4e0', far: '#e8b465', blocked: '#d9826a', outside: '#d9826a' };

// はじめの一枚の落書き（手描き風のにこにこ顔と矢印）
function makeDoodleTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f3ecdc';
  g.fillRect(0, 0, 128, 256);
  g.strokeStyle = '#3b3530';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(64, 92, 30, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.arc(64, 98, 15, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  g.fillStyle = '#3b3530';
  g.beginPath(); g.arc(53, 84, 4, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(75, 84, 4, 0, Math.PI * 2); g.fill();
  g.beginPath();
  g.moveTo(40, 170); g.lineTo(88, 170);
  g.moveTo(74, 156); g.lineTo(88, 170); g.lineTo(74, 184);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    const c = LAYOUT.camera;
    this.target = new THREE.Vector3(...c.target);
    this.home = this.target.clone();
    this.yaw = c.yaw;
    this.pitch = c.pitch;
    this.dist = c.dist;
    this.fit = 1;           // 縦長の画面ではちゃぶ台全体が入るように引く
    this.time = 0;
    this.apply(0);
  }
  zoom(f) {
    this.dist = THREE.MathUtils.clamp(this.dist * f, 9, 34);
  }
  // 画面基準で平行移動（dx: 右, dz: 奥）。ちゃぶ台から離れすぎないようにする
  pan(dx, dz) {
    this.target.x = THREE.MathUtils.clamp(this.target.x + dx, LAYOUT.table.x0, LAYOUT.table.x1);
    this.target.z = THREE.MathUtils.clamp(this.target.z - dz, LAYOUT.table.z0, LAYOUT.table.z1);
  }
  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }
  // しばらく別の場所（コルクボードなど）を見て、元に戻る
  glance(to, hold = 1.8, travel = 0.9) {
    this.glanceState = { to, hold, travel, t: 0 };
  }
  get glancing() {
    return !!this.glanceState;
  }
  apply(dt) {
    this.time += dt;
    // ごくわずかに揺らす（手持ちカメラのような呼吸）
    const sway = 0.004 * Math.sin(this.time * 0.37);
    const bob = 0.003 * Math.sin(this.time * 0.23 + 1.3);
    let tx = this.target.x, ty = this.target.y, tz = this.target.z;
    let pitch = this.pitch, dist = this.dist * this.fit;
    const g = this.glanceState;
    if (g) {
      g.t += dt;
      const total = g.travel * 2 + g.hold;
      if (g.t >= total) {
        this.glanceState = null;
      } else {
        const k = g.t < g.travel ? g.t / g.travel : g.t < g.travel + g.hold ? 1 : (total - g.t) / g.travel;
        const e = k * k * (3 - 2 * k);
        tx += (g.to.target[0] - tx) * e;
        ty += (g.to.target[1] - ty) * e;
        tz += (g.to.target[2] - tz) * e;
        pitch += (g.to.pitch - pitch) * e;
        dist += (g.to.dist - dist) * e;
      }
    }
    const yaw = this.yaw + sway;
    pitch += bob;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this.camera.position.set(tx + Math.sin(yaw) * cp * dist, ty + sp * dist, tz + Math.cos(yaw) * cp * dist);
    this.camera.lookAt(tx, ty, tz);
  }
}

export class View {
  constructor(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#15110f');
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
    this.rig = new CameraRig(this.camera);
    this.room = buildRoom(scene, renderer);
    // 手前からのごく弱い補助光（ランプが真上なので、ドミノの正面が暗くなりすぎないように）
    const front = new THREE.DirectionalLight('#ffd6a6', 0.45);
    front.position.set(0, 10, 30);
    front.target.position.set(0, 0, -2);
    scene.add(front, front.target);

    // ドミノ（色は1個ずつ）と仕切り板
    this.dominoGeo = new RoundedBoxGeometry(DOMINO.w, DOMINO.h, DOMINO.t, 2, 0.022);
    this.stopperGeo = new RoundedBoxGeometry(STOPPER.w, STOPPER.h, STOPPER.t, 2, 0.04);
    this.dominoMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
    this.stopperMat = new THREE.MeshStandardMaterial({ color: '#8a6446', roughness: 0.8 });
    this.dominoMesh = this._instanced(this.dominoGeo, this.dominoMat, MAX_DOMINOES);
    this.dominoMesh.setColorAt(0, new THREE.Color());
    this.stopperMesh = this._instanced(this.stopperGeo, this.stopperMat, MAX_STOPPERS);
    // はじめの一枚は落書きつきの別メッシュ
    const doodle = new THREE.MeshStandardMaterial({ map: makeDoodleTexture(), roughness: 0.55 });
    const plain = new THREE.MeshStandardMaterial({ color: '#f3ecdc', roughness: 0.55 });
    this.firstMats = [plain, plain, plain, plain, doodle, doodle];
    this.firstMeshes = [];
    this.colorVersion = -1;

    // 拾える駒の光（少し大きい半透明の箱）
    this.glow = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: '#ffd9a0', transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.glow.visible = false;
    scene.add(this.glow);

    // 置く場所のプレビュー（ドミノ用と仕切り板用）
    this.ghosts = {};
    for (const [kind, s] of [['domino', DOMINO], ['stopper', STOPPER]]) {
      const box = new THREE.BoxGeometry(s.w, s.h, s.t);
      const g = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: '#fff4e0', transparent: true, opacity: 0.16, depthWrite: false }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#fff4e0', transparent: true, opacity: 0.8 }));
      g.add(edges);
      g.userData.edges = edges;
      g.visible = false;
      scene.add(g);
      this.ghosts[kind] = g;
    }
    // ものさし：次に置く位置の目安（点線の枠）
    const gbox = new THREE.BoxGeometry(DOMINO.w, DOMINO.h, DOMINO.t);
    this.guide = new THREE.LineSegments(
      new THREE.EdgesGeometry(gbox),
      new THREE.LineDashedMaterial({ color: '#f6e6c8', dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.55 }),
    );
    this.guide.computeLineDistances();
    this.guide.visible = false;
    scene.add(this.guide);

    this.hands = new Map();
    this.heldMeshes = new Map();
    this.time = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._v = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  }

  _instanced(geo, mat, max) {
    const m = new THREE.InstancedMesh(geo, mat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.scene.add(m);
    return m;
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.rig.fit = Math.max(1, 1.45 / this.camera.aspect);
  }

  groundPoint(ndcX, ndcY) {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const out = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, out)) return null;
    const t = LAYOUT.table;
    // ちゃぶ台の少し外まで（それより外は手が行かない）
    out.x = THREE.MathUtils.clamp(out.x, t.x0 - 1, t.x1 + 1);
    out.z = THREE.MathUtils.clamp(out.z, t.z0 - 1, t.z1 + 1);
    return { x: out.x, z: out.z };
  }

  // ワールド座標 → 画面のピクセル座標（HTML のラベル用）
  project(x, y, z, width, height) {
    this._v.set(x, y, z).project(this.camera);
    return { x: (this._v.x + 1) / 2 * width, y: (1 - this._v.y) / 2 * height, behind: this._v.z > 1 };
  }

  _hand(hv) {
    let hm = this.hands.get(hv.id);
    if (!hm) {
      hm = new HandModel(hv.cuff);
      this.hands.set(hv.id, hm);
      this.scene.add(hm.group);
      const held = {
        domino: new THREE.Mesh(this.dominoGeo, new THREE.MeshStandardMaterial({ roughness: 0.55 })),
        stopper: new THREE.Mesh(this.stopperGeo, this.stopperMat),
        first: new THREE.Mesh(this.dominoGeo, this.firstMats),
      };
      for (const m of Object.values(held)) {
        m.castShadow = true;
        m.visible = false;
        this.scene.add(m);
      }
      this.heldMeshes.set(hv.id, held);
    }
    return hm;
  }

  sync(sim, dt) {
    this.time += dt;
    const dm = this.dominoMesh, sm = this.stopperMesh;
    let nd = 0, ns = 0, nf = 0;
    const recolor = this.colorVersion !== sim.version;
    for (const p of sim.pieces) {
      const t = p.body.translation();
      const q = p.body.rotation();
      this._p.set(t.x, t.y, t.z);
      this._q.set(q.x, q.y, q.z, q.w);
      if (p.kind === 'stopper') {
        if (ns >= MAX_STOPPERS) continue;
        this._m.compose(this._p, this._q, this._s);
        sm.setMatrixAt(ns++, this._m);
      } else if (p.first) {
        const fm = this._firstMesh(nf++);
        fm.position.copy(this._p);
        fm.quaternion.copy(this._q);
      } else {
        if (nd >= MAX_DOMINOES) continue;
        this._m.compose(this._p, this._q, this._s);
        dm.setMatrixAt(nd, this._m);
        if (recolor) dm.setColorAt(nd, this._c.set(p.color));
        nd++;
      }
    }
    if (recolor) {
      this.colorVersion = sim.version;
      if (dm.instanceColor) dm.instanceColor.needsUpdate = true;
    }
    dm.count = nd;
    sm.count = ns;
    dm.instanceMatrix.needsUpdate = true;
    sm.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.firstMeshes.length; i++) this.firstMeshes[i].visible = i < nf;

    // 手
    const seen = new Set();
    for (const hv of sim.handViews()) {
      seen.add(hv.id);
      const hm = this._hand(hv);
      hm.update(hv, dt);
      const held = this.heldMeshes.get(hv.id);
      for (const m of Object.values(held)) m.visible = false;
      if (hv.held) {
        const m = hv.held.kind === 'stopper' ? held.stopper : hv.held.first ? held.first : held.domino;
        m.visible = true;
        m.position.set(hv.x, hv.held.y, hv.z);
        m.rotation.set(0, hv.yaw, 0);
        if (m === held.domino) m.material.color.set(hv.held.color);
      }
    }
    for (const [id, hm] of this.hands) {
      if (!seen.has(id)) {
        this.scene.remove(hm.group);
        for (const m of Object.values(this.heldMeshes.get(id))) this.scene.remove(m);
        this.hands.delete(id);
        this.heldMeshes.delete(id);
      }
    }
    this.room.update(dt, this.time);
  }

  _firstMesh(i) {
    while (this.firstMeshes.length <= i) {
      const m = new THREE.Mesh(this.dominoGeo, this.firstMats);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      this.firstMeshes.push(m);
    }
    return this.firstMeshes[i];
  }

  // 拾える駒を光らせる（null で消す）
  setGlow(piece) {
    this.glow.visible = !!piece;
    if (!piece) return;
    const t = piece.body.translation();
    const q = piece.body.rotation();
    const s = piece.kind === 'stopper' ? STOPPER : DOMINO;
    this.glow.position.set(t.x, t.y, t.z);
    this.glow.quaternion.set(q.x, q.y, q.z, q.w);
    this.glow.scale.set(s.w + 0.08, s.h + 0.08, s.t + 0.08);
    this.glow.material.opacity = 0.2 + 0.1 * Math.sin(this.time * 5);
  }

  // 置く場所のプレビュー。status が null なら隠す
  setGhost(kind, x, z, yaw, status) {
    for (const [k, g] of Object.entries(this.ghosts)) g.visible = k === kind && !!status;
    if (!status) return;
    const g = this.ghosts[kind];
    const s = kind === 'stopper' ? STOPPER : DOMINO;
    g.position.set(x, s.h / 2 + 0.002, z);
    g.rotation.set(0, yaw, 0);
    const col = GHOST_COLORS[status] || GHOST_COLORS.ok;
    g.material.color.set(col);
    g.userData.edges.material.color.set(col);
    g.material.opacity = status === 'blocked' || status === 'outside' ? 0.3 : 0.14;
  }

  setGuide(pos) {
    this.guide.visible = !!pos;
    if (!pos) return;
    this.guide.position.set(pos.x, DOMINO.h / 2 + 0.003, pos.z);
    this.guide.rotation.set(0, pos.yaw, 0);
  }

  // カメラ（rig.apply）は main のループの頭で動かしてある
  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
