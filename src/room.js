// 夜の六畳間（引っ越し前夜）と、ちゃぶ台の上の物の見た目。
// 表示だけを受け持ち、物理には触れない。座標は config.js の LAYOUT とぴったり合わせる：
//   y = 0 が天板（盆の底）の上面、+z が手前（カメラ側）。盆の中には縁のほか何も置かない。
// 文字は手書き風フォント Yomogi で canvas に描き、フォントが読み込めたら描き直す。
// 外部の画像は使わず、模様はすべて canvas で作る。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LAYOUT, DOMINO, DOMINO_COLORS } from './config.js';

// ---------- 配置 ----------

const TB = LAYOUT.table;
const TR = LAYOUT.tray;
const FLOOR_Y = -(TB.thickness + TB.legHeight);     // 畳の面
// 六畳（1単位 ≒ 5cm → 3.6m × 2.7m、天井 2.4m）。奥の壁は天板の奥から 45cm
const ROOM = { x0: -36, x1: 36, z0: -18, z1: 36, h: 48 };
const CEIL_Y = FLOOR_Y + ROOM.h;
const WALL_Z = ROOM.z0;
const WIN = { x0: -30, x1: -12, y0: FLOOR_Y + 14, y1: FLOOR_Y + 32 };   // 奥の壁の腰窓（外枠）
const NAGESHI_Y = FLOOR_Y + 35;                                          // 長押
const CORK = { x: 14, y: FLOOR_Y + 19, w: 16, h: 11 };
const CLOCK = { x: -3, y: FLOOR_Y + 29, r: 2.4 };
const LAMP = { x: -1, y: 15.5, z: -2 };                                  // 電球の位置
const SKY = { x: -21, y: 18, z: -40, w: 120, h: 70 };                     // 窓の外の空（遠くに置いて視差を出す）
const ZABUTON = { x: 4, z: 13.5, ry: 0.12 };

// ---------- 光と色 ----------

const BG = '#0b0908';
const LAMP_COLOR = '#ffb46b';          // 2700K くらい
const LAMP_INTENSITY = 650;            // スポット（影を落とす主光源）
const FILL_INTENSITY = 220;            // 同じ場所の点光源（影なし。影の中と部屋を薄く照らす）
const SHADE_GLOW = 1.1;
const LAMP_DIM_MAX = 0.35;             // setLampDim(1) で暗くなる割合
const HIGHLIGHT = '#ffc98a';
const WOOD_U = 16;                     // 木目テクスチャ1枚の大きさ（単位）
const WOOD_V = 8;
const BOX_CAP = 48;                    // 箱の中に見せるドミノの上限（3列×4行×4段）
const MAX_PHOTOS = 40;
const PHOTO_COLS = 8;                  // コルクボードの並び（8×5）
const PHOTO_ROWS = 5;
const PHOTO_CW = 256;                  // 写真の atlas の1枠（横長のインスタント写真1枚）
const PHOTO_CH = 240;
const PHOTO_WIN = { x: 12, y: 12, w: 232, h: 193 };   // 写真の窓。横:縦 ≒ 6:5（main.js の写真 240×200 と同じ比）
const PHOTO_W = 1.6;                   // 貼った写真の大きさ（単位）
const PHOTO_H = PHOTO_W * (PHOTO_CH / PHOTO_CW);

const TAU = Math.PI * 2;

// ---------- 小さな道具 ----------

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

function toNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// 決まった乱数（毎回同じ見た目にする）
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(n, r) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 角度 a から b への近い回り方の差
function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let maxAniso = 4;
function toTexture(c, { repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  return t;
}

// 1ピクセルずつ色を決める（fn は out に 0〜255 の RGB を書く）
function paintPixels(c, fn) {
  const g = c.getContext('2d');
  const img = g.createImageData(c.width, c.height);
  const d = img.data;
  const out = [0, 0, 0];
  for (let y = 0, i = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++, i += 4) {
      fn(x, y, out);
      d[i] = out[0];
      d[i + 1] = out[1];
      d[i + 2] = out[2];
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

// 細かい粒を重ねる
function noiseOverlay(g, w, h, alpha, r) {
  const tile = makeCanvas(256, 256);
  paintPixels(tile, (x, y, o) => {
    o[0] = o[1] = o[2] = r() * 255;
  });
  const pat = g.createPattern(tile, 'repeat');
  if (!pat) return;
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = pat;
  g.fillRect(0, 0, w, h);
  g.restore();
}

const _rgb = { r: 0, g: 0, b: 0 };
// THREE.Color → canvas 用の色（sRGB）
function css(color, a = 1) {
  color.getRGB(_rgb, THREE.SRGBColorSpace);
  const c = (v) => Math.round(clamp(v, 0, 1) * 255);
  return `rgba(${c(_rgb.r)}, ${c(_rgb.g)}, ${c(_rgb.b)}, ${clamp(a, 0, 1).toFixed(3)})`;
}

// ---------- 形の道具 ----------

// 範囲で指定する箱
function boxSpan(x0, x1, y0, y1, z0, z1) {
  return new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
}

// z を向く板（back = true なら -z を向く）
function planeXY(x0, x1, y0, y1, z, back = false) {
  const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
  if (back) g.rotateY(Math.PI);
  return g.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
}

// x を向く板（facePlusX = false なら -x を向く）
function planeZY(z0, z1, y0, y1, x, facePlusX) {
  const g = new THREE.PlaneGeometry(z1 - z0, y1 - y0);
  g.rotateY(facePlusX ? Math.PI / 2 : -Math.PI / 2);
  return g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
}

// 面の向きごとに座標から UV を作る（テクスチャを一定の密度で貼る）。grain は木目を沿わせる軸
function projectUV(geo, grain = 'x', su = 1 / WOOD_U, sv = 1 / WOOD_V) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let a, b;
    if (ay >= ax && ay >= az) {
      a = grain === 'z' ? z : x;
      b = grain === 'z' ? x : z;
    } else if (ax >= az) {
      a = grain === 'y' ? y : z;
      b = grain === 'y' ? z : y;
    } else {
      a = grain === 'y' ? y : x;
      b = grain === 'y' ? x : y;
    }
    uv[i * 2] = a * su;
    uv[i * 2 + 1] = b * sv;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// 同じ材質の部品を1つにまとめる（描画の回数を減らす）
function mergeParts(parts) {
  const geos = parts.map((g) => {
    if (!g.index) return g;
    const flat = g.toNonIndexed();
    g.dispose();
    return flat;
  });
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('room.js: 部品をまとめられませんでした');
  return merged;
}

// 角の丸い長方形（Shape の座標）
function roundedRectShape(x0, y0, x1, y1, r) {
  const s = new THREE.Shape();
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - r);
  s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y1);
  s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// ---------- 手書きの文字 ----------

const HAND_FAMILY = 'Yomogi';
const HAND_STACK = `${HAND_FAMILY}, "Klee One", "Hiragino Maru Gothic ProN", "Yu Gothic", sans-serif`;
const KNOWN_GLYPHS = 'のこり / 0123456789 ノート はんこ きょうの最長 れん ドミノ ほん 台所 ふゆもの no.';
const handRedraws = new Set();     // フォントが届いたら呼ぶ描き直し
const fontTried = new Set();
let fontsHooked = false;
let redrawTimer = 0;

function handFont(px) {
  return `${Math.round(px)}px ${HAND_STACK}`;
}

// 幅に収まるまで文字を小さくする。決まった大きさを返す
function fitFont(g, text, px, maxW, minPx = 12) {
  let s = px;
  g.font = handFont(s);
  while (s > minPx && g.measureText(text).width > maxW) {
    s *= 0.92;
    g.font = handFont(s);
  }
  return s;
}

function fontSet() {
  return typeof document !== 'undefined' && document.fonts && typeof document.fonts.load === 'function'
    ? document.fonts
    : null;
}

function redrawHandwriting() {
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = 0;
    for (const f of handRedraws) {
      try { f(); } catch { /* 描き直せなくても表示は続ける */ }
    }
  }, 40);
}

function hookFonts() {
  const fonts = fontSet();
  if (!fonts || fontsHooked) return;
  fontsHooked = true;
  try { fonts.addEventListener('loadingdone', redrawHandwriting); } catch { /* 古いブラウザ */ }
  fonts.load(`32px ${HAND_FAMILY}`).then(redrawHandwriting, () => {});
  // 日本語は文字の範囲ごとに分かれて届くので、使う文字を渡して読み込ませる
  fonts.load(`32px ${HAND_FAMILY}`, KNOWN_GLYPHS).then(redrawHandwriting, () => {});
}

// 新しい文字列を描くときに、その文字のフォントを読み込ませる
function needGlyphs(text) {
  const fonts = fontSet();
  const key = String(text ?? '');
  if (!fonts || !key || fontTried.has(key)) return;
  if (fontTried.size > 300) fontTried.clear();
  fontTried.add(key);
  fonts.load(`32px ${HAND_FAMILY}`, key).then(redrawHandwriting, () => {});
}

// ---------- 模様（canvas） ----------

