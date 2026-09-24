// 試作「倒すと絵が出る」
//
// 本物のドミノショーのように、倒れたドミノの面が集まって絵になる。
// ドミノは大きい2つの面（ローカル ±z）にだけ色が塗ってあり、上面と側面は木のまま。
// 立っているあいだは細い木の縁しか見えない（色も沈ませてある）。倒れて面が上を向くと色が咲く。
//
// 盤：盆の上に、奥が少し高い画板（4.5° の坂）。その上に下絵の紙を貼ってある。
//     絵は 16×10 マス（1マス 0.6 ＝ 中ドミノの「ちょうどいい間隔」）。どの行も右（+x）へ倒れる。
//     行は坂を横切る向きなので、坂でも倒れ方は変わらない（横向きは 8° 未満なら安全）。
// 左：最初から「扇」（千鳥に並べて 1→12 に広がる分岐）と「合図の大ドミノ」を置いてある。
//     合図を1回押すと扇で分かれて、全部の行へ同時に伝わる。
// 絵の輪郭の一部（上と下の行、形のふち）も最初から置いてあり、残りを自分で埋める。

import * as THREE from 'three';
import { startProto } from '../lib/protoapp.js';

// ---------- 色 ----------

const PALETTE = [
  { key: 'N', hex: '#44507e', name: 'よぞら' },
  { key: 'Y', hex: '#f0d27a', name: 'つき' },
  { key: 'W', hex: '#f4efe4', name: 'しろ' },
  { key: 'B', hex: '#7d93a8', name: 'あお' },
  { key: 'G', hex: '#6f9a6a', name: 'みどり' },
  { key: 'R', hex: '#c7765a', name: 'あか' },
];
const HEX = Object.fromEntries(PALETTE.map((p) => [p.key, p.hex]));
const WOOD = '#d4b68c';        // ドミノの木の色（上面・側面。扇のドミノは面も木）
const SIGNAL = '#e8b465';      // 合図の大ドミノの面
const BOARD_COLOR = '#9c7550'; // 画板

// ---------- お題（16×10。上の行＝奥） ----------

const PICTURES = [
  {
    name: 'つきと やま',
    bg: 'N',
    rows: [
      'NNNNNNWNNNNNNNNN',
      'NWNNNNNNNNNYYNNN',
      'NNNNNNNNNNYYYYNN',
      'NNNNNNNNWNYYYYNN',
      'NNNNWNNNNNNYYNNN',
      'NNNBWBNNNNNNNNWN',
      'NNBBBBBNNNNGNNNN',
      'NBBBBBBBNNGGGNNN',
      'BBBBBBBBBGGGGGNN',
      'RRRRRRRRRRRRRRRR',
    ],
  },
  {
    name: 'にこにこ',
    bg: 'B',
    rows: [
      'BBBBBBBBBBBBBBBB',
      'BBBBBYYYYYYBBBBB',
      'BBBBYYYYYYYYBBBB',
      'BBBYYNYYYYNYYBBB',
      'BBBYYNYYYYNYYBBB',
      'BBBYRYYYYYYRYBBB',
      'BBBYYNYYYYNYYBBB',
      'BBBBYYNNNNYYBBBB',
      'BBBBBYYYYYYBBBBB',
      'GGGGGGGGGGGGGGGG',
    ],
  },
];

// ---------- 盤の寸法 ----------

const COLS = 16, ROWS = 10, CELL = 0.6;
const CELLS = COLS * ROWS;
const PX0 = -2.6;                 // 左上のマス（列0・行0）の中心
const PZ0 = -5.0;
const ZC = PZ0 + ((ROWS - 1) * CELL) / 2;   // 絵のまん中の行の z（扇の軸）
const RANKS = 12;                 // 扇の段数。最後の段は 12 個（両端の1個ずつは予備。端が崩れても行0と行9に届く）
const RANK_GAP = 0.55;            // 扇の段の間隔（少し詰めて、ずれた当たりでも強く押す）
const SIGNAL_X = PX0 - RANKS * RANK_GAP - 0.9;   // 合図の大ドミノ（高さ 1.6 に対して 0.9 ＝ 0.56 倍）
const TILT = (4.5 * Math.PI) / 180;              // 画板の傾き（奥が高い）
const BOARD = { x0: -11.2, x1: 8.4, z0: PZ0 - 1.1, z1: PZ0 + 6.5, h0: 0.1, th: 0.78 };   // 厚みは奥の下にすき間が出ず、手前の下が天板から出ない値
const PAPER = { x0: BOARD.x0 + 0.2, x1: BOARD.x1 - 0.2, z0: BOARD.z0 + 0.2, z1: BOARD.z1 - 0.2 };
const STAMP_X = PX0 + (COLS - 1) * CELL + 1.35;  // 行のできあがりの判子（最後のドミノが倒れた先）
const RING_LIFT = 0.015;                          // 波紋を紙より少し上に出す（紙は深度を手前へずらしてある）

