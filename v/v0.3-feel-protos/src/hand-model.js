// プレイヤーの「手」の見た目。白い手袋＋袖口の色でプレイヤーを見分ける。
// 原点は物理側の手の原点（持つポーズではドミノ上端の中心）。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

// 各指は [付け根, 第二関節, 指先]
const HOLD = {
  palm: { pos: v(0, 0.30, -0.03), rx: -0.22 },
  cuff: { pos: v(0, 0.44, -0.33), rx: -1.05 },
  index: [v(0.13, 0.27, 0.16), v(0.14, 0.13, 0.24), v(0.10, -0.08, 0.13)],
  middle: [v(-0.02, 0.28, 0.18), v(-0.02, 0.12, 0.26), v(-0.03, -0.08, 0.13)],
  ring: [v(-0.16, 0.27, 0.14), v(-0.19, 0.13, 0.22), v(-0.17, 0.03, 0.16)],
  thumb: [v(0.21, 0.24, -0.12), v(0.15, 0.07, -0.21), v(0.05, -0.08, -0.135)],
};

const OPEN = {
  palm: HOLD.palm,
  cuff: HOLD.cuff,
  index: [HOLD.index[0], v(0.14, 0.15, 0.29), v(0.11, -0.04, 0.22)],
  middle: [HOLD.middle[0], v(-0.02, 0.14, 0.31), v(-0.03, -0.04, 0.22)],
  ring: [HOLD.ring[0], v(-0.19, 0.15, 0.26), v(-0.18, 0.02, 0.23)],
  thumb: [HOLD.thumb[0], v(0.16, 0.08, -0.27), v(0.07, -0.04, -0.22)],
};

const POKE = {
  palm: { pos: v(0, 0.22, -0.12), rx: -0.5 },
  cuff: { pos: v(0, 0.40, -0.42), rx: -0.95 },
  index: [v(0.02, 0.14, 0.06), v(0.01, -0.28, 0.03), v(0.0, -0.695, 0.0)],
  middle: [v(-0.1, 0.16, 0.08), v(-0.11, -0.02, 0.17), v(-0.1, -0.07, 0.03)],
  ring: [v(-0.22, 0.15, 0.04), v(-0.23, 0.0, 0.13), v(-0.21, -0.05, 0.0)],
  thumb: [v(0.18, 0.12, -0.08), v(0.17, -0.02, 0.03), v(0.08, -0.07, 0.09)],
};

const FINGERS = [
  { key: 'index', r: 0.055 },
  { key: 'middle', r: 0.056 },
  { key: 'ring', r: 0.05 },
  { key: 'thumb', r: 0.06 },
];

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class HandModel {
  constructor(cuffColor) {
    this.group = new THREE.Group();
    this.glove = new THREE.MeshStandardMaterial({ color: '#fbfbf7', roughness: 0.72 });
    this.cuffMat = new THREE.MeshStandardMaterial({ color: cuffColor, roughness: 0.6 });

    this.palm = new THREE.Mesh(new RoundedBoxGeometry(0.56, 0.17, 0.46, 3, 0.07), this.glove);
    this.cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.23, 0.2, 20), this.cuffMat);
    this.group.add(this.palm, this.cuff);

    const joint = new THREE.SphereGeometry(1, 14, 10);
    const bone = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
    this.fingers = FINGERS.map(({ key, r }) => {
      const f = { key, r, joints: [], bones: [] };
      for (let i = 0; i < 2; i++) {
        const s = new THREE.Mesh(joint, this.glove);
        s.scale.setScalar(r);
        f.joints.push(s);
        this.group.add(s);
      }
      for (let i = 0; i < 2; i++) {
        const c = new THREE.Mesh(bone, this.glove);
        f.bones.push(c);
        this.group.add(c);
      }
      return f;
    });
    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });

    this.pokeW = 0;
    this.open = 0;
    this._pts = [v(0, 0, 0), v(0, 0, 0), v(0, 0, 0)];
    this._apply();
  }

  setCuff(color) {
    this.cuffMat.color.set(color);
  }

  // hv: sim.handViews() の1要素
  update(hv, dt) {
    const targetPoke = hv.pose === 'poke' ? 1 : 0;
    this.pokeW += (targetPoke - this.pokeW) * (1 - Math.exp(-18 * dt));
    this.open = hv.open;
    this.group.position.set(hv.x, hv.originY, hv.z);
    this.group.rotation.set(0, hv.yaw, 0);
    this._apply();
  }

  _mix(key, i, out) {
    const a = HOLD[key][i], b = OPEN[key][i], c = POKE[key][i];
    out.copy(a).lerp(b, this.open).lerp(c, this.pokeW);
    return out;
  }

  _apply() {
    const pw = this.pokeW;
    const palmPos = _a.copy(HOLD.palm.pos).lerp(POKE.palm.pos, pw);
    this.palm.position.copy(palmPos);
    this.palm.rotation.x = HOLD.palm.rx + (POKE.palm.rx - HOLD.palm.rx) * pw;
    this.cuff.position.copy(_a.copy(HOLD.cuff.pos).lerp(POKE.cuff.pos, pw));
    this.cuff.rotation.x = HOLD.cuff.rx + (POKE.cuff.rx - HOLD.cuff.rx) * pw;

    for (const f of this.fingers) {
      const p = this._pts;
      for (let i = 0; i < 3; i++) this._mix(f.key, i, p[i]);
      f.joints[0].position.copy(p[1]);
      f.joints[1].position.copy(p[2]);
      for (let i = 0; i < 2; i++) {
        const bone = f.bones[i];
        _a.copy(p[i]);
        _b.copy(p[i + 1]);
        _dir.subVectors(_b, _a);
        const len = _dir.length();
        bone.position.copy(_a).addScaledVector(_dir, 0.5);
        bone.scale.set(f.r, len, f.r);
        bone.quaternion.setFromUnitVectors(UP, _dir.normalize());
      }
    }
  }
}