// 木目（横方向につながる。板2枚ぶん）
function makeWoodCanvas() {
  const W = 1024, H = 512, PH = 256;
  const c = makeCanvas(W, H);
  const r = rng(11);
  const planks = [0, 1].map(() => ({
    tone: 0.92 + r() * 0.12, a: r() * TAU, b: r() * TAU, ph: r() * 10, f: 7 + Math.floor(r() * 4),
  }));
  const rowNoise = new Float32Array(H).map(() => r());
  paintPixels(c, (x, y, o) => {
    const p = planks[Math.floor(y / PH)];
    const local = y % PH;
    const u = x / W;
    const wave = 7 * Math.sin(TAU * 2 * u + p.a) + 3 * Math.sin(TAU * 5 * u + p.b + local * 0.03);
    const s = (local + wave) / PH;
    const ring = 0.5 + 0.5 * Math.sin(TAU * (s * p.f + p.ph) + 1.8 * Math.sin(TAU * s * 2 + p.a));
    const late = ring ** 6;
    const fiber = rowNoise[y] * 0.6 + r() * 0.4;
    let v = p.tone * (1 - 0.2 * late - 0.07 * fiber);
    if (local < 2 || local > PH - 3) v *= 0.55;   // 板の継ぎ目
    o[0] = 226 * v;
    o[1] = 206 * v;
    o[2] = 178 * v;
  });
  return c;
}

// 畳6枚（い草の目・畳縁）。キャンバス全体が部屋の床1枚に対応する
function makeTatamiCanvas() {
  const RW = ROOM.x1 - ROOM.x0, RD = ROOM.z1 - ROOM.z0;
  const W = 2048, PX = W / RW, H = Math.round(RD * PX);
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const r = rng(23);
  // 部屋の左奥を原点にした単位で [x0, z0, x1, z1]。四つ目地にならない六畳敷き
  const mats = [
    [0, 0, 36, 18], [36, 0, 72, 18],
    [0, 18, 18, 54], [18, 18, 54, 36], [54, 18, 72, 54],
    [18, 36, 54, 54],
  ];
  for (const [ux0, uz0, ux1, uz1] of mats) {
    const x0 = ux0 * PX, y0 = uz0 * PX, w = (ux1 - ux0) * PX, h = (uz1 - uz0) * PX;
    const horiz = w > h;   // 長手が x 方向
    const tone = 0.93 + r() * 0.1;
    g.fillStyle = `rgb(${Math.round(168 * tone)}, ${Math.round(158 * tone)}, ${Math.round(112 * tone)})`;
    g.fillRect(x0, y0, w, h);
    // い草の目：短辺に平行な細い筋が、長手方向に並ぶ
    const len = horiz ? w : h;
    for (let s = 0; s < len; s += 3) {
      const a = 0.05 + r() * 0.09;
      g.fillStyle = `rgba(70, 60, 28, ${a.toFixed(3)})`;
      if (horiz) g.fillRect(x0 + s, y0, 1.2, h);
      else g.fillRect(x0, y0 + s, w, 1.2);
      g.fillStyle = `rgba(255, 246, 200, ${(a * 0.5).toFixed(3)})`;
      if (horiz) g.fillRect(x0 + s + 1.5, y0, 1, h);
      else g.fillRect(x0, y0 + s + 1.5, w, 1);
    }
    // 経糸（長手方向の細い筋）
    const across = horiz ? h : w;
    g.fillStyle = 'rgba(60, 50, 26, 0.07)';
    for (let s = 6; s < across; s += 11) {
      if (horiz) g.fillRect(x0, y0 + s, w, 1);
      else g.fillRect(x0 + s, y0, 1, h);
    }
    // 日焼けのむら
    const cx = x0 + w / 2, cy = y0 + h / 2;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    grad.addColorStop(0, 'rgba(255, 240, 190, 0.06)');
    grad.addColorStop(1, 'rgba(40, 30, 10, 0.12)');
    g.fillStyle = grad;
    g.fillRect(x0, y0, w, h);
    // 畳縁（長辺の両側）
    const hb = 0.6 * PX;
    g.fillStyle = '#2d2f35';
    if (horiz) {
      g.fillRect(x0, y0, w, hb);
      g.fillRect(x0, y0 + h - hb, w, hb);
    } else {
      g.fillRect(x0, y0, hb, h);
      g.fillRect(x0 + w - hb, y0, hb, h);
    }
    g.fillStyle = 'rgba(190, 180, 150, 0.18)';
    if (horiz) {
      g.fillRect(x0, y0 + hb * 0.5, w, 1);
      g.fillRect(x0, y0 + h - hb * 0.5, w, 1);
    } else {
      g.fillRect(x0 + hb * 0.5, y0, 1, h);
      g.fillRect(x0 + w - hb * 0.5, y0, 1, h);
    }
    // 畳どうしの境目
    g.strokeStyle = 'rgba(30, 24, 12, 0.55)';
    g.lineWidth = 2;
    g.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2);
  }
  noiseOverlay(g, W, H, 0.12, r);
  return c;
}

// 砂壁（繰り返し）
function makePlasterCanvas() {
  const S = 512;
  const c = makeCanvas(S, S);
  const r = rng(41);
  paintPixels(c, (x, y, o) => {
    const u = x / S, v = y / S;
    const blotch = Math.sin(TAU * (u * 2 + v)) * Math.sin(TAU * (v * 3 - u)) * 0.5 + Math.sin(TAU * (u * 5 + 0.3)) * 0.2;
    let k = 1 + blotch * 0.035 + (r() - 0.5) * 0.08;
    if (r() < 0.015) k *= 0.82;
    o[0] = 184 * k;
    o[1] = 170 * k;
    o[2] = 146 * k;
  });
  return c;
}

// 盆の底のフェルト（盆全体に1枚。縁の近くは少し暗い）
function makeFeltCanvas() {
  const W = 1024, H = 512;
  const c = makeCanvas(W, H);
  const r = rng(61);
  const ppu = W / (TR.x1 - TR.x0);
  const aoW = Math.max(1, TR.rimHeight * ppu * 1.2);
  paintPixels(c, (x, y, o) => {
    const d = Math.min(x, W - 1 - x, y, H - 1 - y);
    const ao = 1 - 0.3 * Math.exp(-d / aoW);
    const k = ao * (0.94 + r() * 0.12);
    o[0] = 50 * k;
    o[1] = 68 * k;
    o[2] = 57 * k;
  });
  return c;
}

function makeCorkCanvas() {
  const W = 512, H = 352;
  const c = makeCanvas(W, H);
  const r = rng(71);
  const cw = Math.ceil(W / 3);
  const coarse = new Float32Array(cw * Math.ceil(H / 3)).map(() => r());
  paintPixels(c, (x, y, o) => {
    const k0 = coarse[Math.floor(x / 3) + Math.floor(y / 3) * cw];
    let k = 0.78 + k0 * 0.3 + (r() - 0.5) * 0.12;
    if (r() < 0.02) k *= 0.62;
    o[0] = 176 * k;
    o[1] = 128 * k;
    o[2] = 84 * k;
  });
  return c;
}

// ランプの傘の和紙（横の筋は竹ひご）
function makeWashiCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const r = rng(81);
  paintPixels(c, (x, y, o) => {
    const k = 0.9 + r() * 0.1;
    o[0] = 250 * k;
    o[1] = 238 * k;
    o[2] = 214 * k;
  });
  const g = c.getContext('2d');
  g.lineWidth = 1;
  for (let i = 0; i < 260; i++) {
    const x = r() * S, y = r() * S, a = r() * TAU, l = 6 + r() * 18;
    g.strokeStyle = r() < 0.5 ? 'rgba(255, 255, 255, 0.35)' : 'rgba(170, 140, 100, 0.18)';
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  g.fillStyle = 'rgba(150, 115, 70, 0.45)';
  for (let i = 1; i <= 5; i++) g.fillRect(0, (i / 6) * S - 1.5, S, 3);
  return c;
}

// 座布団（くすんだ藍に絣の柄）
function makeZabutonCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const r = rng(51);
  paintPixels(c, (x, y, o) => {
    const v = 0.92 + r() * 0.12;
    o[0] = 64 * v;
    o[1] = 76 * v;
    o[2] = 104 * v;
  });
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(225, 222, 205, 0.55)';
  g.lineWidth = 2;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const x = 16 + col * 32 + (row % 2) * 16 + (r() - 0.5) * 4;
      const y = 16 + row * 32 + (r() - 0.5) * 4;
      g.beginPath();
      g.moveTo(x - 4, y);
      g.lineTo(x + 4, y);
      g.moveTo(x, y - 4);
      g.lineTo(x, y + 4);
      g.stroke();
    }
  }
  g.fillStyle = '#d9c9a3';   // 真ん中の綴じ糸
  g.beginPath();
  g.arc(S / 2, S / 2, 5, 0, TAU);
  g.fill();
  g.strokeStyle = 'rgba(20, 24, 36, 0.35)';
  g.lineWidth = 3;
  g.strokeRect(6, 6, S - 12, S - 12);
  return c;
}

// 呼び鈴に映り込む部屋（正距円筒）。上がランプ、下が照らされた卓
function makeEnvCanvas() {
  const W = 256, H = 128;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#fff0d4');
  grad.addColorStop(0.12, '#b8844f');
  grad.addColorStop(0.3, '#2a1f18');
  grad.addColorStop(0.5, '#15110e');
  grad.addColorStop(0.62, '#4a3222');
  grad.addColorStop(1, '#2b1d14');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(80, 100, 150, 0.5)';   // 窓
  g.fillRect(W * 0.4, H * 0.32, W * 0.07, H * 0.12);
  return c;
}