const cellX = (j) => PX0 + j * CELL;
const cellZ = (k) => PZ0 + k * CELL;
const boardTop = (z) => BOARD.h0 + (BOARD.z1 - z) * Math.tan(TILT);

// (x, z) に一番近いマス。絵の外なら null
function cellAt(x, z) {
  const j = Math.round((x - PX0) / CELL);
  const k = Math.round((z - PZ0) / CELL);
  if (j < 0 || j >= COLS || k < 0 || k >= ROWS) return null;
  return { j, k, x: cellX(j), z: cellZ(k) };
}

// 画板：上面が (x0..x1, z0..z1) を覆い、手前の高さ h0 から奥へ上る厚い板。
// protosim の ramp() は厚みが 0.3 固定で奥の下にすき間が見えるので、同じ形の定義を厚くして自前で作る
function drawingBoard() {
  const cx = (BOARD.x0 + BOARD.x1) / 2;
  const cz = (BOARD.z0 + BOARD.z1) / 2;
  const top = boardTop(cz);
  const ny = Math.cos(TILT), nz = Math.sin(TILT);   // 上面の法線（x 軸まわりに TILT 回すと (0,1,0) がこうなる）
  return {
    type: 'box', name: 'board', color: BOARD_COLOR,
    x: cx, y: top - (ny * BOARD.th) / 2, z: cz - (nz * BOARD.th) / 2,
    hx: (BOARD.x1 - BOARD.x0) / 2, hy: BOARD.th / 2, hz: (BOARD.z1 - BOARD.z0) / (2 * Math.cos(TILT)),
    rot: { x: Math.sin(TILT / 2), y: 0, z: 0, w: Math.cos(TILT / 2) },
  };
}

// 形のふち（背景に接している色のマス）と、上下の行は最初から置いておく
function isOutline(pic, j, k) {
  if (k === 0 || k === ROWS - 1) return true;
  const c = pic.rows[k][j];
  if (c === pic.bg) return false;
  const at = (jj, kk) => (jj < 0 || jj >= COLS || kk < 0 || kk >= ROWS ? pic.bg : pic.rows[kk][jj]);
  return at(j + 1, k) === pic.bg || at(j - 1, k) === pic.bg || at(j, k + 1) === pic.bg || at(j, k - 1) === pic.bg;
}

function pictureStageDominoes(pic) {
  const list = [];
  for (let k = 0; k < ROWS; k++) {
    for (let j = 0; j < COLS; j++) {
      if (!isOutline(pic, j, k)) continue;
      list.push({ x: cellX(j), z: cellZ(k), yaw: Math.PI / 2, size: 'm', color: HEX[pic.rows[k][j]], meta: { cell: [j, k] } });
    }
  }
  return list;
}

// 扇：段 r に r+1 個。隣の段とは z が半マス（0.3）ずれていて、1個が次の段の2個に当たる
function spreaderDominoes() {
  const list = [];
  for (let r = 0; r < RANKS; r++) {
    const x = PX0 - (RANKS - r) * RANK_GAP;
    for (let i = 0; i <= r; i++) {
      list.push({ x, z: ZC + (i - r / 2) * CELL, yaw: Math.PI / 2, size: 'm', color: WOOD, meta: { spread: true, rank: r } });
    }
  }
  list.push({ x: SIGNAL_X, z: ZC, yaw: Math.PI / 2, size: 'l', color: SIGNAL, meta: { signal: true } });
  return list;
}

// ---------- 面だけに色が付くドミノの材質 ----------

// 頂点の法線（ローカル）の z で大きい面を見分け、そこにだけ instanceColor（手に持つ1枚は material.color）を効かせる。
// さらに、面が上を向いている度合い（倒れ具合）で色の濃さを変える。mute は立っているときの色の強さ
function makeFaceMaterial(mute) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
  const uniforms = {
    uWood: { value: new THREE.Color(WOOD) },
    uMute: { value: mute },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWood = uniforms.uWood;
    shader.uniforms.uMute = uniforms.uMute;
    const vs = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vArtFace;\nvarying float vArtUp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vArtFace = smoothstep( 0.6, 0.85, abs( normal.z ) );
        vec3 artFaceDir = vec3( 0.0, 0.0, 1.0 );
        #ifdef USE_INSTANCING
          artFaceDir = mat3( instanceMatrix ) * artFaceDir;
        #endif
        artFaceDir = mat3( modelMatrix ) * artFaceDir;
        vArtUp = abs( normalize( artFaceDir ).y );`);
    const fs = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWood;\nuniform float uMute;\nvarying float vArtFace;\nvarying float vArtUp;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float artBloom = mix( uMute, 1.0, smoothstep( 0.35, 0.85, vArtUp ) );
        diffuseColor.rgb = mix( uWood, mix( uWood, diffuseColor.rgb, artBloom ), vArtFace );`);
    if (vs === shader.vertexShader || fs === shader.fragmentShader) {
      console.warn('[art] シェーダーの差し込み先が見つからない。ドミノは全体に色が付いたままになる');
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'art-face-v1';
  return mat;
}

