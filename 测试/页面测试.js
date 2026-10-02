// 真实 DOM 环境（jsdom）端到端测试：加载页面、开局、点击操作栏、检查渲染
//
// 两个稳定性前提（否则这测试会随机挂）：
//   1) 固定随机种子 —— 发牌和人类操作都可复现，结果稳定；
//   2) 人类中途出局时自动点「重新开局」继续累计手数 —— 否则 btnNext 永远是灰的，
//      测试会卡在半路再也不结束。
const fs = require('fs');
const path = require('path');
const JSDOM_DIR = 'jsdom';
const { JSDOM, VirtualConsole } = require(JSDOM_DIR);

const file = path.join(__dirname, '..', '德州扑克.html');
const html = fs.readFileSync(file, 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => { });

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/holdem',
  virtualConsole: vc,
  beforeParse(window) {
    // 固定随机种子，让每一把的牌和人类点击都可复现
    let seed = Number(process.env.HOLDEM_SEED || 20260930) >>> 0 || 1;
    window.Math.random = function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    // ⚠ 第二十二轮起「出手前想一想」默认开着（真实使用里慢一点才像人）。
    //   本测试要打完 6 手，每次都停一秒会把自检拖成几十分钟 —— 自检跑的是「功能对不对」，
    //   不是「节奏像不像人」，所以在这里关掉。拟人节奏本身有专门的自检。
    try { window.localStorage.setItem('holdem_game_cfg_v1', JSON.stringify({ think: false, thinkMs: 0 })); } catch (e) { }
  }
});
const w = dom.window, d = w.document;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
function line(label, cond, extra) {
  if (cond === undefined) { console.log('   ' + label + (extra ? '  ' + extra : '')); return; }
  if (!cond) bad++;
  console.log('   ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '  ' + extra : ''));
}

(async () => {
  await sleep(400);
  const q = id => d.getElementById(id);

  console.log('=== 1. 页面加载 ===');
  line('加载期无脚本错误', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n=== 2. 初始渲染 ===');
  const seatCount = d.querySelectorAll('.seat').length;
  const betCount = d.querySelectorAll('.badge-bet').length;
  const boardCards = d.querySelectorAll('#board .card').length;
  line('座位数 8', seatCount === 8, String(seatCount));
  line('下注筹码位 8', betCount === 8, String(betCount));
  line('公共牌位 5', boardCards === 5, String(boardCards));
  line('顶栏读数', undefined,
    '底池 "' + q('potVal').textContent + '" · 盲注 "' + q('hBlinds').textContent + '" · 手数 "' + q('hHand').textContent + '"');

  const names = [...d.querySelectorAll('.seat .nm')].map(e => e.textContent);
  const chips = [...d.querySelectorAll('.seat .chips')].map(e => e.textContent);
  line('座位都有名字', names.every(n => n && n.length), names.join(', '));
  line('座位都有筹码', chips.every(c => /^\d/.test(c)), chips.join(', '));
  const logCount = d.querySelectorAll('#log .li').length;
  line('战报已有内容', logCount >= 4, logCount + ' 条');

  console.log('\n=== 3. 发牌并打完 6 手 ===');
  q('btnNext').click();

  let turns = 0, sawControls = false, finished = 0, lastH = 0, restarts = 0, maxH = 0;
  const act = () => {
    if (!q('controls').classList.contains('on')) return;
    sawControls = true;
    turns++;
    // ⚠ 这里绝不能用 Math.random：它会跟游戏共用同一个随机源，
    // 而本测试的调用时机是时间驱动的（await sleep 轮询），每跑一次的消耗次数可能不同，
    // 牌序就跟着漂 —— 测试会随机挂。用轮次号派生，纯确定性。
    const r = ((turns * 7) % 10) / 10;
    if (r < 0.12 && !q('btnFold').disabled) q('btnFold').click();
    else if (r < 0.5 && !q('btnRaise').disabled) {
      const sl = q('slider');
      sl.value = String(Math.floor((+sl.min + +sl.max) / 2));
      q('btnRaise').click();
    } else if (!q('btnCall').disabled) q('btnCall').click();
  };

  const deadline = Date.now() + 120000;
  while (finished < 6 && Date.now() < deadline) {
    act();
    const bar = q('resultBar');
    if (bar.classList.contains('on') &&
        /💀|👑|你已出局|观战中|通吃整桌|只剩最后一个人/.test(bar.textContent || '')) {
      q('btnReset').click();
      await sleep(10);
      q('btnReset').click();     // 重新开局要点两次（防误触）
      restarts++; lastH = 0;
      await sleep(10);
      continue;
    }
    const h = +q('hHand').textContent || 0;
    if (h > lastH) { finished += h - lastH; lastH = h; }
    if (+q('hHand').textContent > maxH) maxH = +q('hHand').textContent;
    if (finished >= 6) break;
    if (!q('btnNext').disabled) q('btnNext').click();
    await sleep(12);
  }

  line('打完 6 手', finished >= 6, '累计 ' + finished + ' 手 · 人类重开局 ' + restarts + ' 次');
  line('人类操作栏出现过', sawControls, turns + ' 次决策');
  const H = w.HOLDEM;
  line('盲注读数正常', /^\d+\/\d+$/.test(q('hBlinds').textContent), q('hBlinds').textContent);
  // 盲注「每 N 手涨一级」的完整验证放在「AI大脑自检」第 13.4 节（那里能控制手数）。
  // 这里只验证开关本身能切、并且真的写进了配置。
  const tgUp = q('tgBlindUp');
  const upBefore = tgUp.checked;
  tgUp.checked = !upBefore; tgUp.dispatchEvent(new w.Event('change'));
  const flipped = H.gamecfg().blindUp === !upBefore;
  tgUp.checked = upBefore; tgUp.dispatchEvent(new w.Event('change'));
  line('盲注递增开关能切换并写进配置', flipped && H.gamecfg().blindUp === upBefore,
    '当前 ' + (upBefore ? '开' : '关') + ' · 本轮最高打到第 ' + maxH + ' 手');
  // 守恒要算「手里筹码 + 已投入底池」：badge-bet 只画当街下注，不能直接相加
  const total = H.players().map(p => p.chips + p.totalBet).reduce((a, x) => a + x, 0);
  line('筹码守恒（手里筹码 + 已投入底池 = 8000）', total === 8000, '合计 ' + total);
  line('运行期无脚本错误', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n=== 4. 交互控件 ===');
  const tg = q('tgReveal');
  tg.checked = true;
  tg.dispatchEvent(new w.Event('change'));
  const revealed = d.querySelectorAll('.seat .hole .card:not(.back)').length;
  line('勾选「显示对手底牌」后能翻牌', revealed > 0, revealed + ' 张');
  tg.checked = false; tg.dispatchEvent(new w.Event('change'));

  q('btnReset').click();
  await sleep(20);
  q('btnReset').click();          // 重新开局要点两次（防误触）
  await sleep(30);
  line('重新开局后手数归零', q('hHand').textContent === '0', '手数 "' + q('hHand').textContent + '"');
  line('重新开局后筹码复位', q('hMyChips').textContent === '1,000', '筹码 "' + q('hMyChips').textContent + '"');
  line('重新开局后底池清空', q('potVal').textContent === '0', '底池 "' + q('potVal').textContent + '"');
  line('最终无脚本错误', errors.length === 0, errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n========================================');
  console.log(bad === 0 ? '全部通过' : ('有 ' + bad + ' 项未通过'));
  process.exit(bad || errors.length ? 1 : 0);
})().catch(e => { console.log('❌ 测试自身崩了: ' + (e && e.stack || e)); process.exit(1); });