// 段ボールの atlas（512 の枠が 2×3）：0 上面のテープ、1 端面のテープ、2〜4 手書きのラベル、5 無地
function makeKraft(labels) {
  const W = 1024, H = 1536, C = 512;
  const base = makeCanvas(W, H);
  const r = rng(31);
  const rows = new Float32Array(H).map(() => r());
  paintPixels(base, (x, y, o) => {
    const v = 0.9 + rows[y] * 0.08 + (r() - 0.5) * 0.1;
    o[0] = 176 * v;
    o[1] = 136 * v;
    o[2] = 92 * v;
  });
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const cell = (i) => [(i % 2) * C, Math.floor(i / 2) * C];
  const tape = (x, y, w, h, vertical) => {
    g.fillStyle = 'rgba(212, 178, 124, 0.9)';
    g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(255, 244, 220, 0.16)';
    if (vertical) g.fillRect(x + w * 0.2, y, w * 0.18, h);
    else g.fillRect(x, y + h * 0.2, w, h * 0.18);
    g.strokeStyle = 'rgba(120, 85, 40, 0.35)';
    g.lineWidth = 2;
    g.beginPath();
    if (vertical) {
      g.moveTo(x, y); g.lineTo(x, y + h);
      g.moveTo(x + w, y); g.lineTo(x + w, y + h);
    } else {
      g.moveTo(x, y); g.lineTo(x + w, y);
      g.moveTo(x, y + h); g.lineTo(x + w, y + h);
    }
    g.stroke();
  };
  function draw() {
    g.drawImage(base, 0, 0);
    // 角の擦れ
    g.strokeStyle = 'rgba(70, 45, 20, 0.25)';
    g.lineWidth = 10;
    for (let i = 0; i < 6; i++) {
      const [x, y] = cell(i);
      g.strokeRect(x + 5, y + 5, C - 10, C - 10);
    }
    let [x, y] = cell(0);
    tape(x, y + C / 2 - 44, C, 88, false);
    [x, y] = cell(1);
    tape(x + C / 2 - 44, y, 88, C * 0.42, true);
    for (const l of labels) {
      [x, y] = cell(l.cell);
      needGlyphs(l.text);
      g.save();
      g.translate(x + C / 2, y + C * 0.46);
      g.scale(1 / l.aspect, 1);   // 面の縦横比で横に伸びるぶんを先に縮めておく
      g.rotate(l.tilt);
      g.fillStyle = 'rgba(38, 32, 28, 0.88)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const s = fitFont(g, l.text, 170, 400 * l.aspect);
      g.fillText(l.text, 0, 0);
      const tw = g.measureText(l.text).width / 2;
      g.strokeStyle = 'rgba(38, 32, 28, 0.8)';
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-tw, s * 0.62);
      g.quadraticCurveTo(0, s * 0.72, tw, s * 0.56);
      g.stroke();
      g.restore();
    }
  }
  draw();
  return { canvas: c, draw, W, H, C };
}

// BoxGeometry の6面（px, nx, py, ny, pz, nz）を atlas の枠に割り当てる
function atlasBox(w, h, d, cells, atlas) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const { W, H, C } = atlas;
  for (let f = 0; f < 6; f++) {
    const i = cells[f];
    const cx = (i % 2) * C, cy = Math.floor(i / 2) * C;
    const u0 = (cx + 4) / W, u1 = (cx + C - 4) / W;
    const v0 = 1 - (cy + C - 4) / H, v1 = 1 - (cy + 4) / H;
    for (let k = 0; k < 4; k++) {
      const j = f * 4 + k;
      uv.setXY(j, u0 + uv.getX(j) * (u1 - u0), v0 + uv.getY(j) * (v1 - v0));
    }
  }
  return geo;
}

// ---------- 窓の外の空 ----------

const SKY_W = 2048, SKY_H = 1024;
const skyPx = (x) => ((x - (SKY.x - SKY.w / 2)) / SKY.w) * SKY_W;
const skyPy = (y) => ((SKY.y + SKY.h / 2 - y) / SKY.h) * SKY_H;

// 時刻ごとの空（19 = 19時、29 = 朝5時）。fill は窓から入る薄い光
const SKY_KEYS = [
  { h: 19.0, top: '#1c2548', hor: '#4b4a74', glow: '#8d6b7e', ga: 0.38, stars: 0.15, fill: '#7a86b4', fi: 0.16 },
  { h: 20.5, top: '#131a37', hor: '#2b3056', glow: '#5b4a67', ga: 0.16, stars: 0.5, fill: '#6f84b8', fi: 0.12 },
  { h: 23.0, top: '#0b1023', hor: '#171d39', glow: '#312b46', ga: 0.06, stars: 0.85, fill: '#6a7fb4', fi: 0.1 },
  { h: 26.0, top: '#080c1c', hor: '#131931', glow: '#2a2640', ga: 0.04, stars: 0.95, fill: '#6a7fb4', fi: 0.1 },
  { h: 27.5, top: '#101a38', hor: '#2d3661', glow: '#5b4e71', ga: 0.16, stars: 0.6, fill: '#7486b6', fi: 0.14 },
  { h: 28.5, top: '#243a6c', hor: '#80799a', glow: '#d19b8b', ga: 0.45, stars: 0.18, fill: '#c3a9b6', fi: 0.35 },
  { h: 29.0, top: '#3d5b8d', hor: '#e6b193', glow: '#ffd7a8', ga: 0.75, stars: 0, fill: '#ffd6b0', fi: 0.75 },
];

function skyAt(hour) {
  let i = 0;
  while (i < SKY_KEYS.length - 2 && hour > SKY_KEYS[i + 1].h) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
  const t = clamp((hour - a.h) / (b.h - a.h), 0, 1);
  const col = (k) => new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
  const num = (k) => a[k] + (b[k] - a[k]) * t;
  return {
    top: col('top'), hor: col('hor'), glow: col('glow'), fill: col('fill'),
    ga: num('ga'), stars: num('stars'), fi: num('fi'),
  };
}

// 遠くの街並み（決まった形）。灯りは夜が更けると少しずつ消える
function makeSkyline() {
  const r = rng(77);
  const far = [], near = [], farLights = [], nearLights = [], stars = [];
  for (let x = -20; x < SKY_W + 20;) {
    const w = 40 + r() * 120;
    const tall = r() < 0.18;
    const topY = tall ? 9 + r() * 6 : 1 + r() * 7;
    const y = skyPy(topY);
    far.push({ x, w, y });
    const rows = Math.floor((skyPy(-8) - y) / 14);
    const cols = Math.floor(w / 16);
    for (let row = 1; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (r() > (tall ? 0.22 : 0.1)) continue;
        farLights.push({ x: x + 6 + col * 16, y: y + row * 14, w: 6, h: 5, off: 21 + r() * 8.5, a: 0.3 + r() * 0.35 });
      }
    }
    x += w + r() * 6;
  }
  for (let x = -40; x < SKY_W + 40;) {
    const w = 110 + r() * 170;
    const y = skyPy(-4 + r() * 5);
    const ridge = 14 + r() * 26;
    near.push({ x, w, y, ridge });
    if (r() < 0.55) {
      nearLights.push({ x: x + w * (0.25 + r() * 0.5), y: y + ridge + 10 + r() * 20, w: 12, h: 9, off: 22 + r() * 8, a: 0.4 + r() * 0.3 });
    }
    x += w + r() * 20;
  }
  const starBottom = skyPy(14);
  for (let i = 0; i < 160; i++) stars.push({ x: r() * SKY_W, y: r() * starBottom, s: r() < 0.15 ? 2 : 1, a: 0.3 + r() * 0.7 });
  return { far, near, farLights, nearLights, stars };
}

function drawSky(c, hour, city) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const k = skyAt(hour);
  const horizon = skyPy(0);
  const grad = g.createLinearGradient(0, 0, 0, horizon);
  grad.addColorStop(0, css(k.top));
  grad.addColorStop(1, css(k.hor));
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  const gy = horizon - H * 0.3;
  const glow = g.createLinearGradient(0, gy, 0, horizon);
  glow.addColorStop(0, css(k.glow, 0));
  glow.addColorStop(1, css(k.glow, k.ga));
  g.fillStyle = glow;
  g.fillRect(0, gy, W, H - gy);
  // 星
  if (k.stars > 0.01) {
    for (const s of city.stars) {
      g.fillStyle = `rgba(235, 238, 255, ${(s.a * k.stars * 0.8).toFixed(3)})`;
      g.fillRect(s.x, s.y, s.s, s.s);
    }
  }
  const farCol = new THREE.Color('#05070c').lerp(k.hor, 0.35);
  const nearCol = new THREE.Color('#030407').lerp(k.hor, 0.12);
  // 遠くのビルと窓の灯り
  g.fillStyle = css(farCol);
  for (const b of city.far) g.fillRect(b.x, b.y, b.w, H - b.y);
  for (const l of city.farLights) {
    if (hour >= l.off) continue;
    g.fillStyle = `rgba(236, 192, 124, ${l.a.toFixed(3)})`;
    g.fillRect(l.x, l.y, l.w, l.h);
  }
  // 手前の家並み（切妻屋根）
  g.fillStyle = css(nearCol);
  for (const h of city.near) {
    g.beginPath();
    g.moveTo(h.x, H);
    g.lineTo(h.x, h.y + h.ridge);
    g.lineTo(h.x + h.w / 2, h.y);
    g.lineTo(h.x + h.w, h.y + h.ridge);
    g.lineTo(h.x + h.w, H);
    g.closePath();
    g.fill();
  }
  for (const l of city.nearLights) {
    if (hour >= l.off) continue;
    const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
    const halo = g.createRadialGradient(cx, cy, 0, cx, cy, 22);
    halo.addColorStop(0, `rgba(240, 190, 120, ${(l.a * 0.25).toFixed(3)})`);
    halo.addColorStop(1, 'rgba(240, 190, 120, 0)');
    g.fillStyle = halo;
    g.fillRect(cx - 22, cy - 22, 44, 44);
    g.fillStyle = `rgba(240, 196, 128, ${l.a.toFixed(3)})`;
    g.fillRect(l.x, l.y, l.w, l.h);
  }
  // 電柱と電線
  const px = skyPx(-33), top = skyPy(24);
  const nearCss = css(nearCol);
  g.fillStyle = nearCss;
  g.fillRect(px - 4, top, 8, H - top);
  g.fillRect(px - 34, top + 26, 68, 5);
  g.fillRect(px - 24, top + 50, 48, 4);
  g.strokeStyle = nearCss;
  g.lineWidth = 1.6;
  for (const wire of [{ dx: 30, dy: 28, sag: 70 }, { dx: 12, dy: 28, sag: 86 }, { dx: 22, dy: 52, sag: 104 }]) {
    for (const side of [-1, 1]) {
      const x0 = px + side * wire.dx, y0 = top + wire.dy;
      const x1 = side < 0 ? -20 : W + 20;
      const y1 = y0 + (side < 0 ? 40 : 24);
      g.beginPath();
      g.moveTo(x0, y0);
      g.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + wire.sag, x1, y1);
      g.stroke();
    }
  }
  return k;
}