// ---------- 音（WebAudio。外部の音源は使わない） ----------

const SCALE = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84];   // C メジャー・ペンタトニック（BGM と同じ調）
const colNote = (j) => SCALE[Math.round((j * (SCALE.length - 1)) / (COLS - 1))];

// カリンバのような「ポン」。正しい色を置いたとき、列が左から右へ上がっていく
function pluck(feel, midi, gain = 0.13, delay = 0) {
  const ctx = feel.ctx;
  if (!ctx || feel.sound.muted) return;
  const t = ctx.currentTime + 0.004 + delay;
  const f = 440 * Math.pow(2, (midi - 69) / 12);
  const out = feel.out();
  const tone = (freq, g0, dur) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(g0, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  tone(f, gain, 1.1);
  tone(f * 2, gain * 0.16, 0.35);
  tone(f * 5.4, gain * 0.06, 0.1);   // 金属の舌っぽい、すぐ消える倍音
}

function arpeggio(feel, notes, gap = 0.08, gain = 0.1) {
  notes.forEach((m, i) => pluck(feel, m, gain, i * gap));
}

// 塗りかえの「シュッ」（筆でなでる音）
let brushBuf = null;
function brush(feel) {
  const ctx = feel.ctx;
  if (!ctx || feel.sound.muted) return;
  if (!brushBuf) {
    const len = Math.floor(ctx.sampleRate * 0.22);
    brushBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = brushBuf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const k = Math.sin((Math.PI * i) / len);
      d[i] = (Math.random() * 2 - 1) * k * k;
    }
  }
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = brushBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 0.9;
  f.frequency.setValueAtTime(800, t);
  f.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
  const g = ctx.createGain();
  g.gain.value = 0.16;
  src.connect(f).connect(g).connect(feel.out());
  src.start(t);
}

// ---------- 下絵の紙（canvas に描いて、画板の上に貼る） ----------

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const PPU = 80;   // 1単位あたりの画素
const FONT = '"Yomogi", "Hiragino Maru Gothic ProN", "Zen Kaku Gothic New", sans-serif';

function makePaper(view) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((PAPER.x1 - PAPER.x0) * PPU);
  canvas.height = Math.round((PAPER.z1 - PAPER.z0) * PPU);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, view.renderer.capabilities.getMaxAnisotropy());
  // 画板の上面に沿わせる（キャンバスの上＝奥、右＝+x）
  const geo = new THREE.PlaneGeometry(PAPER.x1 - PAPER.x0, PAPER.z1 - PAPER.z0, 8, 12);
  geo.rotateX(-Math.PI / 2);
  geo.translate((PAPER.x0 + PAPER.x1) / 2, 0, (PAPER.z0 + PAPER.z1) / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, boardTop(pos.getZ(i)) + 0.006);
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.92, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  }));
  mesh.name = 'art-paper';
  mesh.receiveShadow = true;
  view.scene.add(mesh);
  return { canvas, tex, mesh };
}

