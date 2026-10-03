// 背景自检 —— 🖼 换背景（纯观感层）
//
// 本轮要守住的一条：**背景只有装饰职责**。
// 换背景 / 拖暗化滑块，不许让任何一手牌、任何一枚筹码、任何一次底池发生一个比特的变化。
//
// 规矩（照前几轮）：
//   · 「持久化」必须跨一次页面加载才算验过；
//   · 坏数据要有兜底，且兜底之后不许抛错；
//   · 存在性断言测不出「指向错了」—— 所以这里验的是**值**，不是「元素在不在」。
const fs = require('fs');
const path = require('path');
const JSDOM_DIR = 'jsdom';
const { JSDOM, VirtualConsole } = require(JSDOM_DIR);

const file = path.join(__dirname, '..', '德州扑克.html');
const html = fs.readFileSync(file, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('   ✅ ' + name + (extra !== undefined ? '  ' + extra : '')); }
  else { fail++; console.log('   ❌ ' + name + (extra !== undefined ? '  ' + extra : '')); }
};
const section = t => console.log('\n=== ' + t + ' ===');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => { });
  let seed = 20261003 >>> 0;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      window.fetch = async () => { throw new Error('no net'); };
      window.HTMLCanvasElement.prototype.getContext = function () {
        if (!this.__mockCtx) {
          const noop = () => { };
          this.__mockCtx = {
            fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
            lineJoin: 'miter', globalAlpha: 1, lineCap: 'butt',
            clearRect: noop, fillRect: noop, beginPath: noop, moveTo: noop, lineTo: noop,
            stroke: noop, fill: noop, closePath: noop, fillText: noop, strokeText: noop,
            arc: noop, rect: noop, save: noop, restore: noop, setLineDash: noop,
            translate: noop, scale: noop,
            measureText: () => ({ width: 10 }),
            createLinearGradient: () => ({ addColorStop() { } }),
            createRadialGradient: () => ({ addColorStop() { } })
          };
        }
        return this.__mockCtx;
      };
      if (store) for (const k of Object.keys(store)) { try { window.localStorage.setItem(k, store[k]); } catch (e) { } }
    }
  });
  await sleep(120);
  return { dom, w: dom.window, d: dom.window.document, errors, H: dom.window.HOLDEM };
}

// 玩法状态的指纹：任何一项变了，就说明背景伸手进了牌局
const fingerprint = (H) => {
  const b = H.bet();
  return JSON.stringify({
    chips: H.players().map(p => p.chips),
    out: H.players().map(p => !!p.out),
    handNo: b.handNo, pot: b.currentBet, board: H.board().length, street: H.streetOf()
  });
};