// ---------- 手書きの物の絵 ----------

function drawBoxLabel(c, text) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate(-0.015);
  // マスキングテープ（両端はちぎった形）
  const w = W * 0.94, h = H * 0.8, steps = 8;
  g.beginPath();
  g.moveTo(-w / 2, -h / 2);
  g.lineTo(w / 2, -h / 2);
  for (let i = 1; i <= steps; i++) g.lineTo(w / 2 - (i % 2 ? 7 : 0), -h / 2 + (h * i) / steps);
  g.lineTo(-w / 2, h / 2);
  for (let i = steps - 1; i >= 0; i--) g.lineTo(-w / 2 + (i % 2 ? 7 : 0), -h / 2 + (h * i) / steps);
  g.closePath();
  g.fillStyle = 'rgba(234, 223, 198, 0.97)';
  g.fill();
  g.fillStyle = 'rgba(160, 130, 90, 0.12)';
  g.fillRect(-w / 2, -h / 2, w, h * 0.12);
  if (text) {
    needGlyphs(text);
    g.fillStyle = '#3a322b';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, text, h * 0.74, w - 44);
    g.fillText(text, 0, h * 0.04);
  }
  g.restore();
}

// ノートの表紙。左端の 40px は背のテープ（ほかの面の色にも使う）
const NOTE_TAPE_PX = 40;
function drawNoteCover(c, stamps) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = '#8d9fae';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  g.lineWidth = 1;
  for (let x = -H; x < W; x += 6) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + H, H);
    g.stroke();
  }
  g.fillStyle = '#3e4b58';
  g.fillRect(0, 0, NOTE_TAPE_PX, H);
  g.fillStyle = 'rgba(255, 255, 255, 0.08)';
  g.fillRect(NOTE_TAPE_PX - 6, 0, 3, H);
  // 題箋
  g.fillStyle = '#f0eadc';
  g.fillRect(118, 50, 300, 140);
  g.strokeStyle = 'rgba(60, 70, 80, 0.35)';
  g.lineWidth = 2;
  g.strokeRect(126, 58, 284, 124);
  g.fillStyle = '#2f3338';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, 'ノート', 88, 250);
  g.fillText('ノート', 268, 124);
  // はなまるのはんこ
  const sx = 150, sy = 292;
  g.strokeStyle = 'rgba(176, 88, 64, 0.9)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(sx, sy, 20, 0, TAU);
  g.stroke();
  g.lineWidth = 3;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    g.beginPath();
    g.arc(sx + Math.cos(a) * 28, sy + Math.sin(a) * 28, 8, a - 1.3, a + 1.3);
    g.stroke();
  }
  const label = `はんこ ${stamps}`;
  needGlyphs(label);
  g.fillStyle = '#23282d';
  g.textAlign = 'left';
  fitFont(g, label, 50, W - 210);
  g.fillText(label, 196, sy + 2);
  g.fillStyle = 'rgba(255, 255, 255, 0.35)';
  g.fillRect(NOTE_TAPE_PX + 20, H - 22, W - NOTE_TAPE_PX - 40, 2);
}

function drawSticky(c, lines) {
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#dfc466');
  grad.addColorStop(0.18, '#ead37a');
  grad.addColorStop(1, '#e3ca72');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(150, 110, 30, 0.08)';   // 糊の部分
  g.fillRect(0, 0, W, H * 0.16);
  const n = lines.length;
  if (!n) return;
  const base = [0, 60, 52, 44, 38][n];
  const lh = base * 1.22;
  const y0 = H * 0.55 - (lh * (n - 1)) / 2;
  g.fillStyle = '#3b352b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((s, i) => {
    if (!s) return;
    needGlyphs(s);
    fitFont(g, s, base, W - 34);
    g.fillText(s, W / 2 + (i % 2 ? 3 : -2), y0 + i * lh);
  });
}

function drawClockFace(c) {
  const g = c.getContext('2d');
  const S = c.width, R = S / 2;
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#ece3cf';
  g.beginPath();
  g.arc(R, R, R, 0, TAU);
  g.fill();
  g.strokeStyle = '#3a332c';
  g.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU, big = i % 5 === 0;
    const r0 = R * (big ? 0.8 : 0.86), r1 = R * 0.92;
    g.lineWidth = big ? 5 : 2;
    g.beginPath();
    g.moveTo(R + Math.sin(a) * r0, R - Math.cos(a) * r0);
    g.lineTo(R + Math.sin(a) * r1, R - Math.cos(a) * r1);
    g.stroke();
  }
  g.fillStyle = '#3a332c';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = handFont(40);
  for (const [n, f] of [[12, 0], [3, 0.25], [6, 0.5], [9, 0.75]]) {
    const a = f * TAU;
    g.fillText(String(n), R + Math.sin(a) * R * 0.62, R - Math.cos(a) * R * 0.62);
  }
}

// インスタント写真1枚。写真は窓いっぱいに収め、縦横比が違うときは真ん中を切り抜く
function drawPolaroid(g, i, src) {
  const x0 = (i % PHOTO_COLS) * PHOTO_CW, y0 = Math.floor(i / PHOTO_COLS) * PHOTO_CH;
  g.fillStyle = '#d9d1bf';   // 縁の影（atlas の隣の枠と混ざらないよう、枠全体を塗る）
  g.fillRect(x0, y0, PHOTO_CW, PHOTO_CH);
  g.fillStyle = '#eee8da';
  g.fillRect(x0 + 2, y0 + 2, PHOTO_CW - 4, PHOTO_CH - 4);
  const pw = PHOTO_WIN.w, ph = PHOTO_WIN.h;
  const px = x0 + PHOTO_WIN.x, py = y0 + PHOTO_WIN.y;
  g.fillStyle = '#2a2622';
  g.fillRect(px, py, pw, ph);
  const sw = src ? toNum(src.width, 0) || toNum(src.videoWidth, 0) : 0;
  const sh = src ? toNum(src.height, 0) || toNum(src.videoHeight, 0) : 0;
  if (sw > 0 && sh > 0) {
    const s = Math.min(sw / pw, sh / ph);
    const cw = pw * s, ch = ph * s;
    try {
      g.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, px, py, pw, ph);
    } catch { /* 描けない画像は暗いまま */ }
  }
  // 色あせと周辺減光
  g.fillStyle = 'rgba(255, 214, 160, 0.1)';
  g.fillRect(px, py, pw, ph);
  const cx = px + pw / 2, cy = py + ph / 2;
  const v = g.createRadialGradient(cx, cy, pw * 0.3, cx, cy, pw * 0.72);
  v.addColorStop(0, 'rgba(30, 20, 10, 0)');
  v.addColorStop(1, 'rgba(30, 20, 10, 0.35)');
  g.fillStyle = v;
  g.fillRect(px, py, pw, ph);
  drawCaption(g, i);
}

// 写真の下の余白に通し番号を手書きする
function drawCaption(g, i) {
  const x0 = (i % PHOTO_COLS) * PHOTO_CW, y0 = Math.floor(i / PHOTO_COLS) * PHOTO_CH;
  const top = PHOTO_WIN.y + PHOTO_WIN.h + 2;
  g.fillStyle = '#eee8da';
  g.fillRect(x0 + 4, y0 + top, PHOTO_CW - 8, PHOTO_CH - top - 4);
  const s = `no.${i + 1}`;
  needGlyphs(s);
  g.fillStyle = 'rgba(90, 80, 68, 0.9)';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.font = handFont(22);
  g.fillText(s, x0 + PHOTO_CW - 16, y0 + (top + PHOTO_CH - 4) / 2);
}

// ---------- 部屋のつくり ----------