// rowState[k]：0 まだ / 1 全部置いた / 2 全部置いて色も全部あっている
function drawPaper(paper, pic, rowState) {
  const { canvas } = paper;
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const U = (x) => (x - PAPER.x0) * PPU;
  const V = (z) => (z - PAPER.z0) * PPU;
  const L = (d) => d * PPU;
  const rnd = mulberry32(11);
  const INK = '#4e4236';

  g.save();
  g.setLineDash([]);
  g.globalAlpha = 1;
  // 紙と、紙の粒
  g.fillStyle = '#e2d6bb';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 3200; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(120, 96, 70, 0.06)' : 'rgba(255, 250, 240, 0.08)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const edge = g.createRadialGradient(W / 2, H / 2, H * 0.4, W / 2, H / 2, W * 0.62);
  edge.addColorStop(0, 'rgba(90, 64, 40, 0)');
  edge.addColorStop(1, 'rgba(90, 64, 40, 0.2)');
  g.fillStyle = edge;
  g.fillRect(0, 0, W, H);

  const pencil = (pts, { w = 2, a = 0.45, color = INK, dash = null, close = false } = {}) => {
    g.save();
    g.globalAlpha = a;
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const jx = (rnd() - 0.5) * 1.4, jy = (rnd() - 0.5) * 1.4;
      if (i) g.lineTo(x + jx, y + jy);
      else g.moveTo(x + jx, y + jy);
    });
    if (close) g.closePath();
    g.stroke();
    g.restore();
  };
  const text = (s, x, y, size, { align = 'left', a = 0.6, color = INK } = {}) => {
    g.save();
    g.globalAlpha = a;
    g.fillStyle = color;
    g.font = `${Math.round(L(size))}px ${FONT}`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillText(s, x, y);
    g.restore();
  };
  const arrow = (x0, y0, x1, y1, opt = {}) => {
    const hx = (x1 - x0), hy = (y1 - y0);
    const len = Math.hypot(hx, hy) || 1;
    const ux = hx / len, uy = hy / len, s = L(0.12);
    pencil([[x0, y0], [x1, y1]], opt);
    pencil([[x1 - ux * s - uy * s * 0.7, y1 - uy * s + ux * s * 0.7], [x1, y1], [x1 - ux * s + uy * s * 0.7, y1 - uy * s - ux * s * 0.7]], opt);
  };

  // ---- 絵のマス ----
  const gx0 = U(PX0 - CELL / 2), gy0 = V(PZ0 - CELL / 2);
  const gx1 = U(PX0 + (COLS - 0.5) * CELL), gy1 = V(PZ0 + (ROWS - 0.5) * CELL);
  for (let k = 0; k < ROWS; k++) {
    for (let j = 0; j < COLS; j++) {
      const hex = HEX[pic.rows[k][j]];
      const cx = U(cellX(j)), cy = V(cellZ(k));
      // マス全体をうすく（離れて見ると絵になる）
      g.globalAlpha = 0.3;
      g.fillStyle = hex;
      rrect(g, cx - L(0.28), cy - L(0.28), L(0.56), L(0.56), L(0.07));
      g.fill();
      // 色の点（ドミノの後ろ側に描く。立てても隠れない）
      g.globalAlpha = 0.95;
      g.beginPath();
      g.arc(cx - L(0.19), cy, L(0.075), 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 0.4;
      g.strokeStyle = INK;
      g.lineWidth = 1.2;
      g.stroke();
      // ドミノを立てる場所と、倒れる向き
      g.globalAlpha = 0.38;
      g.lineWidth = 1.5;
      g.strokeRect(cx - L(0.075), cy - L(0.25), L(0.15), L(0.5));
      g.beginPath();
      g.moveTo(cx + L(0.15), cy - L(0.07));
      g.lineTo(cx + L(0.22), cy);
      g.lineTo(cx + L(0.15), cy + L(0.07));
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  pencil([[gx0, gy0], [gx1, gy0], [gx1, gy1], [gx0, gy1]], { w: 2.4, a: 0.5, close: true });
  // 題と、倒れる向き
  const ty = V(PZ0 - 0.62);
  text(`おだい：${pic.name}`, gx0 + L(0.05), ty, 0.36, { a: 0.7 });
  text('どの ぎょうも みぎへ たおれる', gx1 - L(0.75), ty, 0.26, { align: 'right', a: 0.55 });
  arrow(gx1 - L(0.65), ty, gx1 - L(0.05), ty, { w: 2.2, a: 0.55 });
  // 行の右はしの矢印と、できあがりの判子
  for (let k = 0; k < ROWS; k++) {
    const y = V(cellZ(k));
    arrow(gx1 + L(0.12), y, gx1 + L(0.55), y, { w: 1.8, a: 0.35 });
    const sx = U(STAMP_X);
    if (rowState[k] === 2) {
      g.save();
      g.globalAlpha = 0.75;
      g.strokeStyle = '#b8603f';
      g.lineWidth = 2.6;
      g.beginPath();
      g.arc(sx, y, L(0.2), 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(sx, y, L(0.11), 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.14;
      g.fillStyle = '#b8603f';
      g.beginPath();
      g.arc(sx, y, L(0.2), 0, Math.PI * 2);
      g.fill();
      g.restore();
    } else if (rowState[k] === 1) {
      pencil(Array.from({ length: 13 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2.1;
        return [sx + Math.cos(a) * L(0.18), y + Math.sin(a) * L(0.18)];
      }), { w: 2, a: 0.5 });
    }
  }

  // ---- 扇と合図 ----
  g.save();
  g.globalAlpha = 0.2;
  g.strokeStyle = INK;
  g.lineWidth = 1.4;
  for (let r = 0; r < RANKS; r++) {
    const x = PX0 - (RANKS - r) * RANK_GAP;
    for (let i = 0; i <= r; i++) {
      const z = ZC + (i - r / 2) * CELL;
      g.strokeRect(U(x) - L(0.075), V(z) - L(0.25), L(0.15), L(0.5));
    }
  }
  g.restore();
  // 扇のまわりを点線でかこむ（先は合図の丸とぶつからないよう切り落とす。紙からはみ出さない幅で止める）
  const fx0 = PX0 - RANKS * RANK_GAP - 0.3, fx1 = PX0 - RANK_GAP + 0.3;
  const spread = ((RANKS - 1) * CELL) / 2 + 0.28;
  const fxm = fx0 + (spread - 0.4) / (CELL / 2 / RANK_GAP);   // 扇と同じ広がり方で、いちばん広くなるところ
  pencil([
    [U(fx0), V(ZC - 0.4)], [U(fxm), V(ZC - spread)], [U(fx1), V(ZC - spread)],
    [U(fx1), V(ZC + spread)], [U(fxm), V(ZC + spread)], [U(fx0), V(ZC + 0.4)],
  ], { w: 1.8, a: 0.3, dash: [9, 9], close: true });
  text('おうぎ（ここで ぜんぶの ぎょうに わかれる）', U(PX0 - 4.9), V(ZC + 2.6), 0.22, { align: 'center', a: 0.45 });
  // 合図の大ドミノ：金の丸と「ここを おす」
  const sx = U(SIGNAL_X), sy = V(ZC);
  pencil(Array.from({ length: 25 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    return [sx + Math.cos(a) * L(0.6), sy + Math.sin(a) * L(0.6)];
  }), { w: 3, a: 0.7, color: '#c98a2e', dash: [10, 7] });
  text('あいず', sx, V(ZC - 1.05), 0.34, { align: 'center', a: 0.75, color: '#8a5a1e' });
  arrow(U(SIGNAL_X - 0.62), sy, U(SIGNAL_X - 0.2), sy, { w: 2.6, a: 0.7, color: '#8a5a1e' });
  text('ここを おす', sx, V(ZC + 1.05), 0.28, { align: 'center', a: 0.7, color: '#8a5a1e' });
  g.restore();
  paper.tex.needsUpdate = true;
}

// ---------- 画面の色えらび ----------

function mountPanel(state) {
  const style = document.createElement('style');
  style.textContent = `
    .art-panel { position: fixed; z-index: 30; left: 16px; bottom: calc(50px + env(safe-area-inset-bottom, 0px));
      display: grid; gap: 8px; pointer-events: none; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7); }
    .art-progress { font-size: 15px; color: var(--ink-soft); }
    .art-progress b { font-weight: 400; color: var(--paper); }
    .art-swatches { display: flex; gap: 10px; padding-bottom: 16px; }
    .art-sw { pointer-events: auto; position: relative; width: 32px; height: 32px; padding: 0; border-radius: 50%;
      border: 2px solid rgba(244, 239, 228, 0.28); cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
      transition: transform 0.15s ease, border-color 0.15s ease; }
    .art-sw:hover { transform: translateY(-2px); }
    .art-sw[aria-pressed="true"] { border-color: var(--lamp); transform: translateY(-4px);
      box-shadow: 0 0 0 3px rgba(255, 207, 138, 0.28), 0 4px 10px rgba(0, 0, 0, 0.5); }
    .art-sw:focus-visible { outline: 2px solid var(--lamp); outline-offset: 3px; }
    .art-sw span { position: absolute; left: 50%; top: calc(100% + 3px); transform: translateX(-50%);
      font: 12px var(--hand); color: var(--ink-soft); }
    .art-sw[aria-pressed="true"] span { color: var(--lamp); }
  `;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.className = 'art-panel';
  el.innerHTML = '<div class="art-progress"></div><div class="art-swatches" role="group" aria-label="ドミノの いろ"></div>';
  const row = el.querySelector('.art-swatches');
  const buttons = PALETTE.map((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'art-sw';
    b.style.background = p.hex;
    b.title = `${i + 4}：${p.name}`;
    b.setAttribute('aria-label', `${i + 4} ${p.name}`);
    b.setAttribute('aria-pressed', 'false');
    const n = document.createElement('span');
    n.textContent = String(i + 4);
    b.appendChild(n);
    b.addEventListener('click', () => {
      state.color = p.hex;
      document.getElementById('scene')?.focus();
    });
    row.appendChild(b);
    return b;
  });
  document.body.appendChild(el);
  return { buttons, progress: el.querySelector('.art-progress'), shown: null };
}

// ---------- 遊びの状態 ----------

let picIndex = 0;
let pic = PICTURES[0];
const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));   // マス → ドミノの id
const cellById = new Map();                                                // ドミノの id → マス
let rowState = new Array(ROWS).fill(0);
let progress = { filled: 0, correct: 0 };
let wasReady = false;
let lastVersion = -1;
let paper = null;
let panel = null;
let signalId = 0;
const best = PICTURES.map(() => null);
const run = { glanced: false, done: false };   // 合図から始まった1回の倒し
const spreadChains = new Set();                // 扇のドミノを含む連鎖の id
let pulseT = 1.5;
let lastCellKey = -1;
let lastTickAt = 0;

function pieceIn(sim, j, k) {
  const id = grid[k][j];
  if (!id) return null;
  const p = sim.byId.get(id);
  if (!p) {
    grid[k][j] = 0;
    cellById.delete(id);
    return null;
  }
  return p;
}

function scanGrid(sim) {
  let filled = 0, correct = 0;
  const rows = [];
  for (let k = 0; k < ROWS; k++) {
    let rf = 0, rc = 0;
    for (let j = 0; j < COLS; j++) {
      const p = pieceIn(sim, j, k);
      if (!p) continue;
      rf++;
      if (p.color === HEX[pic.rows[k][j]]) rc++;
    }
    filled += rf;
    correct += rc;
    rows.push(rf === COLS ? (rc === COLS ? 2 : 1) : 0);
  }
  return { filled, correct, rows };
}

function updateSticky(ctx) {
  const b = best[picIndex];
  ctx.view.room.sticky.setLines([
    `おだい：${pic.name}`,
    'したえに あわせて',
    'ならべて たおそう',
    b == null ? '' : `さいこう ${b} / ${CELLS}`,
  ]);
}

function updateHud(ctx) {
  if (!panel) return;
  const html = `ならべた <b>${progress.filled}</b> / ${CELLS}　・　いろ ぴったり <b>${progress.correct}</b>`;
  if (panel.html !== html) {
    panel.html = html;
    panel.progress.innerHTML = html;
  }
  if (panel.shown !== ctx.state.color) {
    panel.shown = ctx.state.color;
    panel.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(PALETTE[i].hex === ctx.state.color)));
  }
}