(async () => {

  // ============================================================ 1 静态
  section('1 静态：该在的都挂上了');
  ok('body 里有背景层 #bgLayer', /<div id="bgLayer"/.test(html));
  ok('body 里有暗化层 #bgScrim', /<div id="bgScrim"/.test(html));
  ok('工具条有换背景按钮 #btnBg', /id="btnBg"/.test(html));
  ok('有 #bgMask 面板', /id="bgMask"/.test(html));
  ok('面板里有 #bgGrid 容器', /id="bgGrid"/.test(html));
  ok('有暗化滑块 #bgScrimRange', /id="bgScrimRange"/.test(html));

  // ⚠ 这条是补丁 3 修回来的坑：面板排在 <script> 后面的话，启动时 #bgGrid 还不存在，
  //    bgRender 直接早退，面板是空的 —— 只是点开时又补一次才看不出来。
  const iMask = html.indexOf('<div class="ai-mask" id="bgMask">');
  const iScript = html.indexOf('<script>');
  ok('面板排在 <script> 之前（否则启动时渲染不出来）', iMask > 0 && iMask < iScript,
    '面板@' + iMask + ' 脚本@' + iScript);

  // ============================================================ 2 备份
  section('2 备份清单：新增的持久化设置必须登记');
  ok('BACKUP_KEYS 里有 holdem_bg_v1', /BACKUP_KEYS[\s\S]{0,900}?holdem_bg_v1/.test(html));
  ok('reloadAllData 里挂了 bgLoad/bgApply/bgRender', /function reloadAllData\(\)\{[\s\S]{0,600}?bgLoad\(\);\s*bgApply\(\);\s*bgRender\(\);/.test(html));

  // ============================================================ 3 与玩法绝缘（静态）
  section('3 与玩法绝缘：背景代码里不许出现任何玩法状态');
  const bgStart = html.indexOf('🖼 换背景（纯观感层');
  const bgEnd = html.indexOf('function bgInit', bgStart);
  const rawCode = html.slice(bgStart, bgEnd > 0 ? bgEnd + 2600 : bgStart + 6000);
  ok('取到了换背景的代码段', rawCode.length > 1500, rawCode.length + ' 字符');
  // ⚠ 必须先把三张图的 base64 抠掉再扫。base64 字母表里有 + 和 /（**不是**单词字符），
  //    所以 "...AB+pot/XY..." 这种随机串会产生词边界，让 \bpot\b 假红。
  const bgCode = rawCode.replace(/data:image\/webp;base64,[A-Za-z0-9+/=]+/g, 'DATAURI');
  ok('抠掉图片数据后代码段还剩下骨架', bgCode.length > 1000 && bgCode.length < 20000,
    bgCode.length + ' 字符');
  ok('不引用 players / chips', !/\bplayers\b|\bchips\b/.test(bgCode));
  ok('不引用 decide / settle / nextHand', !/\bdecide\b|\bsettle\b|\bnextHand\b/.test(bgCode));
  ok('不引用底池 pot（⚠ 词边界 + 已抠图，spot 不会假红）', !/\bpot\b/.test(bgCode));
  ok('不引用盲注 blind', !/\bblind\b/.test(bgCode));
  ok('不往战报写日志 log(', !/\blog\s*\(/.test(bgCode));

  // ============================================================ 4 首次加载
  section('4 首次加载：默认值与真实生效的样式');
  const a = await boot();
  ok('页面无脚本异常', a.errors.length === 0, a.errors.slice(0, 2).join(' || ') || '');
  ok('默认背景 = 城市夜窗', a.w.BGCFG.key === 'city', a.w.BGCFG.key);
  ok('默认暗化 = 38%', a.w.BGCFG.scrim === 38, String(a.w.BGCFG.scrim));
  const layer = a.d.getElementById('bgLayer');
  // ⚠⚠ jsdom 的 cssstyle 会把**超长**的 url(...) 直接丢掉：实测 backgroundImage 读回来是空串，
  //     而同一行设的 background-size:cover 留下来了。短 data URI（如 base64,QUJD）则正常。
  //     ⇒ 这不是代码的毛病：真实 Chrome 里这张图是挂上的，由 测试/_verify_bg.js（CDP 直连）负责验。
  //     这里只验 jsdom 能可靠看见的两件事：① 算出来的 CSS 串对不对 ② bgApply 有没有真按 key 动这个元素。
  ok('bgCssOf 给的是真正的 webp data URI', /^url\("data:image\/webp;base64,/.test(a.w.bgCssOf('city')),
    a.w.bgCssOf('city').slice(0, 30));
  ok('那张图确实有料（不是空串）', a.w.bgCssOf('city').length > 100000,
    a.w.bgCssOf('city').length + ' 字符');
  ok('三张牌室各是一张不同的图',
    a.w.bgCssOf('warm') !== a.w.bgCssOf('city') && a.w.bgCssOf('city') !== a.w.bgCssOf('spot'));
  ok('「原样」不是图片，是那条例外渐变', /^radial-gradient/.test(a.w.bgCssOf('none')),
    a.w.bgCssOf('none').slice(0, 26));
  ok('#bgLayer 被 bgApply 动过（cover 留下了）', layer.style.backgroundSize === 'cover', layer.style.backgroundSize);
  ok('#bgScrim 透明度 = 0.38', a.d.getElementById('bgScrim').style.opacity === '0.38',
    a.d.getElementById('bgScrim').style.opacity);
  ok('面板里正好 4 个选项', a.d.querySelectorAll('.bg-opt').length === 4,
    String(a.d.querySelectorAll('.bg-opt').length));
  ok('工具条按钮上显示当前背景名', a.d.getElementById('hBgName').textContent.trim() === '城市夜窗',
    a.d.getElementById('hBgName').textContent.trim());
  ok('选中项有高亮样式 .on', a.d.querySelectorAll('#bgGrid .bg-opt.on').length === 1,
    a.d.querySelectorAll('#bgGrid .bg-opt.on').length + ' 个');

  // 点第四个（聚光暗室）—— 验「值变了」而不是「元素在」
  const opts = a.d.querySelectorAll('#bgGrid .bg-opt');
  opts[3].onclick.call(opts[3]);
  ok('点「聚光暗室」后 key 变成 spot', a.w.BGCFG.key === 'spot', a.w.BGCFG.key);
  ok('bgCssOf 跟着 key 一起走', a.w.bgCssOf(a.w.BGCFG.key) === a.w.bgCssOf('spot'));
  ok('高亮跟着移到第 4 项',
    a.d.querySelectorAll('#bgGrid .bg-opt')[3].classList.contains('on') &&
    !a.d.querySelectorAll('#bgGrid .bg-opt')[0].classList.contains('on'));
  // bgApply 是不是真的按 key 重设了元素样式？切「原样」应该把 cover 换成 auto（它没有图要铺）
  opts[0].onclick.call(opts[0]);
  ok('切「原样」后 #bgLayer 的铺法从 cover 变 auto（证明按 key 重设了）',
    layer.style.backgroundSize === 'auto', layer.style.backgroundSize);
  opts[3].onclick.call(opts[3]);
  ok('切回图片又变回 cover', layer.style.backgroundSize === 'cover', layer.style.backgroundSize);

  // ============================================================ 5 跨页面加载（持久化铁律）
  section('5 跨一次页面加载：存下来的选择必须自己回来');
  const b = await boot({ holdem_bg_v1: JSON.stringify({ key: 'spot', scrim: 55 }) });
  ok('新开一个页面，背景回到 聚光暗室', b.w.BGCFG.key === 'spot', b.w.BGCFG.key);
  ok('暗化回到 55%', b.w.BGCFG.scrim === 55, String(b.w.BGCFG.scrim));
  ok('#bgScrim 透明度跟着回到 0.55',
    b.d.getElementById('bgScrim').style.opacity === '0.55',
    b.d.getElementById('bgScrim').style.opacity);
  ok('滑块初始值也是 55', String(b.d.getElementById('bgScrimRange').value) === '55',
    String(b.d.getElementById('bgScrimRange').value));

  // ============================================================ 6 坏数据
  section('6 坏数据兜底：存脏了不许崩，也不许把页面搞黑');
  const c = await boot({ holdem_bg_v1: JSON.stringify({ key: '不存在的背景', scrim: 9999 }) });
  ok('非法背景名落回合法值', c.w.BGCFG.key === 'city', c.w.BGCFG.key);
  ok('超范围暗化被夹到上限 70', c.w.BGCFG.scrim === 70, String(c.w.BGCFG.scrim));
  ok('坏数据没有抛异常', c.errors.length === 0, c.errors.slice(0, 2).join(' || ') || '');

  const d2 = await boot({ holdem_bg_v1: '这不是 JSON{{{' });
  ok('整段不是 JSON 也不崩', d2.errors.length === 0, d2.errors.slice(0, 2).join(' || ') || '');
  ok('也不是 JSON 时落回默认', d2.w.BGCFG.key === 'city', d2.w.BGCFG.key);

  // ============================================================ 7 ★ 核心：背景不许影响打牌
  section('7 ★ 核心：换背景 / 拖滑块，牌局一个比特都不许动');
  const e = await boot();
  const before = fingerprint(e.H);
  const firstImg = layer.style.backgroundImage;
  for (const k of ['none', 'warm', 'spot', 'city', 'warm', 'none']) {
    e.w.BGCFG.key = k; e.w.bgApply();
  }
  for (const s of [0, 70, 12, 38, 70, 0]) {
    e.w.BGCFG.scrim = s;
    const sl = e.d.getElementById('bgScrimRange');
    sl.value = String(s); sl.oninput.call(sl);
  }
  const after = fingerprint(e.H);
  ok('★ 筹码 / 底池 / 手数 / 公共牌 / 街 全都没变', before === after,
    before === after ? '' : ('before=' + before + ' after=' + after));
  ok('★ 背景确实切了 6 次（证明不是「什么都没跑」）', e.w.BGCFG.key === 'none', e.w.BGCFG.key);
  ok('★ 暗化确实拖了 6 次（末次 0%）', e.w.BGCFG.scrim === 0, String(e.w.BGCFG.scrim));
  ok('★ 暗化到 0% 时遮罩真的透明了', e.d.getElementById('bgScrim').style.opacity === '0',
    e.d.getElementById('bgScrim').style.opacity);

  // 反向：确认指纹本身是灵敏的（不然上面那条就是假绿）
  // ⚠ 别用 resetGame() 来当「变化」—— 我们从头就没打过一手牌，重开一局前后状态一模一样，
  //   指纹自然不变，会写出一个假的「不灵敏」。直接动一枚筹码才是真的探针。
  const beforeTouch = fingerprint(e.H);
  e.H.players()[0].chips += 137;
  const afterTouch = fingerprint(e.H);
  ok('反向校验：指纹能察觉真实的筹码变化', beforeTouch !== afterTouch);
  e.H.players()[0].chips -= 137;
  ok('反向校验：改回去指纹也回到原样', fingerprint(e.H) === beforeTouch);

  // ============================================================ 8 备份闭环
  section('8 备份闭环：换背景也要能跟着备份走');
  const f = await boot();
  f.w.BGCFG.key = 'warm'; f.w.BGCFG.scrim = 61; f.w.bgSave();
  const pack = f.H.backupPack();
  ok('备份里带上了 holdem_bg_v1', !!pack.keys.holdem_bg_v1, pack.keys.holdem_bg_v1 || '缺失');
  ok('备份里记的是 warm/61', /"key":"warm"/.test(pack.keys.holdem_bg_v1) && /"scrim":61/.test(pack.keys.holdem_bg_v1));
  ok('备份清单里给它写了中文说明', /背景选择与暗化程度/.test(f.H.backupText()));

  console.log('\n============================================');
  console.log(fail === 0 ? `✅ 背景自检全部通过：${pass} 项` : `❌ 背景自检：${pass} 通过 / ${fail} 失败`);
  console.log('============================================\n');
  process.exit(fail === 0 ? 0 : 1);

})().catch(e => { console.error('自检自身崩了：', e); process.exit(2); });