function buildFloor(root) {
  const geo = new THREE.PlaneGeometry(ROOM.x1 - ROOM.x0, ROOM.z1 - ROOM.z0)
    .rotateX(-Math.PI / 2)
    .translate((ROOM.x0 + ROOM.x1) / 2, FLOOR_Y, (ROOM.z0 + ROOM.z1) / 2);
  const mat = new THREE.MeshStandardMaterial({ map: toTexture(makeTatamiCanvas()), roughness: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'tatami';
  mesh.receiveShadow = true;
  root.add(mesh);
}

// 砂壁（窓の穴あき）と、濃い木の部材（畳寄せ・柱・長押・天井）
function buildWalls(root, trim) {
  const { x0, x1, z0, z1 } = ROOM;
  const F = FLOOR_Y, C = CEIL_Y;
  const walls = [
    planeXY(x0, WIN.x0, F, C, z0),
    planeXY(WIN.x1, x1, F, C, z0),
    planeXY(WIN.x0, WIN.x1, F, WIN.y0, z0),
    planeXY(WIN.x0, WIN.x1, WIN.y1, C, z0),
    planeXY(x0, x1, F, C, z1, true),
    planeZY(z0, z1, F, C, x0, true),
    planeZY(z0, z1, F, C, x1, false),
  ].map((g) => projectUV(g, 'x', 1 / 10, 1 / 10));
  const mat = new THREE.MeshStandardMaterial({ map: toTexture(makePlasterCanvas(), { repeat: true }), roughness: 0.96 });
  const mesh = new THREE.Mesh(mergeParts(walls), mat);
  mesh.name = 'walls';
  root.add(mesh);

  const t = 0.35;
  // 畳寄せ
  trim.push(
    projectUV(boxSpan(x0, x1, F, F + 0.9, z0, z0 + t), 'x'),
    projectUV(boxSpan(x0, x1, F, F + 0.9, z1 - t, z1), 'x'),
    projectUV(boxSpan(x0, x0 + t, F, F + 0.9, z0, z1), 'z'),
    projectUV(boxSpan(x1 - t, x1, F, F + 0.9, z0, z1), 'z'),
  );
  // 四隅の柱
  const p = 1.3;
  trim.push(
    projectUV(boxSpan(x0, x0 + p, F, C, z0, z0 + p), 'y'),
    projectUV(boxSpan(x1 - p, x1, F, C, z0, z0 + p), 'y'),
    projectUV(boxSpan(x0, x0 + p, F, C, z1 - p, z1), 'y'),
    projectUV(boxSpan(x1 - p, x1, F, C, z1 - p, z1), 'y'),
  );
  // 長押と回り縁
  for (const [y0, y1, d] of [[NAGESHI_Y, NAGESHI_Y + 1.1, 0.45], [C - 0.5, C, 0.35]]) {
    trim.push(
      projectUV(boxSpan(x0, x1, y0, y1, z0, z0 + d), 'x'),
      projectUV(boxSpan(x0, x1, y0, y1, z1 - d, z1), 'x'),
      projectUV(boxSpan(x0, x0 + d, y0, y1, z0, z1), 'z'),
      projectUV(boxSpan(x1 - d, x1, y0, y1, z0, z1), 'z'),
    );
  }
  // 天井板と竿縁
  trim.push(projectUV(
    new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(Math.PI / 2).translate((x0 + x1) / 2, C, (z0 + z1) / 2), 'x',
  ));
  for (let z = z0 + 9; z < z1 - 1; z += 9) {
    trim.push(projectUV(boxSpan(x0, x1, C - 0.3, C, z - 0.175, z + 0.175), 'x'));
  }
}

// 腰窓の木枠（引き違いの2枚）と、外の空
function buildWindow(root, trim) {
  const fw = 0.8;
  const zb = WALL_Z - 1, zf = WALL_Z + 0.4;
  trim.push(
    projectUV(boxSpan(WIN.x0, WIN.x0 + fw, WIN.y0, WIN.y1, zb, zf), 'y'),
    projectUV(boxSpan(WIN.x1 - fw, WIN.x1, WIN.y0, WIN.y1, zb, zf), 'y'),
    projectUV(boxSpan(WIN.x0, WIN.x1, WIN.y1 - fw, WIN.y1, zb, zf), 'x'),
    projectUV(boxSpan(WIN.x0 - 0.6, WIN.x1 + 0.6, WIN.y0 - 0.4, WIN.y0 + fw, zb, WALL_Z + 0.9), 'x'),
  );
  const ix0 = WIN.x0 + fw, ix1 = WIN.x1 - fw, iy0 = WIN.y0 + fw, iy1 = WIN.y1 - fw;
  const mid = (ix0 + ix1) / 2, my = (iy0 + iy1) / 2, s = 0.4;
  const panes = [
    [ix0, mid + 0.2, WALL_Z - 0.75, WALL_Z - 0.45],
    [mid - 0.2, ix1, WALL_Z - 0.4, WALL_Z - 0.1],
  ];
  for (const [px0, px1, pz0, pz1] of panes) {
    trim.push(
      projectUV(boxSpan(px0, px0 + s, iy0, iy1, pz0, pz1), 'y'),
      projectUV(boxSpan(px1 - s, px1, iy0, iy1, pz0, pz1), 'y'),
      projectUV(boxSpan(px0, px1, iy0, iy0 + s, pz0, pz1), 'x'),
      projectUV(boxSpan(px0, px1, iy1 - s, iy1, pz0, pz1), 'x'),
      projectUV(boxSpan(px0, px1, my - 0.15, my + 0.15, pz0, pz1), 'x'),
    );
  }

  const canvas = makeCanvas(SKY_W, SKY_H);
  const tex = toTexture(canvas);
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(SKY.w, SKY.h),
    new THREE.MeshBasicMaterial({ map: tex, fog: false }),
  );
  sky.name = 'sky';
  sky.position.set(SKY.x, SKY.y, SKY.z);
  root.add(sky);
  const city = makeSkyline();
  return {
    draw(hour) {
      const k = drawSky(canvas, hour, city);
      tex.needsUpdate = true;
      return k;
    },
  };
}

// ちゃぶ台（天板・脚・幕板・盆の縁をまとめて1つ）と盆のフェルト
function buildTable(root, woodTex) {
  const b = 0.12, bt = 0.1;
  const shape = roundedRectShape(TB.x0 + b, -TB.z1 + b, TB.x1 - b, -TB.z0 - b, 1.4);
  const top = new THREE.ExtrudeGeometry(shape, {
    depth: TB.thickness - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: b, bevelSegments: 2, curveSegments: 6,
  });
  // 形の y が -z、押し出しが +y になるよう回し、上面を y = 0 にそろえる
  top.rotateX(-Math.PI / 2);
  top.translate(0, -(TB.thickness - bt), 0);
  const parts = [projectUV(top, 'x')];

  const inset = 2.2, leg = 0.65, apron = 0.18;
  const lxs = [TB.x0 + inset, TB.x1 - inset], lzs = [TB.z0 + inset, TB.z1 - inset];
  for (const x of lxs) {
    for (const z of lzs) parts.push(projectUV(boxSpan(x - leg, x + leg, FLOOR_Y, -TB.thickness, z - leg, z + leg), 'y'));
  }
  const ay0 = -TB.thickness - 0.8, ay1 = -TB.thickness;
  for (const z of lzs) parts.push(projectUV(boxSpan(lxs[0], lxs[1], ay0, ay1, z - apron, z + apron), 'x'));
  for (const x of lxs) parts.push(projectUV(boxSpan(x - apron, x + apron, ay0, ay1, lzs[0], lzs[1]), 'z'));

  // 盆の縁：内側の面が盆の範囲ちょうど、外へ rimThickness、高さ rimHeight
  const t = TR.rimThickness, h = TR.rimHeight;
  parts.push(
    projectUV(boxSpan(TR.x0 - t, TR.x1 + t, 0, h, TR.z0 - t, TR.z0), 'x'),
    projectUV(boxSpan(TR.x0 - t, TR.x1 + t, 0, h, TR.z1, TR.z1 + t), 'x'),
    projectUV(boxSpan(TR.x0 - t, TR.x0, 0, h, TR.z0, TR.z1), 'z'),
    projectUV(boxSpan(TR.x1, TR.x1 + t, 0, h, TR.z0, TR.z1), 'z'),
  );
  const table = new THREE.Mesh(
    mergeParts(parts),
    new THREE.MeshStandardMaterial({ map: woodTex, color: '#b27b50', roughness: 0.55 }),
  );
  table.name = 'chabudai';
  table.castShadow = true;
  table.receiveShadow = true;
  root.add(table);

  // フェルトは天板と同じ高さなので、深度を少し手前に寄せて重なりのちらつきを防ぐ
  const felt = new THREE.Mesh(
    new THREE.PlaneGeometry(TR.x1 - TR.x0, TR.z1 - TR.z0)
      .rotateX(-Math.PI / 2)
      .translate((TR.x0 + TR.x1) / 2, 0, (TR.z0 + TR.z1) / 2),
    new THREE.MeshStandardMaterial({
      map: toTexture(makeFeltCanvas()), roughness: 1,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    }),
  );
  felt.name = 'tray-felt';
  felt.receiveShadow = true;
  root.add(felt);
  return table;
}

// 座布団（角の丸い四角いクッション。真ん中が少しへこむ）
function buildZabuton(root) {
  const hx = 5.5, hz = 6, hy = 0.7;
  const geo = new THREE.SphereGeometry(1, 40, 20);
  const p = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const sx = Math.sign(x) * Math.abs(x) ** 0.28;
    const sz = Math.sign(z) * Math.abs(z) ** 0.28;
    let sy = Math.sign(y) * Math.abs(y) ** 0.7;
    if (sy > 0) sy *= 1 - 0.18 * Math.exp(-(sx * sx + sz * sz) / 0.03);
    p.setXYZ(i, sx * hx, (sy + 1) * hy, sz * hz);
    uv.setXY(i, sx * 0.5 + 0.5, 0.5 - sz * 0.5);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: toTexture(makeZabutonCanvas()), roughness: 0.95 }));
  mesh.name = 'zabuton';
  mesh.position.set(ZABUTON.x, FLOOR_Y, ZABUTON.z);
  mesh.rotation.y = ZABUTON.ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