// マスの中身が変わったあと。celebrate のときだけ、行ができた音や合図の案内を出す
function afterGridChange(ctx, celebrate) {
  const { sim, view, feel } = ctx;
  lastVersion = sim.version;
  const s = scanGrid(sim);
  let changed = false;
  for (let k = 0; k < ROWS; k++) {
    if (s.rows[k] === rowState[k]) continue;
    changed = true;
    if (celebrate && s.rows[k] > rowState[k]) {
      // 行ができた：右はしで判子の波紋と、上がる和音
      const z = cellZ(k);
      view.ring(STAMP_X, boardTop(z) + RING_LIFT, z, { color: s.rows[k] === 2 ? '#e0916c' : '#fff4e0', r0: 0.1, r1: 0.6, life: 0.7, a: 0.8, n: { x: 0, y: Math.cos(TILT), z: Math.sin(TILT) } });
      arpeggio(feel, s.rows[k] === 2 ? [72, 76, 79, 84, 88] : [72, 76, 79], 0.07, 0.09);
      for (let j = 0; j < COLS; j++) {
        const p = pieceIn(sim, j, k);
        if (p && p.state === 'standing') setTimeout(() => view.flash(p.id, '#fff2c8', 0.5), j * 22);
      }
    }
  }
  rowState = s.rows;
  if (changed && paper) drawPaper(paper, pic, rowState);
  progress = s;
  const ready = s.filled === CELLS;
  if (ready && !wasReady && celebrate) {
    setTimeout(() => arpeggio(feel, [67, 72, 76, 79, 84, 88], 0.11, 0.1), 450);
    ctx.floatLabel('あいずの ドミノを おそう', SIGNAL_X, boardTop(ZC) + 1.9, ZC, '', 4200);
    pulseT = 0.6;
  }
  wasReady = ready;
  updateHud(ctx);
}

