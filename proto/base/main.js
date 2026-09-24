// 土台の確認用：坂・台・最初から置いたドミノ・3つの大きさ・鐘
import { startProto } from '../lib/protoapp.js';
import { ramp, block } from '../lib/protosim.js';

const COLORS = ['#e9e0cf', '#9fae93', '#c7765a', '#7d93a8'];

// 坂を上って台に乗り、下りてくる道。途中まで並べてある
const dominoes = [];
for (let i = 0; i < 8; i++) dominoes.push({ x: -10 + i * 0.6, z: -1, yaw: Math.PI / 2, size: 'm' });

startProto({
  title: '土台の確認',
  desc: '坂・台・最初からあるドミノ・3つの大きさ',
  trace: true,
  colorFor: (size, n) => COLORS[(n * 7 + (n >> 2)) % 4],
  stage: {
    solids: [
      ramp(-4.5, -1, -0.5, -1, 0, 0.25, 2.2),     // 約3.6°（上り向きに並べても立てる。限界は約8.5°だが、誤差で倒れないよう余裕をとる）
      block(1.5, -1, 2, 1.1, 0.25, '#8a6446'),
      ramp(3.5, -1, 7.5, -1, 0.25, 0, 2.2),
    ],
    props: [
      { type: 'box', name: 'bell', x: 10, y: 0.5, z: -1, hx: 0.3, hy: 0.5, hz: 0.3, color: '#c9a55b', metal: true, density: 2 },
    ],
    dominoes,
  },
});