// 奥の右隅に積んだ段ボール（ガムテープと手書きのラベル）
function buildCardboard(root) {
  const F = FLOOR_Y;
  const specs = [
    { w: 10, h: 7, d: 7.5, x: 29.5, y: F + 3.5, z: -13.4, ry: 0, cell: 2, text: 'ほん', tilt: -0.05 },
    { w: 8.5, h: 6.2, d: 7, x: 29.8, y: F + 3.1, z: -5.0, ry: -0.08, cell: 3, text: '台所', tilt: 0.04 },
    { w: 8, h: 5.5, d: 6.5, x: 29.0, y: F + 7 + 2.75, z: -13.6, ry: 0.1, cell: 4, text: 'ふゆもの', tilt: -0.02 },
  ];
  const atlas = makeKraft(specs.map((s) => ({ cell: s.cell, text: s.text, tilt: s.tilt, aspect: s.w / s.h })));
  const tex = toTexture(atlas.canvas);
  handRedraws.add(() => {
    atlas.draw();
    tex.needsUpdate = true;
  });
  const geos = specs.map((s) => atlasBox(s.w, s.h, s.d, [1, 1, 0, 5, s.cell, 5], atlas).rotateY(s.ry).translate(s.x, s.y, s.z));
  const mesh = new THREE.Mesh(mergeParts(geos), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  mesh.name = 'cardboard';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);
  return mesh;
}

// 吊りランプ（和紙の傘）と光。影を落とすのはスポットの1灯だけ
function buildLamp(root, trim) {
  const shadeBottom = LAMP.y - 0.9;
  const prof = [[3.0, 0], [2.92, 0.3], [2.55, 1.05], [1.8, 1.7], [0.95, 2.1], [0.4, 2.28]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const washi = toTexture(makeWashiCanvas());
  const shadeMat = new THREE.MeshStandardMaterial({
    map: washi, color: '#f3e6cc', roughness: 0.9, side: THREE.DoubleSide,
    emissive: LAMP_COLOR, emissiveMap: washi, emissiveIntensity: SHADE_GLOW,
  });
  const shade = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), shadeMat);
  shade.name = 'lamp-shade';
  shade.position.set(LAMP.x, shadeBottom, LAMP.z);
  root.add(shade);

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), new THREE.MeshBasicMaterial({ color: '#fff0d6' }));
  bulb.position.set(LAMP.x, LAMP.y, LAMP.z);
  root.add(bulb);

  // ソケット・コード・引掛シーリング（濃い木の部材にまとめる）
  const cordY0 = LAMP.y + 1.3;
  trim.push(
    projectUV(new THREE.CylinderGeometry(0.26, 0.3, 0.9, 12).translate(LAMP.x, LAMP.y + 0.85, LAMP.z), 'y'),
    projectUV(new THREE.CylinderGeometry(0.06, 0.06, CEIL_Y - cordY0, 6).translate(LAMP.x, (cordY0 + CEIL_Y) / 2, LAMP.z), 'y'),
    projectUV(new THREE.CylinderGeometry(0.7, 0.8, 0.35, 20).translate(LAMP.x, CEIL_Y - 0.175, LAMP.z), 'x'),
  );

  const spot = new THREE.SpotLight(LAMP_COLOR, LAMP_INTENSITY, 0, 1.15, 0.7, 2);
  spot.name = 'lamp';
  spot.position.set(LAMP.x, LAMP.y, LAMP.z);
  spot.target.position.set(0, 0, 1);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.focus = 0.75;         // 影の範囲を卓のまわりに絞って細かくする
  spot.shadow.camera.near = 3;
  spot.shadow.camera.far = 45;
  spot.shadow.bias = -0.0002;
  spot.shadow.normalBias = 0.025;
  spot.shadow.radius = 3;           // PCF のぼかし（r186 は PCFShadowMap + radius）
  root.add(spot, spot.target);

  const fill = new THREE.PointLight(LAMP_COLOR, FILL_INTENSITY, 0, 2);
  fill.name = 'lamp-fill';
  fill.position.set(LAMP.x, LAMP.y + 0.2, LAMP.z);
  root.add(fill);

  return { spot, fill, shadeMat };
}

// ---------- 卓の上の物 ----------

function makeGlow() {
  return { cur: 0, target: 0 };
}

function stepGlow(gl, dt) {
  gl.cur += (gl.target - gl.cur) * (1 - Math.exp(-10 * dt));
  if (Math.abs(gl.target - gl.cur) < 0.001) gl.cur = gl.target;
  return gl.cur;
}

// ドミノの木箱（上が開いている）。中に平らに積んだドミノを在庫に合わせて見せる
function buildBox(woodTex) {
  const L = LAYOUT.box;
  const W = L.hx * 2, D = L.hz * 2, H = L.height;
  const wall = 0.12, bottom = 0.1;
  const group = new THREE.Group();
  group.name = 'domino-box';
  group.position.set(L.x, 0, L.z);

  const mat = new THREE.MeshStandardMaterial({
    map: woodTex, color: '#e2c49c', roughness: 0.62,
    emissive: HIGHLIGHT, emissiveMap: woodTex, emissiveIntensity: 0,
  });
  const shell = new THREE.Mesh(mergeParts([
    projectUV(new RoundedBoxGeometry(W, bottom, D, 1, 0.02).translate(0, bottom / 2, 0), 'x'),
    projectUV(new RoundedBoxGeometry(W, H, wall, 1, 0.03).translate(0, H / 2, L.hz - wall / 2), 'x'),
    projectUV(new RoundedBoxGeometry(W, H, wall, 1, 0.03).translate(0, H / 2, -L.hz + wall / 2), 'x'),
    projectUV(new RoundedBoxGeometry(wall, H, D - wall * 2, 1, 0.03).translate(L.hx - wall / 2, H / 2, 0), 'z'),
    projectUV(new RoundedBoxGeometry(wall, H, D - wall * 2, 1, 0.03).translate(-L.hx + wall / 2, H / 2, 0), 'z'),
  ]), mat);
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // 中のドミノ：寝かせて 3列×4行、4段まで。段ごとに決まった順で埋まる
  const pieces = new THREE.InstancedMesh(
    new RoundedBoxGeometry(DOMINO.h, DOMINO.t, DOMINO.w, 1, 0.02),
    new THREE.MeshStandardMaterial({ roughness: 0.45 }),
    BOX_CAP,
  );
  pieces.castShadow = true;
  pieces.receiveShadow = true;
  pieces.frustumCulled = false;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  const r = rng(5);
  const pitchX = DOMINO.h + 0.02, pitchZ = DOMINO.w + 0.005;
  let i = 0;
  for (let layer = 0; layer < 4; layer++) {
    for (const k of shuffled(12, r)) {
      const cx = k % 3, rz = Math.floor(k / 3);
      p.set(
        (cx - 1) * pitchX + (r() - 0.5) * 0.02,
        bottom + DOMINO.t / 2 + layer * (DOMINO.t + 0.004),
        (rz - 1.5) * pitchZ + (r() - 0.5) * 0.015,
      );
      q.setFromEuler(e.set(0, (r() - 0.5) * 0.04, 0));
      pieces.setMatrixAt(i, m.compose(p, q, one));
      pieces.setColorAt(i, col.set(DOMINO_COLORS[Math.floor(r() * DOMINO_COLORS.length)]));
      i++;
    }
  }
  pieces.instanceMatrix.needsUpdate = true;
  if (pieces.instanceColor) pieces.instanceColor.needsUpdate = true;
  pieces.count = 0;
  pieces.visible = false;
  group.add(pieces);

  // 前の面のラベル（マスキングテープに手書き）
  const labelCanvas = makeCanvas(512, 136);
  const labelTex = toTexture(labelCanvas);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(3.0, 0.8),
    new THREE.MeshStandardMaterial({ map: labelTex, transparent: true, alphaTest: 0.02, roughness: 0.85 }),
  );
  label.position.set(0, H * 0.5, L.hz + 0.004);
  group.add(label);
  let labelText = 'ドミノ';
  const redrawLabel = () => {
    drawBoxLabel(labelCanvas, labelText);
    labelTex.needsUpdate = true;
  };
  handRedraws.add(redrawLabel);
  redrawLabel();

  const glow = makeGlow();
  const api = {
    group,
    // n 個のうち max 個ぶん。見せる数は n/max に比例（上限 48）、ただし n 個より多くは見せない
    setCount(n, max) {
      const nn = Math.max(0, Math.floor(toNum(n, 0)));
      const mm = toNum(max, 0);
      const ratio = mm > 0 ? clamp(nn / mm, 0, 1) : (nn > 0 ? 1 : 0);
      let k = Math.min(nn, Math.round(ratio * BOX_CAP));
      if (nn > 0 && k < 1) k = 1;
      pieces.count = k;
      pieces.visible = k > 0;
    },
    setHighlight(on) {
      glow.target = on ? 1 : 0;
    },
    setLabel(text) {
      const s = String(text ?? '');
      if (s === labelText) return;
      labelText = s;
      redrawLabel();
    },
  };
  return {
    api,
    casters: [shell, pieces],
    update(dt) {
      mat.emissiveIntensity = 0.25 * stepGlow(glow, dt);
    },
  };
}

