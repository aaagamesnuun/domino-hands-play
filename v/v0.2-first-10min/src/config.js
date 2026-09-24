// ゲーム全体の定数。長さの単位は「ドミノの高さ = 1」（1単位 ≒ 5cm）。
// 物理（sim.js）・描画（view.js / room.js）・音（audio.js）がここを共有する。

export const DOMINO = {
  h: 1.0,       // 高さ (y)
  w: 0.5,       // 幅 (ローカル x)
  t: 0.15,      // 厚み (ローカル z) — 倒れる方向の軸
  friction: 0.42,
  restitution: 0.0,
  density: 1.0,
};

// 仕切り板：低くて重い木片。倒れてきたドミノを受け止めて連鎖を止める
export const STOPPER = {
  h: 0.45,
  w: 0.7,
  t: 0.3,
  density: 8.0,
  friction: 0.7,
};

export const WORLD = {
  gravity: 60,            // 波の速さ ≒ 14枚/秒（間隔0.6）
  dt: 1 / 120,            // 固定ステップ（マルチプレイでもこの刻みで揃える）
  solverIterations: 6,
};

// ちゃぶ台と卓上の物の配置。y=0 が天板の上面。カメラは +z 側（手前）から見る。
export const LAYOUT = {
  table: { x0: -13, x1: 13, z0: -9, z1: 9, thickness: 0.7, legHeight: 5.5 },
  // ドミノを並べる盆（縁つき）。ドミノはこの中だけに置ける
  tray: { x0: -12, x1: 12, z0: -8.4, z1: 3.6, rimHeight: 0.3, rimThickness: 0.25 },
  // 手前の帯（z 4〜8.6）に並ぶ物。足元の大きさ（hx, hz は半分の幅）
  box: { x: -8.5, z: 6.3, hx: 1.7, hz: 1.15, height: 1.1 },       // ドミノの木箱
  note: { x: -3.2, z: 6.4, hx: 1.5, hz: 1.1, height: 0.25 },      // ノート（強化）
  sticky: { x: 1.2, z: 6.4, hx: 0.9, hz: 0.9, height: 0.02 },     // 付箋（今日の最長）
  bell: { x: 8.5, z: 6.3, r: 0.85, height: 0.9 },                 // 呼び鈴（ひと休み）
  camera: { target: [0, 0, 0.6], yaw: 0, pitch: 0.95, dist: 31 },
};

export const HAND = {
  hoverY: 1.3,            // 待機中のアンカー高さ（持ったドミノの底 / 指先）。立ったドミノや箱の上を安全に通れる
  pokeY: 0.62,            // 押すときの指先の高さ
  pokeLen: 0.75,          // 手の原点から指先までの長さ（押すポーズ）
  lowerSpeed: 10,         // 下ろす速さ（単位/秒）。「手ぎわ」で速くなる
  raiseSpeed: 9,
  pokeLowerSpeed: 7,
  openTicks: 8,           // 離すときに指を開く時間（ティック）
  clearY: 0.4,            // 離したあと、指先がドミノの上端を越える高さ（ここまでは真上に上げる）
  reloadTicks: 6,         // 次のドミノを持ち直す時間
  grabTicks: 60,          // 箱から掴む（0.5秒）
  stashTicks: 36,         // 箱にしまう（0.3秒）
  pickHoldTicks: 10,      // 拾うときにつまんでいる時間
  bellTicks: 180,         // 呼び鈴を押し続ける時間（1.5秒）
  maxSpeedLow: 7,         // 手が下りている間の最大水平速度（すり抜け防止）
  maxSpeedHover: 60,
  followRate: 28,         // 待機中の追従の速さ
  yawRate: 16,
  pickRadius: 0.45,       // これより近いドミノを「拾える」とみなす（床面での距離）
  // 指パッドの当たり判定（ドミノの面をつまむ）
  padHalf: { x: 0.12, y: 0.09, z: 0.035 },
  thumbHalf: { x: 0.075, y: 0.09, z: 0.035 },
  padY: -0.08,            // ドミノ上端からの高さ
  padGap: 0.012,          // 指とドミノの面のすき間（接触判定の予測距離より大きく）
  padOpen: 0.025,         // 開いたときに外へ動く距離
  palmHalf: { x: 0.28, y: 0.08, z: 0.24 },
  palmY: 0.3,
  pokeRadius: 0.055,
};

