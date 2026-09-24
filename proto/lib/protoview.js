// 試作用の描画。部屋（room.js）・手（hand-model.js）・カメラ（view.js の CameraRig）は本体のものを使う。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LAYOUT } from '../../src/config.js';
import { HandModel } from '../../src/hand-model.js';
import { buildRoom } from '../../src/room.js';
import { CameraRig } from '../../src/view.js';
import { SIZES } from './protosim.js';

const MAX_PER_SIZE = 1500;
const GHOST = { ok: '#fff4e0', free: '#fff4e0', nice: '#ffd68a', far: '#e8b465', blocked: '#d9826a', outside: '#d9826a' };

export class ProtoView {
  constructor(canvas, sim, { dist = 15, pitch = 0.9 } = {}) {
    this.sim = sim;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;
    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    this.rig = new CameraRig(this.camera);
    this.rig.dist = dist;
    this.rig.pitch = pitch;
    this.room = buildRoom(scene, renderer);
    const front = new THREE.DirectionalLight('#ffd6a6', 0.45);
    front.position.set(0, 10, 30);
    front.target.position.set(0, 0, -2);
    scene.add(front, front.target);

    // 地面の当たり（見えない床＋固定物）
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ visible: false }));
    plane.rotation.x = -Math.PI / 2;
    scene.add(plane);
    this.groundMeshes = [plane];
    for (const s of sim.solids) {
      const m = new THREE.Mesh(
        new RoundedBoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2, 2, Math.min(0.04, s.hy * 0.5, s.hx * 0.5)),
        new THREE.MeshStandardMaterial({ color: s.color || '#8a6446', roughness: 0.75 }),
      );
      m.position.set(s.x, s.y, s.z);
      if (s.rot) m.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      this.groundMeshes.push(m);
    }

    // ドミノ（サイズごと）
    this.geos = {};
    this.meshes = {};
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
    for (const [k, s] of Object.entries(SIZES)) {
      this.geos[k] = new RoundedBoxGeometry(s.w, s.h, s.t, 2, Math.min(0.022, s.t * 0.15));
      const m = new THREE.InstancedMesh(this.geos[k], mat, MAX_PER_SIZE);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      scene.add(m);
      this.meshes[k] = m;
    }
    this.propMeshes = new Map();

    // 手と、手に持っているドミノ
    this.hand = new HandModel('#c98b5f');
    scene.add(this.hand.group);
    this.held = {};
    for (const k of Object.keys(SIZES)) {
      const m = new THREE.Mesh(this.geos[k], new THREE.MeshStandardMaterial({ roughness: 0.55 }));
      m.castShadow = true;
      m.visible = false;
      scene.add(m);
      this.held[k] = m;
    }

    // 置く場所の見本
    this.ghosts = {};
    for (const [k, s] of Object.entries(SIZES)) {
      const box = new THREE.BoxGeometry(s.w, s.h, s.t);
      const g = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: '#fff4e0', transparent: true, opacity: 0.16, depthWrite: false }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: '#fff4e0', transparent: true, opacity: 0.8 }));
      g.add(edges);
      g.userData.edges = edges;
      g.visible = false;
      scene.add(g);
      this.ghosts[k] = g;
    }

    // 波紋
    this.rings = [];
    const ringGeo = new THREE.RingGeometry(0.8, 1, 40);
    for (let i = 0; i < 32; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      m.userData = { t: 0, life: 1, r0: 0.2, r1: 1, a: 1 };
      scene.add(m);
      this.rings.push(m);
    }

    this.flashes = new Map();   // ドミノ id → { t, life, color }
    this.colorVersion = -1;
    this.time = 0;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._c = new THREE.Color();
    this._c2 = new THREE.Color();
    this._v = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.follow = 0.35;         // カメラの注視点が手の方へ寄る割合
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.rig.fit = Math.max(1, 1.45 / this.camera.aspect);
  }

  // 画面の点 → 地面（床・坂・台）の上の点
  groundPoint(ndcX, ndcY) {
    this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this.raycaster.intersectObjects(this.groundMeshes, false);
    if (!hits.length) return null;
    const p = hits[0].point;
    const t = LAYOUT.table;
    return { x: THREE.MathUtils.clamp(p.x, t.x0 - 1, t.x1 + 1), z: THREE.MathUtils.clamp(p.z, t.z0 - 1, t.z1 + 1) };
  }

  project(x, y, z, width, height) {
    this._v.set(x, y, z).project(this.camera);
    return { x: (this._v.x + 1) / 2 * width, y: (1 - this._v.y) / 2 * height };
  }

  // カメラを手元へ少し寄せる
  followHand(dt) {
    const h = this.sim.hand;
    const tr = LAYOUT.tray;
    const cx = (tr.x0 + tr.x1) / 2, cz = (tr.z0 + tr.z1) / 2 + 1.5;
    const tx = cx + (h.x - cx) * this.follow;
    const tz = cz + (h.z - cz) * this.follow;
    const k = 1 - Math.exp(-2.5 * dt);
    this.rig.target.x += (tx - this.rig.target.x) * k;
    this.rig.target.z += (tz - this.rig.target.z) * k;
  }

  flash(id, color = '#fff2c8', life = 0.45) {
    this.flashes.set(id, { t: 0, life, color });
  }

  ring(x, y, z, { color = '#fff4e0', r0 = 0.15, r1 = 0.8, life = 0.5, a = 0.8, n = null } = {}) {
    const r = this.rings.find((m) => !m.visible) || this.rings[0];
    r.visible = true;
    r.position.set(x, y + 0.01, z);
    // 地面の向きに寝かせる
    const nrm = n ? new THREE.Vector3(n.x, n.y, n.z) : new THREE.Vector3(0, 1, 0);
    r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nrm);
    r.material.color.set(color);
    Object.assign(r.userData, { t: 0, life, r0, r1, a });
    r.scale.setScalar(r0);
  }

  setGhost(size, check) {
    for (const [k, g] of Object.entries(this.ghosts)) g.visible = k === size && !!check && !!check.pos;
    if (!check || !check.pos) return;
    const g = this.ghosts[size];
    g.position.set(check.pos.x, check.pos.y, check.pos.z);
    g.quaternion.set(check.rot.x, check.rot.y, check.rot.z, check.rot.w);
    const col = GHOST[check.status] || GHOST.ok;
    g.material.color.set(col);
    g.userData.edges.material.color.set(col);
    g.material.opacity = check.status === 'blocked' ? 0.3 : check.status === 'nice' ? 0.24 : 0.14;
  }

  sync(dt) {
    this.time += dt;
    const sim = this.sim;
    const counts = { s: 0, m: 0, l: 0 };
    const recolor = this.colorVersion !== sim.version || this.flashes.size > 0;
    for (const p of sim.pieces) {
      const t = p.body.translation();
      const q = p.body.rotation();
      if (p.kind === 'prop') {
        let m = this.propMeshes.get(p.id);
        if (!m) {
          const d = p.def;
          const geo = d.type === 'ball' ? new THREE.SphereGeometry(d.r, 24, 16) : new RoundedBoxGeometry(d.hx * 2, d.hy * 2, d.hz * 2, 2, Math.min(0.04, d.hy * 0.4));
          m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.color, roughness: d.metal ? 0.3 : 0.7, metalness: d.metal ? 0.8 : 0 }));
          m.castShadow = true;
          m.receiveShadow = true;
          this.scene.add(m);
          this.propMeshes.set(p.id, m);
        }
        m.position.set(t.x, t.y, t.z);
        m.quaternion.set(q.x, q.y, q.z, q.w);
        continue;
      }
      const mesh = this.meshes[p.size];
      const i = counts[p.size]++;
      if (i >= MAX_PER_SIZE) continue;
      this._p.set(t.x, t.y, t.z);
      this._q.set(q.x, q.y, q.z, q.w);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
      if (recolor) {
        this._c.set(p.color);
        const f = this.flashes.get(p.id);
        if (f) this._c.lerp(this._c2.set(f.color), 0.85 * (1 - f.t / f.life));
        mesh.setColorAt(i, this._c);
      }
    }
    for (const [k, mesh] of Object.entries(this.meshes)) {
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
      if (recolor && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.colorVersion = sim.version;
    for (const [id, f] of this.flashes) {
      f.t += dt;
      if (f.t >= f.life) this.flashes.delete(id);
    }
    // 消えた動く物
    for (const [id, m] of this.propMeshes) {
      if (!sim.byId.has(id)) { this.scene.remove(m); this.propMeshes.delete(id); }
    }

    // 手
    const hv = sim.handView();
    this.hand.update({ ...hv, open: hv.open }, dt);
    for (const [k, m] of Object.entries(this.held)) {
      m.visible = !!hv.held && hv.held.size === k;
      if (m.visible) {
        m.position.set(hv.x, hv.held.y, hv.z);
        m.rotation.set(0, hv.yaw, 0);
        m.material.color.set(hv.held.color);
      }
    }

    // 波紋
    for (const r of this.rings) {
      if (!r.visible) continue;
      const u = r.userData;
      u.t += dt;
      const k = u.t / u.life;
      if (k >= 1) { r.visible = false; continue; }
      const e = 1 - (1 - k) * (1 - k);
      r.scale.setScalar(u.r0 + (u.r1 - u.r0) * e);
      r.material.opacity = u.a * (1 - k);
    }
    this.room.update(dt, this.time);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