// 閉じたノート（強化）。表紙に「ノート」と、はんこの数
function buildNote() {
  const L = LAYOUT.note;
  const W = L.hx * 2, D = L.hz * 2, H = L.height;
  const ct = 0.035;
  const group = new THREE.Group();
  group.name = 'note';
  group.position.set(L.x, 0, L.z);
  group.rotation.y = -0.04;

  const canvas = makeCanvas(512, 376);
  const tex = toTexture(canvas);
  let stamps = 0;
  const redraw = () => {
    drawNoteCover(canvas, stamps);
    tex.needsUpdate = true;
  };
  handRedraws.add(redraw);
  redraw();

  // 上の表紙の上面だけに絵を貼り、ほかの面（裏表紙・背・小口）は背のテープの色
  const tapeU = (NOTE_TAPE_PX * 0.4) / canvas.width, tapeV = 0.5;
  const solid = (g) => {
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, tapeU, tapeV);
    return g;
  };
  const cover = new THREE.BoxGeometry(W, ct, D).translate(0, H - ct / 2, 0);
  const cuv = cover.attributes.uv;
  for (let k = 0; k < cuv.count; k++) {
    if (k >= 8 && k < 12) continue;   // py（上面）
    cuv.setXY(k, tapeU, tapeV);
  }
  const coverMat = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.8, emissive: HIGHLIGHT, emissiveMap: tex, emissiveIntensity: 0,
  });
  const coverMesh = new THREE.Mesh(mergeParts([
    cover,
    solid(new THREE.BoxGeometry(W, ct, D).translate(0, ct / 2, 0)),
    solid(new THREE.BoxGeometry(0.08, H, D).translate(-W / 2 + 0.04, H / 2, 0)),
  ]), coverMat);
  coverMesh.castShadow = true;
  coverMesh.receiveShadow = true;
  const pages = new THREE.Mesh(
    new RoundedBoxGeometry(W - 0.1, H - 2 * ct, D - 0.08, 1, 0.015).translate(0.02, H / 2, 0),
    new THREE.MeshStandardMaterial({ color: '#ece4d2', roughness: 0.9 }),
  );
  pages.castShadow = true;
  pages.receiveShadow = true;
  group.add(coverMesh, pages);

  const glow = makeGlow();
  const api = {
    group,
    setHighlight(on) {
      glow.target = on ? 1 : 0;
    },
    setStamps(n) {
      const v = Math.max(0, Math.floor(toNum(n, 0)));
      if (v === stamps) return;
      stamps = v;
      redraw();
    },
  };
  return {
    api,
    casters: [coverMesh, pages],
    update(dt) {
      coverMat.emissiveIntensity = 0.22 * stepGlow(glow, dt);
    },
  };
}

// 付箋（今日の最長）。手前の端が少し反っている
function buildSticky() {
  const L = LAYOUT.sticky;
  const SW = L.hx * 2, SD = L.hz * 2;
  const geo = new THREE.PlaneGeometry(SW, SD, 8, 8);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((-pos.getY(i) / (SD / 2) - 0.2) / 0.8, 0, 1);   // 下（手前）の 4 割が反る
    pos.setZ(i, 0.06 * t * t);
  }
  geo.computeVertexNormals();
  geo.rotateX(-Math.PI / 2);

  const canvas = makeCanvas(256, 256);
  const tex = toTexture(canvas);
  let lines = ['きょうの最長', '0 れん'];
  const redraw = () => {
    drawSticky(canvas, lines);
    tex.needsUpdate = true;
  };
  handRedraws.add(redraw);
  redraw();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide }));
  mesh.name = 'sticky';
  mesh.position.set(L.x, L.height, L.z);
  mesh.rotation.y = 0.05;
  mesh.receiveShadow = true;

  const api = {
    group: mesh,
    setLines(next) {
      let list = Array.isArray(next) ? next : String(next ?? '').split('\n');
      list = list.slice(0, 4).map((s) => String(s ?? '').trim());
      if (list.length === lines.length && list.every((s, i) => s === lines[i])) return;
      lines = list;
      redraw();
    },
  };
  return { api, mesh };
}

// 卓上の呼び鈴（木の台に真鍮のドーム）
function buildBell(woodTex, envTex) {
  const L = LAYOUT.bell;
  const group = new THREE.Group();
  group.name = 'bell';
  group.position.set(L.x, 0, L.z);

  const baseH = 0.17;
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(L.r - 0.05, L.r, baseH, 40).translate(0, baseH / 2, 0),
    new THREE.MeshStandardMaterial({ map: woodTex, color: '#3b2b21', roughness: 0.55 }),
  );
  base.castShadow = true;
  base.receiveShadow = true;

  const brass = new THREE.MeshStandardMaterial({
    color: '#d0aa66', metalness: 0.85, roughness: 0.28, envMap: envTex, envMapIntensity: 1,
    emissive: HIGHLIGHT, emissiveIntensity: 0,
  });
  const top = new THREE.Group();
  top.position.y = baseH;
  const domeR = L.r - 0.1, domeH = 0.47;
  const prof = [new THREE.Vector2(domeR + 0.03, 0), new THREE.Vector2(domeR, 0.025)];
  for (let i = 1; i <= 14; i++) {
    const a = (i / 14) * (Math.PI / 2);
    prof.push(new THREE.Vector2(Math.max(0, domeR * Math.cos(a)), 0.025 + (domeH - 0.025) * Math.sin(a)));
  }
  const dome = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), brass);
  dome.castShadow = true;
  dome.receiveShadow = true;

  // 押しボタン：上端がちょうど L.height になる
  const capR = 0.12, capSy = 0.55;
  const capY = L.height - baseH - capR * capSy;
  const plunger = new THREE.Mesh(mergeParts([
    new THREE.CylinderGeometry(0.045, 0.045, 0.22, 12).translate(0, domeH - 0.04 + 0.11, 0),
    new THREE.SphereGeometry(capR, 20, 12).scale(1, capSy, 1).translate(0, capY, 0),
  ]), brass);
  plunger.castShadow = true;
  top.add(dome, plunger);
  group.add(base, top);

  const PRESS_DEPTH = 0.1;
  const glow = makeGlow();
  let press = 0, pressTarget = 0, ringT = Infinity;
  const api = {
    group,
    setHighlight(on) {
      glow.target = on ? 1 : 0;
    },
    setPress(v) {
      pressTarget = clamp(toNum(v, 0), 0, 1);
    },
    ring() {
      ringT = 0;
    },
  };
  return {
    api,
    casters: [base, dome, plunger],
    update(dt) {
      brass.emissiveIntensity = 0.3 * stepGlow(glow, dt);
      press += (pressTarget - press) * (1 - Math.exp(-30 * dt));
      let tap = 0;
      if (ringT < 1.6) {
        ringT += dt;
        const wob = 0.05 * Math.exp(-ringT * 3.2);
        const w = ringT * TAU * 6.5;
        top.rotation.x = wob * Math.sin(w);
        top.rotation.z = wob * 0.7 * Math.sin(w + 1.2);
        tap = Math.exp(-ringT * 16) * 0.8;
      } else {
        top.rotation.x = 0;
        top.rotation.z = 0;
      }
      plunger.position.y = -PRESS_DEPTH * Math.max(press, tap);
    },
  };
}

// ---------- 壁の物 ----------

// コルクボード。写真はポラロイドにして、決まった位置・角度でピン留めする
function buildCorkboard(root, trim) {
  const fw = 0.5;
  const cx0 = CORK.x - CORK.w / 2, cx1 = CORK.x + CORK.w / 2;
  const cy0 = CORK.y - CORK.h / 2, cy1 = CORK.y + CORK.h / 2;
  trim.push(
    projectUV(boxSpan(cx0, cx1, cy1 - fw, cy1, WALL_Z, WALL_Z + 0.5), 'x'),
    projectUV(boxSpan(cx0, cx1, cy0, cy0 + fw, WALL_Z, WALL_Z + 0.5), 'x'),
    projectUV(boxSpan(cx0, cx0 + fw, cy0 + fw, cy1 - fw, WALL_Z, WALL_Z + 0.5), 'y'),
    projectUV(boxSpan(cx1 - fw, cx1, cy0 + fw, cy1 - fw, WALL_Z, WALL_Z + 0.5), 'y'),
  );
  const group = new THREE.Group();
  group.name = 'corkboard';
  group.position.set(CORK.x, CORK.y, WALL_Z);
  root.add(group);

  const iw = CORK.w - fw * 2, ih = CORK.h - fw * 2;
  const cork = new THREE.Mesh(
    new THREE.PlaneGeometry(iw, ih),
    new THREE.MeshStandardMaterial({ map: toTexture(makeCorkCanvas()), roughness: 0.95 }),
  );
  cork.position.z = 0.35;
  group.add(cork);

  // 写真の板（全部を1つの形にして、貼った枚数だけ描く）
  const atlas = makeCanvas(PHOTO_COLS * PHOTO_CW, PHOTO_ROWS * PHOTO_CH);
  const ag = atlas.getContext('2d');
  const atlasTex = toTexture(atlas);
  const AW = atlas.width, AH = atlas.height;
  const PW = PHOTO_W, PH = PHOTO_H;
  const pitchX = iw / PHOTO_COLS, pitchY = ih / PHOTO_ROWS;
  const pos = new Float32Array(MAX_PHOTOS * 4 * 3);
  const nor = new Float32Array(MAX_PHOTOS * 4 * 3);
  const uvs = new Float32Array(MAX_PHOTOS * 4 * 2);
  const idx = [];
  const pinAt = [];
  for (let i = 0; i < MAX_PHOTOS; i++) {
    const r = rng(1000 + i * 7919);
    const col = i % PHOTO_COLS, row = Math.floor(i / PHOTO_COLS);
    const cx = -iw / 2 + (col + 0.5) * pitchX + (r() - 0.5) * 0.22;
    const cy = ih / 2 - (row + 0.5) * pitchY + (r() - 0.5) * 0.18;
    const ang = (r() - 0.5) * 0.24;
    const z = 0.36 + i * 0.002;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const corners = [[-PW / 2, PH / 2], [PW / 2, PH / 2], [-PW / 2, -PH / 2], [PW / 2, -PH / 2]];
    const ax = col * PHOTO_CW, ay = row * PHOTO_CH;
    const u0 = (ax + 1) / AW, u1 = (ax + PHOTO_CW - 1) / AW;
    const vt = 1 - (ay + 1) / AH, vb = 1 - (ay + PHOTO_CH - 1) / AH;
    const cuv = [[u0, vt], [u1, vt], [u0, vb], [u1, vb]];
    corners.forEach(([lx, ly], k) => {
      const o = (i * 4 + k) * 3;
      pos[o] = cx + lx * cs - ly * sn;
      pos[o + 1] = cy + lx * sn + ly * cs;
      pos[o + 2] = z;
      nor[o + 2] = 1;
      uvs[(i * 4 + k) * 2] = cuv[k][0];
      uvs[(i * 4 + k) * 2 + 1] = cuv[k][1];
    });
    const b = i * 4;
    idx.push(b, b + 2, b + 1, b + 2, b + 3, b + 1);
    const ly = PH / 2 - 0.16;   // ピンは写真の上のほうの真ん中
    pinAt.push({ x: cx - ly * sn, y: cy + ly * cs, z: z + 0.05, color: ['#b8644c', '#8fa37f', '#6f86a0', '#d9c9a3'][Math.floor(r() * 4)] });
  }
  const photoGeo = new THREE.BufferGeometry();
  photoGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  photoGeo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  photoGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  photoGeo.setIndex(idx);
  photoGeo.setDrawRange(0, 0);
  const photos = new THREE.Mesh(photoGeo, new THREE.MeshStandardMaterial({ map: atlasTex, roughness: 0.6 }));
  photos.frustumCulled = false;
  photos.visible = false;
  group.add(photos);

  const pins = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.11, 12, 8),
    new THREE.MeshStandardMaterial({ roughness: 0.35 }),
    MAX_PHOTOS,
  );
  const m = new THREE.Matrix4(), c = new THREE.Color();
  pinAt.forEach((pp, i) => {
    pins.setMatrixAt(i, m.makeTranslation(pp.x, pp.y, pp.z));
    pins.setColorAt(i, c.set(pp.color));
  });
  pins.instanceMatrix.needsUpdate = true;
  if (pins.instanceColor) pins.instanceColor.needsUpdate = true;
  pins.count = 0;
  pins.visible = false;
  pins.frustumCulled = false;
  group.add(pins);

  let count = 0;
  handRedraws.add(() => {
    if (!count) return;
    for (let i = 0; i < count; i++) drawCaption(ag, i);
    atlasTex.needsUpdate = true;
  });

  const api = {
    group,
    // 写真（canvas / 画像）を1枚貼る。貼った番号を返す。いっぱいなら -1
    addPhoto(src) {
      if (count >= MAX_PHOTOS) return -1;
      const i = count;
      drawPolaroid(ag, i, src);
      count++;
      atlasTex.needsUpdate = true;
      photoGeo.setDrawRange(0, count * 6);
      photos.visible = true;
      pins.count = count;
      pins.visible = true;
      return i;
    },
  };
  return { api };
}