// 連鎖の数え方（事故の判定はしない。続けて倒れたかどうかだけを見る）
export const CHAIN = {
  wobbleDeg: 12,          // これ以上傾いたら「ぐらつき」。このとき親を決める
  fallDeg: 45,            // これ以上で「倒れた」と確定
  restFallDeg: 20,        // これ以上傾いたまま止まっていても「倒れた」
  backDeg: 8,             // 確定前にここまで戻ったら「立つ」に戻る
  tickDeg: 4,             // カタッと鳴る傾き
  parentWindowTicks: 360, // 3秒以内に倒れ始めたドミノだけを親にできる（間隔が広いと、寄りかかってゆっくり押すことがある）
  closeTicks: 240,        // 2秒間どれも倒れなければ連鎖を閉じる
};

export const PLACEMENT = {
  neighborRadius: 1.5,    // 自動で向きを合わせる近傍の距離
  farSpacing: 0.9,        // これより離れると届かない可能性
};

// 在庫（みんなの共有）。今日の最長が在庫の9割に届いた状態でひと休みすると、次の箱が届く
export const STOCK_STAGES = [20, 30, 45, 70, 100, 150, 220, 330, 500, 750, 1100, 1600, 2200, 3000];
export const STOCK_ADVANCE_RATIO = 0.9;

// ポイント = 最長連鎖² / 100（10連未満は0）
export function pointsFor(longest) {
  return longest < 10 ? 0 : Math.floor((longest * longest) / 100);
}

// ノート1ページ目の強化（各自の手にだけ効く）。levels[i] が段階 i の値、costs[i] が段階 i → i+1 の値段
export const UPGRADES = [
  { id: 'bigHand', name: '大きい手', desc: '一度に持てる数が増える', levels: [3, 5, 8, 12], costs: [3, 10, 30], unit: '個' },
  { id: 'deft', name: '手ぎわ', desc: '置く・拾う・掴む動きが速くなる', levels: [1, 1.18, 1.38], costs: [5, 20], unit: '倍' },
  { id: 'scoop', name: 'すくい拾い', desc: 'くっついて寝ているドミノをまとめて拾える', levels: [1, 3, 6], costs: [8, 25], unit: '個' },
  { id: 'ruler', name: 'ものさし', desc: '次に置く位置の目安がうっすら見える', levels: [0, 1], costs: [15], unit: '' },
  { id: 'stopper', name: '仕切り板', desc: '連鎖を止める板。押す前に手で抜く', levels: [0, 2, 4], costs: [12, 30], unit: '枚' },
  { id: 'apprentice', name: '見習いの手', desc: '寝ているドミノを箱へ片付けてくれる', levels: [0, 1], costs: [80], unit: '' },
];

// ドミノの色（箱の中で混ざっている）：生成り・セージ・テラコッタ・くすみ青
export const DOMINO_COLORS = ['#e9e0cf', '#9fae93', '#c7765a', '#7d93a8'];
export const FIRST_DOMINO_COLOR = '#f3ecdc';   // はじめの一枚（落書き入り）

// 手袋の袖口の色（最大12人）。見習いの手は灰色
export const PLAYER_COLORS = [
  '#c98b5f', '#6f8fae', '#8fa77a', '#b8746f', '#a58bb5', '#c9a55b',
  '#6ea39e', '#b57d9a', '#7f8a5a', '#8a6a4f', '#5e6b78', '#a36155',
];
export const APPRENTICE_COLOR = '#9a9a96';

// 音（audio.js）
export const MUSIC = {
  bpm: 72,
  swing: 0.58,            // 8分の裏を 58% の位置に
  chords: ['Dm9', 'G13', 'Cmaj9', 'Am9'],   // 1小節ずつ
  key: 'C',               // 連鎖のメロディは C メジャー・ペンタトニック（C D E G A）
};