// 真上から絵を見る（倒れていく途中から見上げる）
function glanceTopDown(ctx) {
  const { view } = ctx;
  const cx = PX0 + ((COLS - 1) * CELL) / 2 + 0.45;   // 倒れると絵は右へ半マスほどずれる
  const aspect = view.camera.aspect || 1.6;
  const dist = Math.max(10.5, 15.5 / aspect);
  view.rig.glance({ target: [cx, boardTop(ZC), ZC], pitch: 1.45, dist }, 7.5, 1.4);
}

function finale(e, ctx) {
  const { sim, sound, feel } = ctx;
  run.done = true;
  let right = 0, standing = 0, empty = 0, fallen = 0;
  for (let k = 0; k < ROWS; k++) {
    for (let j = 0; j < COLS; j++) {
      const p = pieceIn(sim, j, k);
      if (!p) { empty++; continue; }
      if (p.state === 'standing') { standing++; continue; }
      fallen++;
      if (p.color === HEX[pic.rows[k][j]]) right++;
    }
  }
  sound.chainEnd(Math.max(e.total || 0, fallen));
  const x = PX0 + ((COLS - 1) * CELL) / 2 + 0.45;
  const y = boardTop(ZC) + 0.8;
  ctx.floatLabel(`ぴったり ${right} / ${CELLS}`, x, y, ZC, right >= CELLS * 0.9 ? 'big' : '', 6500);
  const note = right === CELLS ? 'かんぺき！'
    : standing > 0 ? `たおれのこり ${standing}`
    : empty > 0 ? `あきマス ${empty}`
    : 'R で たてなおして ぬりなおせる';
  setTimeout(() => ctx.floatLabel(note, x, y - 0.4, ZC + 1.5, '', 5200), 900);
  if (right === CELLS) setTimeout(() => arpeggio(feel, [72, 76, 79, 84, 88, 91], 0.09, 0.1), 600);
  if (best[picIndex] == null || right > best[picIndex]) {
    best[picIndex] = right;
    updateSticky(ctx);
  }
}