// 壁掛け時計。秒針はコチコチ動く
function buildClock(root, trim) {
  const faceZ = WALL_Z + 0.31;
  trim.push(
    projectUV(new THREE.CylinderGeometry(CLOCK.r + 0.1, CLOCK.r + 0.1, 0.3, 40)
      .rotateX(Math.PI / 2).translate(CLOCK.x, CLOCK.y, WALL_Z + 0.15), 'x'),
    projectUV(new THREE.TorusGeometry(CLOCK.r + 0.08, 0.2, 10, 48).translate(CLOCK.x, CLOCK.y, WALL_Z + 0.32), 'x'),
  );
  const canvas = makeCanvas(256, 256);
  const tex = toTexture(canvas);
  const redraw = () => {
    drawClockFace(canvas);
    tex.needsUpdate = true;
  };
  handRedraws.add(redraw);
  redraw();
  const face = new THREE.Mesh(new THREE.CircleGeometry(CLOCK.r, 48), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
  face.position.set(CLOCK.x, CLOCK.y, faceZ);
  root.add(face);

  const hands = new THREE.Group();
  hands.name = 'clock';
  hands.position.set(CLOCK.x, CLOCK.y, faceZ);
  root.add(hands);
  const dark = new THREE.MeshStandardMaterial({ color: '#2c2723', roughness: 0.5 });
  const hand = (w, len, tail, z) => new THREE.BoxGeometry(w, len, 0.03).translate(0, len / 2 - tail, z);
  const hourHand = new THREE.Mesh(mergeParts([
    hand(0.16, 1.35, 0.2, 0.03),
    new THREE.CylinderGeometry(0.14, 0.14, 0.06, 16).rotateX(Math.PI / 2).translate(0, 0, 0.1),
  ]), dark);
  const minuteHand = new THREE.Mesh(hand(0.1, 2.0, 0.25, 0.06), dark);
  const secondHand = new THREE.Mesh(hand(0.04, 2.3, 0.4, 0.09), new THREE.MeshStandardMaterial({ color: '#a8604a', roughness: 0.5 }));
  hands.add(hourHand, minuteHand, secondHand);

  let hourA = 0, minA = 0, hourT = 0, minT = 0, snap = true;
  const api = {
    group: hands,
    set(hour, minute) {
      const m = toNum(minute, 0);
      const h = toNum(hour, 0);
      minT = ((((m % 60) + 60) % 60) / 60) * TAU;
      hourT = (((((h % 12) + 12) % 12) + m / 60) / 12) * TAU;
    },
  };
  return {
    api,
    update(dt, time) {
      const k = snap ? 1 : 1 - Math.exp(-6 * dt);
      snap = false;
      hourA += angleDelta(hourA, hourT) * k;
      minA += angleDelta(minA, minT) * k;
      hourHand.rotation.z = -hourA;
      minuteHand.rotation.z = -minA;
      const sec = ((time % 60) + 60) % 60;
      const whole = Math.floor(sec);
      const f = clamp((sec - whole) / 0.15, 0, 1);
      secondHand.rotation.z = -((whole + f * f * (3 - 2 * f)) / 60) * TAU;
    },
  };
}

// ---------- まとめ ----------

export function buildRoom(scene, renderer) {
  if (renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    maxAniso = Math.max(1, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  }
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 60, 150);
  handRedraws.clear();   // 部屋は1ページに1つ。作り直したときに前の部屋の canvas を持ち続けない
  hookFonts();

  const root = new THREE.Group();
  root.name = 'room';
  scene.add(root);

  const woodTex = toTexture(makeWoodCanvas(), { repeat: true });
  const trim = [];   // 濃い木の部材（最後に1つのメッシュにまとめる）

  buildFloor(root);
  buildWalls(root, trim);
  const sky = buildWindow(root, trim);
  const table = buildTable(root, woodTex);
  const zabuton = buildZabuton(root);
  const cardboard = buildCardboard(root);
  const lamp = buildLamp(root, trim);
  const cork = buildCorkboard(root, trim);
  const clock = buildClock(root, trim);

  const trimMesh = new THREE.Mesh(
    mergeParts(trim),
    new THREE.MeshStandardMaterial({ map: woodTex, color: '#5a4535', roughness: 0.75 }),
  );
  trimMesh.name = 'trim';
  root.add(trimMesh);

  const envTex = toTexture(makeEnvCanvas());
  envTex.mapping = THREE.EquirectangularReflectionMapping;
  const box = buildBox(woodTex);
  const note = buildNote();
  const sticky = buildSticky();
  const bell = buildBell(woodTex, envTex);
  root.add(box.api.group, note.api.group, sticky.mesh, bell.api.group);

  // 部屋の暗がり：ごく弱い青みの環境光と、窓から入る薄い光
  const hemi = new THREE.HemisphereLight('#5b6888', '#2a2019', 0.35);
  const winLight = new THREE.DirectionalLight('#6f84b8', 0.12);
  winLight.name = 'window-light';
  winLight.position.set((WIN.x0 + WIN.x1) / 2, WIN.y1 + 8, WALL_Z - 30);
  winLight.target.position.set(0, 0, 0);
  root.add(hemi, winLight, winLight.target);

  let hour = NaN;
  let dim = 0, dimTarget = 0, time = 0;

  function setTimeOfDay(h) {
    const v = clamp(toNum(h, 19), 19, 29);
    if (Math.abs(v - hour) < 0.01) return;
    hour = v;
    const k = sky.draw(v);
    winLight.color.copy(k.fill);
    winLight.intensity = k.fi;
    hemi.intensity = 0.35 + 0.2 * clamp((v - 27.5) / 1.5, 0, 1);
  }

  function setLampDim(t) {
    dimTarget = clamp(toNum(t, 0), 0, 1);
  }

  function update(dt, t) {
    const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    time = Number.isFinite(t) ? t : time + d;
    dim += (dimTarget - dim) * (1 - Math.exp(-3 * d));
    // ランプの息づかい（±2%）
    const breath = 1 + 0.02 * (0.6 * Math.sin(time * 0.83) + 0.4 * Math.sin(time * 2.07 + 1.3));
    const k = breath * (1 - LAMP_DIM_MAX * dim);
    lamp.spot.intensity = LAMP_INTENSITY * k;
    lamp.fill.intensity = FILL_INTENSITY * k;
    lamp.shadeMat.emissiveIntensity = SHADE_GLOW * k;
    box.update(d);
    note.update(d);
    bell.update(d);
    clock.update(d, time);
  }

  setTimeOfDay(19);
  clock.api.set(19, 0);
  box.api.setCount(0, 0);
  update(0, 0);

  return {
    update,
    setTimeOfDay,
    setLampDim,
    box: box.api,
    note: note.api,
    sticky: sticky.api,
    bell: bell.api,
    corkboard: cork.api,
    clock: clock.api,
    shadowCasters: [table, zabuton, cardboard, ...box.casters, ...note.casters, ...bell.casters],
    lights: { lamp: lamp.spot, fill: lamp.fill, window: winLight, hemi },
    group: root,
  };
}
