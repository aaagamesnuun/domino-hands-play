// 画面全体にかけるフィルムの質感：細かい粒（グレイン）と周辺の暗さ（ビネット）。
// 見た目だけの重ね絵で、pointer-events: none なので操作の邪魔をしない。
// 粒は小さなノイズのタイルを毎秒12回ほど描き直し、画面いっぱいに敷き詰めて overlay で重ねる。
// 「視差効果を減らす」（prefers-reduced-motion）のときは粒を止めたままにする。

const GRAIN_FPS = 12;
const GRAIN_OPACITY = 0.05;
const GRAIN_SCALE = 1.5;          // 粒の大きさ（CSS ピクセル）。キャンバスを粗くして引き伸ばし、少しやわらかくする
const TILE = 128;                 // ノイズのタイルの一辺
const DEFAULT_VIGNETTE = 0.6;
const Z_INDEX = 40;               // 3D の画面と手書きラベルより上。ほかの UI はこの値で重なりを調整する

// 周辺の暗さ。真ん中は素通しで、四隅に向かってランプの届かない部屋の暗さに沈む
const VIGNETTE_BG =
  'radial-gradient(ellipse at 50% 46%, rgba(12, 8, 5, 0) 50%, rgba(12, 8, 5, 0.38) 76%, rgba(6, 4, 3, 0.82) 100%)';

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function fixedLayer(el, z) {
  const s = el.style;
  s.position = 'fixed';
  s.left = '0';
  s.top = '0';
  s.width = '100%';
  s.height = '100%';
  s.pointerEvents = 'none';
  s.zIndex = String(z);
  el.setAttribute('aria-hidden', 'true');
}

// container（ふつうは document.body）に重ね絵を置く。
// mix-blend-mode を 3D の画面に効かせるため、粒のキャンバスは container の直下に置く
// （包む要素を作ると、その中だけで混ざってしまう）。
export function mountFilmOverlay(container) {
  const parent = container || document.body;

  const vignette = document.createElement('div');
  vignette.className = 'film-vignette';
  fixedLayer(vignette, Z_INDEX);
  vignette.style.background = VIGNETTE_BG;
  vignette.style.opacity = String(DEFAULT_VIGNETTE);
  vignette.style.transition = 'opacity 0.6s ease';

  const grain = document.createElement('canvas');
  grain.className = 'film-grain';
  fixedLayer(grain, Z_INDEX + 1);
  grain.style.opacity = String(GRAIN_OPACITY);
  grain.style.mixBlendMode = 'overlay';
  grain.width = 1;
  grain.height = 1;

  parent.appendChild(vignette);
  parent.appendChild(grain);

  const gctx = grain.getContext('2d');
  const tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const tctx = tile.getContext('2d');
  const noise = tctx ? tctx.createImageData(TILE, TILE) : null;

  // タイルに新しいノイズを描く。一様乱数3つの和で、灰色のまわりに寄ったやわらかい粒にする
  function paintTile() {
    const d = noise.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 160;
      d[i] = v;             // Uint8ClampedArray なので 0〜255 に収まる
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    tctx.putImageData(noise, 0, 0);
  }

  function drawGrain() {
    if (!gctx || !tctx || !noise) return;
    paintTile();
    const pattern = gctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    // 敷き詰めの継ぎ目が同じ場所に並ばないよう、毎回ずらす
    const ox = Math.floor(Math.random() * TILE);
    const oy = Math.floor(Math.random() * TILE);
    gctx.setTransform(1, 0, 0, 1, -ox, -oy);
    gctx.fillStyle = pattern;
    gctx.fillRect(ox, oy, grain.width, grain.height);
    gctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function resize() {
    const w = Math.max(1, Math.ceil((window.innerWidth || 1) / GRAIN_SCALE));
    const h = Math.max(1, Math.ceil((window.innerHeight || 1) / GRAIN_SCALE));
    if (grain.width === w && grain.height === h) return;
    grain.width = w;          // 大きさを変えると中身が消えるので描き直す
    grain.height = h;
    drawGrain();
  }

  // ---------- 動き（~12fps） ----------
  let raf = 0;
  let last = -Infinity;
  let destroyed = false;
  const frameMs = 1000 / GRAIN_FPS;

  function tick(now) {
    raf = requestAnimationFrame(tick);
    // 60Hz / 120Hz のどちらでも、ほぼ 12 回/秒になるよう少し余裕をもたせる
    if (now - last < frameMs - 4) return;
    last = now;
    drawGrain();
  }

  const motionQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function syncMotion() {
    if (destroyed) return;
    const still = !!(motionQuery && motionQuery.matches);
    if (still) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      drawGrain();            // 止めた粒を1枚だけ描く
    } else if (!raf) {
      last = -Infinity;
      raf = requestAnimationFrame(tick);
    }
  }

  function listenMotion(on) {
    if (!motionQuery) return;
    if (typeof motionQuery.addEventListener === 'function') {
      if (on) motionQuery.addEventListener('change', syncMotion);
      else motionQuery.removeEventListener('change', syncMotion);
    } else if (typeof motionQuery.addListener === 'function') {
      // 古い Safari
      if (on) motionQuery.addListener(syncMotion);
      else motionQuery.removeListener(syncMotion);
    }
  }

  window.addEventListener('resize', resize);
  listenMotion(true);
  resize();
  syncMotion();

  return {
    // v: 0（なし）〜 1（濃い）。ゆっくり変わる
    setVignette(v) {
      const n = Number(v);
      if (!Number.isFinite(n) || destroyed) return;
      vignette.style.opacity = String(clamp01(n));
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener('resize', resize);
      listenMotion(false);
      vignette.remove();
      grain.remove();
    },
  };
}