// 次のお題へ：絵のドミノ（最初からの分も自分の分も）を片付けて、新しい輪郭を置き直す
function switchPicture(ctx) {
  const { sim } = ctx;
  sim.resetAll();
  for (const p of [...sim.pieces]) {
    if (p.kind === 'domino' && (p.meta?.cell || cellById.has(p.id))) sim._removePiece(p);
  }
  for (const r of grid) r.fill(0);
  cellById.clear();
  picIndex = (picIndex + 1) % PICTURES.length;
  pic = PICTURES[picIndex];
  for (const d of pictureStageDominoes(pic)) {
    const p = sim.placeAt(d.x, d.z, d.yaw, d.size, d.color, { byStage: true, meta: d.meta });
    if (!p) continue;
    const [j, k] = d.meta.cell;
    grid[k][j] = p.id;
    cellById.set(p.id, { j, k, x: cellX(j), z: cellZ(k) });
  }
  sim.hand.lastPlaced = null;
  rowState = new Array(ROWS).fill(-1);   // 判子を描き直させる
  afterGridChange(ctx, false);
  updateSticky(ctx);
  ctx.floatLabel(`おだい：${pic.name}`, PX0 + 4.5, boardTop(ZC) + 1.2, ZC, 'big', 2600);
}

// ---------- 起動 ----------

function setup(ctx) {
  const { sim, view, state, feel } = ctx;

  // 最初から置いてある絵のドミノをマスに登録。合図のドミノを覚える
  for (const p of sim.pieces) {
    if (p.kind !== 'domino') continue;
    if (p.meta?.cell) {
      const [j, k] = p.meta.cell;
      grid[k][j] = p.id;
      cellById.set(p.id, { j, k, x: cellX(j), z: cellZ(k) });
    }
    if (p.meta?.signal) signalId = p.id;
  }

  // 面だけに色が付く材質（大ドミノは合図に使うので、立っていても色を沈ませない）
  const faceMat = makeFaceMaterial(0.42);
  view.meshes.s.material = faceMat;
  view.meshes.m.material = faceMat;
  view.meshes.l.material = makeFaceMaterial(1.0);

  // カメラ：手元へ強めに寄る
  view.follow = 0.6;

  // 絵の上ではカーソルがマスの中心に吸い付く
  const origGround = view.groundPoint.bind(view);
  view.groundPoint = (nx, ny) => {
    const p = origGround(nx, ny);
    if (!p || ctx.input?.poke || (state.trace && ctx.input?.primary)) return p;   // 指で押すとき・なぞり中は自由に
    const c = cellAt(p.x, p.z);
    return c ? { x: c.x, z: c.z } : p;
  };

  // 絵の上では向きを行に合わせる
  const origAutoYaw = sim.autoYaw.bind(sim);
  sim.autoYaw = (x, z, fallback) => (cellAt(x, z) ? Math.PI / 2 : origAutoYaw(x, z, fallback));

  // 絵の上に置くとき：マスの中心へ・行の向き・中サイズ。
  // もう置いてあるマスをクリックしたら塗りかえる（なぞりの途中は塗りかえない。最初からあるドミノは塗れない）
  const origPlaceAt = sim.placeAt.bind(sim);
  sim.placeAt = (x, z, yaw, size = 'm', color = null, opt = {}) => {
    if (opt.byStage) return origPlaceAt(x, z, yaw, size, color, opt);
    const c = cellAt(x, z);
    if (!c) return origPlaceAt(x, z, yaw, size, color, opt);
    const cur = pieceIn(sim, c.j, c.k);
    if (cur) {
      if (!sim.hand.traceFrom && !cur.byStage && cur.state === 'standing' && color && cur.color !== color) {
        cur.color = color;
        sim.version++;
        sim.hand.down = 0.7;   // 手が軽く下りる（筆でちょんと塗る）
        sim.events.push({ type: 'repaint', id: cur.id, color, x: c.x, y: boardTop(c.z), z: c.z, n: cur.n });
      }
      return null;
    }
    // 倒れたドミノがかぶっているマスには置かない（めり込んで跳ねるのを防ぐ）
    if (sim.checkPlacement(c.x, c.z, Math.PI / 2, 'm').status === 'blocked') return null;
    const p = origPlaceAt(c.x, c.z, Math.PI / 2, 'm', color, opt);
    if (p) {
      grid[c.k][c.j] = p.id;
      cellById.set(p.id, c);
    }
    return p;
  };

  // 置く場所の見本を、いま持っている色で描く
  const origSetGhost = view.setGhost.bind(view);
  view.setGhost = (size, check) => {
    origSetGhost(size, check);
    if (!check || !check.pos || !state.color) return;
    const c = cellAt(sim.hand.x, sim.hand.z);
    if (!c) return;
    const cur = pieceIn(sim, c.j, c.k);
    if (cur && cur.byStage) return;
    const g = view.ghosts[size];
    g.material.color.set(state.color);
    g.userData.edges.material.color.set(state.color);
    g.material.opacity = cur ? 0.2 : 0.32;
  };

  paper = makePaper(view);
  panel = mountPanel(state);
  rowState = new Array(ROWS).fill(-1);
  afterGridChange(ctx, false);
  updateSticky(ctx);
  // 手書きの字（Yomogi）が読み込まれたら描き直す
  const redraw = () => drawPaper(paper, pic, rowState);
  document.fonts?.load(`32px ${FONT}`).then(redraw).catch(() => {});
  document.fonts?.ready.then(redraw).catch(() => {});

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.code === 'KeyP') switchPicture(ctx);
  });
}

