// 見た目の部品：下書きの点線（とぎれの目じるし）、盆に書いた文字、本の小口、ものさしの目盛り、
// 鐘の形、ほたるのような光の粒、「できた」の大きな文字。
// 画像ファイルは使わず、すべて canvas と three.js の形で作る。

import * as THREE from 'three';

const HAND_FONT = '"Yomogi", "Hiragino Maru Gothic ProN", "Zen Kaku Gothic New", sans-serif';
const UP = new THREE.Vector3(0, 1, 0);

// ---------- 画面の文字の見た目（この試作だけで使う分） ----------

export function injectStyle() {
  if (document.getElementById('feel-style')) return;
  const st = document.createElement('style');
  st.id = 'feel-style';
  st.textContent = `
    .p-float.f-soft { font-size: 24px; color: var(--lamp); }
    .p-float.f-note { font-size: 19px; color: var(--ink-soft); }
    .f-done {
      position: fixed; inset: 0; z-index: 35; display: grid; place-items: center;
      pointer-events: none; opacity: 0; text-align: center; padding: 16px;
    }
    .f-done-big {
      font-family: var(--hand); font-size: clamp(76px, 17vw, 200px); line-height: 1;
      color: var(--lamp); letter-spacing: 0.08em;
      text-shadow: 0 0 36px rgba(255, 190, 110, 0.45), 0 3px 12px rgba(0, 0, 0, 0.6);
      transform: rotate(-4deg);
    }
    .f-done-sub { margin-top: 14px; font-size: 22px; color: var(--paper); text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
    .f-done-hint { margin-top: 4px; font-size: 16px; color: var(--ink-soft); text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
  `;
  document.head.appendChild(st);
}

// ---------- canvas の文字（盆に鉛筆で書いたような） ----------

function canvasTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// text を書いた板（寝かせて置く）。フォントが届いたら描き直す
export function textDecal(text, { w = 2, h = 0.6, px = 80, color = 'rgba(241, 230, 204, 0.88)', tilt = -0.04 } = {}) {
  const W = 512;
  const H = Math.max(64, Math.round((W * h) / w));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = canvasTexture(canvas);
  const draw = () => {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    let size = px;
    g.font = `${size}px ${HAND_FONT}`;
    while (size > 16 && g.measureText(text).width > W - 24) {
      size *= 0.92;
      g.font = `${size}px ${HAND_FONT}`;
    }
    g.save();
    g.translate(W / 2, H / 2);
    g.rotate(tilt);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(text, 0, 0);
    // 鉛筆のかすれ（ところどころ薄くする）
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 90; i++) {
      g.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.25})`;
      g.fillRect((Math.random() - 0.5) * W, (Math.random() - 0.5) * H, 2 + Math.random() * 5, 1 + Math.random() * 2);
    }
    g.restore();
    tex.needsUpdate = true;
  };
  draw();
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`${px}px Yomogi`, text).then(draw, () => {});
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- 本の小口（ページの白い帯）と、ものさしの目盛り ----------

export function dressBooks(scene, books) {
  const mat = new THREE.MeshStandardMaterial({ color: '#e8dcc2', roughness: 0.95 });
  for (const b of books) {
    const th = (b.top - b.bottom) * 0.6;
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2 + 0.014, th, b.hz * 2 + 0.014), mat);
    m.position.set(b.x, (b.top + b.bottom) / 2, b.z);
    m.receiveShadow = true;
    scene.add(m);
  }
}

export function rulerFace(scene, r) {
  const W = 1024, H = 180;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#dccaa0';
  g.fillRect(0, 0, W, H);
  // 木目のすじ
  for (let i = 0; i < 26; i++) {
    g.strokeStyle = `rgba(120, 90, 50, ${0.04 + Math.random() * 0.05})`;
    g.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * H;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + (Math.random() - 0.5) * 12, W * 0.7, y + (Math.random() - 0.5) * 12, W, y + (Math.random() - 0.5) * 8);
    g.stroke();
  }
  // 目盛り（20cm。手前の辺に）
  const x0 = 24, x1 = W - 24;
  g.strokeStyle = '#4e3f2e';
  g.fillStyle = '#4e3f2e';
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.font = `26px ${HAND_FONT}`;
  for (let mm = 0; mm <= 200; mm++) {
    const x = x0 + ((x1 - x0) * mm) / 200;
    const len = mm % 10 === 0 ? 46 : mm % 5 === 0 ? 30 : 18;
    g.lineWidth = mm % 10 === 0 ? 2.2 : 1.2;
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x, H - len);
    g.stroke();
    if (mm % 10 === 0 && mm > 0 && mm < 200) g.fillText(String(mm / 10), x, H - 52);
  }
  const tex = canvasTexture(canvas);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(r.hx * 2, r.hz * 2).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }),
  );
  m.position.set(r.x, r.top + 0.001, r.z);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}

// ---------- 下書きの点線（とぎれの目じるし。ドミノが乗ると消える） ----------

const DASH = {
  s: { w: 0.05, l: 0.12 },
  m: { w: 0.065, l: 0.17 },
  l: { w: 0.095, l: 0.24 },
};

export class Marks {
  constructor(scene, sim, gaps) {
    this.list = [];
    for (const g of gaps) {
      for (const d of g.dashes) {
        const gr = sim.groundAt(d.x, d.z) || { y: 0, n: { x: 0, y: 1, z: 0 } };
        const n = new THREE.Vector3(gr.n.x, gr.n.y, gr.n.z);
        const q = new THREE.Quaternion().setFromUnitVectors(UP, n)
          .multiply(new THREE.Quaternion().setFromAxisAngle(UP, d.yaw));
        const pos = new THREE.Vector3(d.x, gr.y, d.z).addScaledVector(n, 0.006);
        this.list.push({ gap: g.index, size: d.size, x: d.x, z: d.z, pos, q, vis: 1, want: 1, dirty: true });
      }
    }
    this.mat = new THREE.MeshStandardMaterial({
      color: '#f1e6cc', roughness: 1, transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.mat, Math.max(1, this.list.length));
    this.mesh.count = this.list.length;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._s = new THREE.Vector3();
    this.time = 0;
    this._writeAll();
  }

  _write(i) {
    const d = this.list[i];
    const e = d.vis;
    const k = e < 0.01 ? 0 : 0.3 + 0.7 * (1 - (1 - e) * (1 - e));
    const size = DASH[d.size];
    this._s.set(size.w * k, 1, size.l * k);
    this._m.compose(d.pos, d.q, this._s);
    this.mesh.setMatrixAt(i, this._m);
  }

  _writeAll() {
    for (let i = 0; i < this.list.length; i++) this._write(i);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // doms: [x, z, 高さ, 足もとの高さ, ...]。近くの同じ面にドミノがある点線は消す
  cover(doms) {
    for (const d of this.list) {
      let hit = false;
      for (let i = 0; i < doms.length; i += 4) {
        const r = 0.4 * doms[i + 2];
        const dx = doms[i] - d.x, dz = doms[i + 1] - d.z;
        if (dx * dx + dz * dz < r * r && Math.abs(doms[i + 3] - d.pos.y) < 0.12) { hit = true; break; }
      }
      d.want = hit ? 0 : 1;
    }
  }

  update(dt) {
    this.time += dt;
    let changed = false;
    for (let i = 0; i < this.list.length; i++) {
      const d = this.list[i];
      if (d.vis === d.want) continue;
      const step = dt * (d.want > d.vis ? 3 : 6);
      d.vis = d.want > d.vis ? Math.min(d.want, d.vis + step) : Math.max(d.want, d.vis - step);
      this._write(i);
      changed = true;
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
    // ゆっくり息をするように濃くなったり薄くなったりする
    this.mat.opacity = 0.44 + 0.12 * Math.sin(this.time * 2.1);
  }
}

// ---------- 光の粒（ほたるのように、ふわっと上がって消える） ----------

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return canvasTexture(c);
}

export class Sparkles {
  constructor(scene, max = 200) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.p = [];
    for (let i = 0; i < max; i++) {
      this.p.push({ alive: false, x: 0, y: -50, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, r: 1, g: 1, b: 1, ph: 0 });
      this.pos[i * 3 + 1] = -50;
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    const mat = new THREE.PointsMaterial({
      size: 0.2, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.next = 0;
    this._c = new THREE.Color();
    this.active = 0;
  }

  spawn(x, y, z, color, n = 1, { spread = 0.18, up = 0.55, life = 1.7 } = {}) {
    this._c.set(color);
    for (let k = 0; k < n; k++) {
      const s = this.p[this.next];
      this.next = (this.next + 1) % this.max;
      s.alive = true;
      s.x = x + (Math.random() - 0.5) * spread * 2;
      s.y = y + Math.random() * 0.1;
      s.z = z + (Math.random() - 0.5) * spread * 2;
      s.vx = (Math.random() - 0.5) * 0.25;
      s.vz = (Math.random() - 0.5) * 0.25;
      s.vy = up * (0.6 + Math.random() * 0.8);
      s.age = 0;
      s.life = life * (0.7 + Math.random() * 0.6);
      s.r = this._c.r;
      s.g = this._c.g;
      s.b = this._c.b;
      s.ph = Math.random() * 6.28;
    }
    this.active = this.max;
  }

  update(dt) {
    if (this.active <= 0) return;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const s = this.p[i];
      const j = i * 3;
      if (!s.alive) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.alive = false;
        this.col[j] = this.col[j + 1] = this.col[j + 2] = 0;
        this.pos[j + 1] = -50;
        continue;
      }
      alive++;
      s.vy *= 1 - 0.9 * dt;
      s.x += (s.vx + 0.12 * Math.sin(s.age * 3 + s.ph)) * dt;
      s.y += s.vy * dt;
      s.z += (s.vz + 0.12 * Math.cos(s.age * 2.6 + s.ph)) * dt;
      const k = s.age / s.life;
      const a = Math.sin(Math.PI * Math.min(1, k * 1.4 + 0.02)) * (1 - k * 0.3) * (0.8 + 0.2 * Math.sin(s.age * 17 + s.ph));
      this.pos[j] = s.x;
      this.pos[j + 1] = s.y;
      this.pos[j + 2] = s.z;
      this.col[j] = s.r * a;
      this.col[j + 1] = s.g * a;
      this.col[j + 2] = s.b * a;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    // すべて消えたら、次に出るまで書き換えをやめる（消した分はこの回で送っている）
    this.active = alive > 0 ? this.max : 0;
  }
}

// ---------- 鐘の形（当たり判定は 0.6 × 1.0 × 0.6 の箱のまま。見た目だけ差し替える） ----------

export function bellGeometry() {
  const P = [
    [0.265, -0.47], [0.3, -0.5], [0.335, -0.49], [0.332, -0.44], [0.3, -0.33], [0.262, -0.17],
    [0.24, -0.02], [0.228, 0.12], [0.21, 0.23], [0.17, 0.31], [0.1, 0.35], [0.05, 0.36],
    [0.045, 0.38], [0.065, 0.43], [0.058, 0.48], [0.03, 0.5], [0.0, 0.502],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(P, 36);
}

// ---------- 「できた」（手書きの大きな文字） ----------

export class DoneBanner {
  constructor() {
    const el = document.createElement('div');
    el.className = 'f-done';
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div><div class="f-done-big">できた</div><div class="f-done-sub"></div><div class="f-done-hint"></div></div>';
    document.body.appendChild(el);
    this.el = el;
    this.big = el.querySelector('.f-done-big');
    this.sub = el.querySelector('.f-done-sub');
    this.hint = el.querySelector('.f-done-hint');
    this.anims = [];
  }

  show(sub = '', hint = '') {
    this.hide();
    this.sub.textContent = sub;
    this.hint.textContent = hint;
    if (typeof this.el.animate !== 'function') {
      this.el.style.opacity = '1';
      setTimeout(() => { this.el.style.opacity = '0'; }, 4200);
      return;
    }
    this.anims.push(this.el.animate(
      [
        { opacity: 0, transform: 'scale(0.94)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.1 },
        { opacity: 1, transform: 'scale(1.01)', offset: 0.82 },
        { opacity: 0, transform: 'scale(1.03)' },
      ],
      { duration: 5200, easing: 'ease-out', fill: 'forwards' },
    ));
    // 左から右へ、筆で書くように現れる
    this.anims.push(this.big.animate(
      [{ clipPath: 'inset(-20% 100% -20% -10%)' }, { clipPath: 'inset(-20% -10% -20% -10%)' }],
      { duration: 900, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'both' },
    ));
  }

  hide() {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.el.style.opacity = '0';
  }
}
