// マウス・キーボード → 手の入力とカメラ操作。

const PAN_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

const ACTION_KEYS = {
  KeyQ: 'rotL', KeyE: 'rotR', Tab: 'tool', Digit1: 'toolDomino', Digit2: 'toolStopper',
  KeyM: 'mute',
};

export class Input {
  constructor(canvas, view, onAction) {
    this.canvas = canvas;
    this.view = view;
    this.onAction = onAction;
    this.ndc = { x: 0, y: 0 };
    this.hasPointer = false;
    this.primary = false;   // 左ボタンを押している間 true（手を下ろしたまま・呼び鈴を押し続ける）
    this.pressSeq = 0;      // 左クリックのたびに増える。フレームの間に押して離しても取りこぼさない
    this.altSeq = 0;        // 右クリックのたびに増える（箱にしまう）
    this.poke = false;
    this.panning = false;
    this.enabled = true;    // ノートや設定を開いている間は false
    this.keys = new Set();
    this.last = { x: 0, y: 0 };
    this.lastTap = null;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      this._move(e);
      this.last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      this.onAction('pointerdown');
      if (!this.enabled) return;
      if (e.pointerType !== 'mouse') {
        this._tap(e);
        return;
      }
      if (e.button === 0) {
        this.pressSeq++;
        this.onAction('press');
      }
      if (e.button === 2) this.altSeq++;
      if (e.button === 1) e.preventDefault();
      this._buttons(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      this._move(e);
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.last = { x: e.clientX, y: e.clientY };
      // キャンバスの外（ボタンなど）で押したまま入ってきた場合は、クリック扱いしない
      if (e.pointerType !== 'mouse' || !canvas.hasPointerCapture(e.pointerId)) return;
      // 2つ目のボタンの押し離しは pointermove で届く
      const wasPrimary = this.primary;
      this._buttons(e);
      if (this.enabled && !wasPrimary && this.primary) {
        this.pressSeq++;
        this.onAction('press');
      }
      if (this.panning) {
        const s = this.view.rig.dist * 0.0018;
        this.view.rig.pan(-dx * s, dy * s);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') this._buttons(e);
    });
    canvas.addEventListener('pointercancel', () => this._reset());
    canvas.addEventListener('lostpointercapture', () => {
      this.primary = false;
      this.panning = false;
    });
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !e.buttons) this.hasPointer = false;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.view.rig.zoom(Math.exp(d * 0.0012));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      // Cmd/Ctrl との組み合わせはブラウザのショートカットに任せる（macOS では keyup が来ないため）
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Esc と N は、ノートや設定を開いていても（スライダーを触った後でも）効く
      if (e.code === 'Escape') { this.onAction('escape'); return; }
      if (e.code === 'KeyN' && !e.repeat && !(e.target instanceof HTMLInputElement)) { this.onAction('note'); return; }
      if (e.target instanceof HTMLInputElement) return;
      if (!this.enabled) return;
      if (e.code === 'Space') { this.poke = true; e.preventDefault(); return; }
      if (PAN_KEYS[e.code]) { this.keys.add(e.code); e.preventDefault(); return; }
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      if (ACTION_KEYS[e.code]) this.onAction(ACTION_KEYS[e.code]);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.poke = false; e.preventDefault(); }
      // macOS では Cmd を押している間に離したキーの keyup が来ないので、まとめて離したことにする
      if (e.key === 'Meta') { this.keys.clear(); this.poke = false; }
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this._reset());
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this._reset();
  }

  _buttons(e) {
    this.primary = this.enabled && (e.buttons & 1) !== 0;
    this.panning = (e.buttons & 4) !== 0;
  }

  // タッチ：1回目のタップで手を動かし、同じ場所をもう一度タップすると押したことにする
  _tap(e) {
    const now = performance.now();
    const t = this.lastTap;
    if (t && now - t.time < 1500 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 24) {
      this.pressSeq++;
      this.onAction('press');
      this.lastTap = null;
    } else {
      this.lastTap = { x: e.clientX, y: e.clientY, time: now };
    }
  }

  _reset() {
    this.primary = false;
    this.poke = false;
    this.panning = false;
    this.keys.clear();
  }

  _move(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.hasPointer = true;
  }

  update(dt) {
    let x = 0, z = 0;
    for (const k of this.keys) {
      x += PAN_KEYS[k][0];
      z += PAN_KEYS[k][1];
    }
    if (x || z) {
      const s = this.view.rig.dist * 0.9 * dt;
      this.view.rig.pan(x * s, z * s);
    }
  }

  groundPoint() {
    return this.view.groundPoint(this.ndc.x, this.ndc.y);
  }
}