function onPlace(e, ctx) {
  const c = cellById.get(e.id);
  if (!c) return false;   // 絵の外：いつもの音と演出
  const { sim, view, feel, state } = ctx;
  const p = sim.byId.get(e.id);
  if (!p) return true;
  feel.place('m', e.speed);
  const y = boardTop(c.z) + RING_LIFT;
  if (p.color === HEX[pic.rows[c.k][c.j]]) {
    pluck(feel, colNote(c.j), 0.14);
    view.ring(c.x, y, c.z, { color: p.color, r0: 0.15, r1: 0.75, life: 0.6, a: 0.95, n: p.n });
    view.ring(c.x, y, c.z, { color: '#fff4e0', r0: 0.1, r1: 0.4, life: 0.35, a: 0.5, n: p.n });
  } else {
    view.ring(c.x, y, c.z, { color: p.color, r0: 0.1, r1: 0.45, life: 0.4, a: 0.45, n: p.n });
  }
  state.lastYaw = Math.PI / 2;
  state.yawOffset = 0;
  afterGridChange(ctx, true);
  return true;
}

function onRepaint(e, ctx) {
  const { view, feel } = ctx;
  const c = cellById.get(e.id);
  const right = c && e.color === HEX[pic.rows[c.k][c.j]];
  brush(feel);
  if (right) pluck(feel, colNote(c.j), 0.1, 0.06);
  view.flash(e.id, '#fff2c8', 0.45);
  view.ring(e.x, e.y + RING_LIFT, e.z, { color: e.color, r0: 0.12, r1: right ? 0.65 : 0.4, life: 0.45, a: right ? 0.8 : 0.4, n: e.n });
  afterGridChange(ctx, true);
}

startProto({
  title: '倒すと絵が出る',
  desc: 'したえに あわせて ならべて たおそう。いろは たおれて はじめて みえる',
  trace: true,
  palette: PALETTE.map((p) => p.hex),
  colorFor: () => WOOD,
  camera: { dist: 11.5, pitch: 1.0 },
  layers: 2,
  keys: [
    ['4 〜 9', 'いろを えらぶ（左下でも）'],
    ['おいた マスを クリック', 'いろを ぬりかえる'],
    ['P', 'つぎの おだい'],
  ],
  stage: {
    solids: [drawingBoard()],
    dominoes: [...spreaderDominoes(), ...pictureStageDominoes(pic)],
  },
  setup,
  onEvent(e, ctx) {
    switch (e.type) {
      case 'place':
        return onPlace(e, ctx);
      case 'repaint':
        onRepaint(e, ctx);
        return true;
      case 'hit':
        if (e.meta?.spread || e.meta?.signal) spreadChains.add(e.chain);
        // 扇から来た波が絵に入ったら、真上へ（倒れていく途中から見せる）
        if (cellById.has(e.id) && spreadChains.has(e.chain) && !run.glanced) {
          run.glanced = true;
          glanceTopDown(ctx);
        }
        return false;
      case 'chainEnd':
        if (spreadChains.has(e.chain)) {
          spreadChains.delete(e.chain);
          if (spreadChains.size === 0 && !run.done) finale(e, ctx);
          return true;
        }
        return false;
      case 'reset':
        run.glanced = false;
        run.done = false;
        spreadChains.clear();
        return false;
    }
    return false;
  },
  onFrame(dt, ctx) {
    const { sim, view, state, feel, input } = ctx;
    // 絵の上では中サイズ・行の向き
    if (cellAt(sim.hand.x, sim.hand.z)) {
      state.size = 'm';
      state.yawOffset = 0;
    }
    if (sim.version !== lastVersion) afterGridChange(ctx, false);
    // マスをまたぐたびに、ごく小さな「カチ」（吸い付く手ざわり）
    const tc = state.target && cellAt(state.target.x, state.target.z);
    const key = tc ? tc.j + tc.k * COLS : -1;
    if (key !== lastCellKey) {
      lastCellKey = key;
      const now = performance.now();
      if (key >= 0 && state.started && !input.primary && !view.rig.glancing && now - lastTickAt > 45) {
        lastTickAt = now;
        feel.knock(720, 0.03, 0.02, 5);
      }
    }
    // 合図の大ドミノの呼吸（全部並んだら強く）
    pulseT -= dt;
    if (pulseT <= 0) {
      pulseT = 2.6;
      const s = sim.byId.get(signalId);
      if (s && s.state === 'standing' && state.started && !view.rig.glancing) {
        const t = s.body.translation();
        view.ring(t.x, boardTop(t.z) + RING_LIFT, t.z, { color: '#ffd68a', r0: 0.45, r1: 1.15, life: 1.5, a: wasReady ? 0.6 : 0.2, n: s.n });
        if (wasReady) view.flash(signalId, '#fff6dc', 1.0);
      }
    }
    updateHud(ctx);
  },
});
