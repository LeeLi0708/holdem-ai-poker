// 全面板遍历探针：加载页面 → 打几手 → 打开每一个面板 / 点每一个页签 / 点每一个按钮，
// 收集全部运行时错误。只读不写，绝不改动德州扑克.html。
const fs = require('fs');
const path = require('path');
const JSDOM_DIR = 'jsdom';
const { JSDOM, VirtualConsole } = require(JSDOM_DIR);

const file = path.join(__dirname, '..', '德州扑克.html');
const html = fs.readFileSync(file, 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => { });

let seed = 20261001 >>> 0;
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://localhost/holdem',
  virtualConsole: vc,
  beforeParse(window) {
    window.Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    window.fetch = async () => { throw new Error('no net'); };   // 屏蔽真实网络 → 全部走本地速算兜底
    window.HTMLCanvasElement.prototype.getContext = function () { return null; }; // 无 canvas 环境
  }
});

const { window } = dom;
const doc = window.document;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = window.HOLDEM;

const before = errors.length;
let steps = 0;
function step(name, fn) {
  steps++;
  const n = errors.length;
  try { fn(); } catch (e) { errors.push('[' + name + '] 抛错: ' + (e && e.message)); }
  if (errors.length > n) console.log('  ❌ ' + name + ' → ' + errors.slice(n).join(' | ').slice(0, 300));
  else console.log('  ✅ ' + name);
}
const click = id => { const el = doc.getElementById(id); if (!el) throw new Error('找不到 #' + id); el.click(); };

(async () => {
  await sleep(400);
  console.log('--- 1. 初始 ---');
  step('加载完成', () => { if (!H) throw new Error('HOLDEM 未导出'); });

  // 关掉大脑，用本地速算，避免网络
  const tg = doc.getElementById('tgBrain'); if (tg) { tg.checked = false; tg.dispatchEvent(new window.Event('change')); }

  console.log('\n--- 2. 直接打开每个面板（不依赖牌局） ---');
  const opens = ['btnRange', 'btnSeed', 'btnAISet', 'btnAILog', 'btnCoach', 'btnReset'];
  for (const id of opens) step('打开 ' + id, () => click(id));

  console.log('\n--- 3. 教练面板 9 个页签 ---');
  for (const t of ['now', 'curve', 'hist', 'phase', 'session', 'mem', 'book', 'talk', 'set']) {
    step('页签 ' + t, () => {
      const b = doc.querySelector('.ctab[data-tab="' + t + '"]');
      if (!b) throw new Error('页签不存在 ' + t);
      b.click();
    });
  }

  console.log('\n--- 4. 打 6 手牌（本地速算） ---');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  const handNo = () => Number((doc.getElementById('hHand') || {}).textContent) || 0;
  const t0 = Date.now();
  while (handNo() < 6 && Date.now() - t0 < 60000) {
    const nxt = doc.getElementById('btnNext');
    const mask = [...doc.querySelectorAll('.ai-mask.on')];
    if (mask.length) mask.forEach(m => m.classList.remove('on'));
    if (nxt && !nxt.disabled) { nxt.click(); await sleep(40); continue; }
    // 轮到我 = #controls 带 .on（jsdom 没有布局，offsetParent 恒为 null，不能用它判断）
    const ctl = doc.getElementById('controls');
    const call = doc.getElementById('btnCall');
    const fold = doc.getElementById('btnFold');
    if (ctl && ctl.classList.contains('on')) {
      if (call && !call.disabled) call.click();
      else if (fold && !fold.disabled) fold.click();
    }
    await sleep(40);
  }
  console.log('  · 打完手数 ' + handNo() + '（顶栏读数）');

  console.log('\n--- 5. 有数据后重开各面板 + 教练各页签 ---');
  for (const id of ['btnCoach', 'btnAILog', 'btnRange']) step('重开 ' + id, () => click(id));
  for (const t of ['now', 'curve', 'hist', 'phase', 'session', 'mem', 'book', 'talk']) {
    step('重看页签 ' + t, () => doc.querySelector('.ctab[data-tab="' + t + '"]').click());
  }

  console.log('\n--- 6. 档案 / 回放 / 追问 ---');
  step('展开第一份档案', () => { const c = doc.querySelector('#coachPaneHist .hist-card'); if (c) c.click(); });
  step('档案追问输入', () => {
    const t = doc.getElementById('histText') || doc.querySelector('#coachPaneHist textarea');
    if (t) { t.value = '这手 f 和 c 哪个好'; }
  });
  step('讨论模式输入', () => {
    const t = doc.getElementById('talkText') || doc.querySelector('#coachPaneTalk textarea');
    if (t) { t.value = 'call 还是 fold'; }
  });
  step('打字时按 F 不应出牌（焦点守卫）', () => {
    const t = doc.querySelector('#coachPaneTalk textarea') || doc.querySelector('#coachPaneHist textarea');
    if (!t) return;
    t.focus();
    const before = (H.players()[0] || {}).actionType;
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f' }));
    const after = (H.players()[0] || {}).actionType;
    if (before !== after) throw new Error('输入框里按 f 改了 actionType：' + before + '→' + after);
  });

  console.log('\n--- 7. 花名册 / 换人 / 用量 / 记忆卡 / 回放器 ---');
  step('花名册：点一个座位', () => {
    const b = doc.querySelector('#rosterMask .roster-row') || doc.querySelector('#rosterMask [data-i]');
    if (b) b.click();
  });
  step('用量面板切「本次打开页面」', () => click('usageScopeSess'));
  step('用量面板切「长期累计」', () => click('usageScopeAll'));
  step('用量面板刷新', () => click('usageRefresh'));
  step('打开回放器', () => { const c = doc.querySelector('#coachPaneHist .hist-card'); const r = doc.querySelector('#coachPaneHist [data-replay], #coachPaneHist .rp-btn'); if (r) r.click(); });
  step('打开起手牌表并切换视角', () => { if (doc.getElementById('rangeMask')) doc.getElementById('rangeMask').classList.add('on'); });

  console.log('\n--- 8. Esc 收尾（面板应全部关掉） ---');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  step('Esc 后 mask 都关了', () => {
    const on = [...doc.querySelectorAll('.ai-mask.on')].map(e => e.id);
    if (on.length) throw new Error('没关掉：' + on.join(','));
  });

  console.log('\n========================================');
  console.log('探针步数 ' + steps + '，共捕获 ' + errors.length + ' 条错误');
  if (errors.length) { console.log('--- 明细 ---'); errors.forEach((e, i) => console.log((i + 1) + '. ' + e.slice(0, 400))); }
  else console.log('零运行时错误');
  process.exit(0);
})();
