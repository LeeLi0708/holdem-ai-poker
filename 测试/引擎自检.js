// 德州扑克最终验证：引擎正确性 + 牌局质量 + 筹码守恒
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '德州扑克.html'), 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

function mkCL() { const s = new Set(); return { add(...a) { a.forEach(x => s.add(x)); }, remove(...a) { a.forEach(x => s.delete(x)); }, contains: c => s.has(c), toggle(c, f) { if (f === undefined) { s.has(c) ? s.delete(c) : s.add(c); } else { f ? s.add(c) : s.delete(c); } } }; }
function mkEl() { const el = { classList: mkCL(), style: { setProperty() { } }, dataset: {}, children: [], innerHTML: '', textContent: '', value: '0', disabled: false, scrollTop: 0, scrollHeight: 0, appendChild(c) { el.children.push(c); return c; }, querySelector: () => mkEl(), querySelectorAll: () => [], addEventListener() { }, setAttribute() { }, getAttribute() { return null; }, removeAttribute() { } }; return el; }
const memo = new Map();
const doc = {
  getElementById: id => { if (!memo.has(id)) memo.set(id, mkEl()); return memo.get(id); },
  createElement: mkEl, querySelectorAll: () => [],
  querySelector: s => s === '.stage' ? { clientWidth: 1200, clientHeight: 820 } : mkEl(),
  addEventListener() { },
};
const ctx = { console, document: doc, window: { addEventListener() { } }, requestAnimationFrame(f) { }, setTimeout: () => 0, clearTimeout() { }, setInterval: () => 0, clearInterval() { }, Math, Date, JSON, Set, Map, Promise, Error, Int8Array, parseInt, parseFloat, isNaN, Number, String, Boolean, Array, Object };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(code, ctx, { filename: 'poker.js' });

/* ---------- A. 单元测试 ---------- */
const parse = s => { const mp = { A: 14, K: 13, Q: 12, J: 11, T: 10 }; return { r: mp[s[0]] || Number(s[0]), s: ['S', 'H', 'D', 'C'].indexOf(s[1]) }; };
const ev7 = vm.runInContext('evaluate7', ctx);
const evBest = vm.runInContext('evaluateBest', ctx);
const handCat = vm.runInContext('handCat', ctx);
const HN = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
const cases = [
  [['AS', 'KS', 'QS', 'JS', 'TS', '2H', '3D'], '同花顺'], [['AH', 'AD', 'AC', 'AS', '2H', '3D', '4C'], '四条'],
  [['KH', 'KD', 'KC', '2S', '2H', '3D', '4C'], '葫芦'], [['AH', '9H', '7H', '4H', '2H', '3D', '4C'], '同花'],
  [['5H', '6D', '7C', '8S', '9H', '2D', '3C'], '顺子'], [['5H', '4D', '3C', '2S', 'AH', '9D', 'KC'], '顺子'],
  [['QH', 'QD', 'QC', '2S', '5H', '3D', '4C'], '三条'], [['QH', 'QD', '7C', '7S', '5H', '3D', '2C'], '两对'],
  [['QH', 'QD', '8C', '7S', '5H', '3D', '2C'], '一对'], [['QH', '9D', '8C', '7S', '5H', '3D', '2C'], '高牌'],
  [['AH', '2D', '3C', '4S', '5H', 'KD', 'QC'], '顺子'], [['2H', '2D', '2C', '2S', 'AH', 'KD', 'QC'], '四条'],
  [['TH', 'TS', 'TD', '9H', '9D', '9C', '2S'], '葫芦'],
];
let bad = 0;
for (const [c, e] of cases) { const g = HN[handCat(ev7(c.map(parse)))]; if (g !== e) { bad++; console.log('  ❌', c.join(' '), '期望', e, '得到', g); } }
console.log(`A. 牌型评估: ${bad === 0 ? `✅ ${cases.length}/${cases.length}` : `❌ ${bad} 错`}`);

// 5/6 张公共牌的最佳牌型（这是之前崩过的地方）
const six = [parse('AH'), parse('KH'), parse('QH'), parse('JH'), parse('9H'), parse('2H')];
const b6 = evBest(six);
console.log(`   6 张选 5 张: ${HN[handCat(b6)]} ${HN[handCat(b6)] === '同花' ? '✅' : '❌'}`);
const five = [parse('2H'), parse('2D'), parse('5C'), parse('9S'), parse('KH')];
console.log(`   5 张直接评估: ${HN[handCat(evBest(five))]} ${HN[handCat(evBest(five))] === '一对' ? '✅' : '❌'}`);

/* ---------- B. 胜率引擎 ---------- */
const t0 = Date.now();
const eqs = [
  ['AA 对 1 人', 'calcEquity([{r:14,s:0},{r:14,s:1}], [], 1, 5000)', 0.83, 0.87],
  ['AA 对 7 人', 'calcEquity([{r:14,s:0},{r:14,s:1}], [], 7, 5000)', 0.35, 0.42],
  ['72o 对 1 人', 'calcEquity([{r:7,s:0},{r:2,s:1}], [], 1, 5000)', 0.31, 0.38],
  ['AK 对 3 人', 'calcEquity([{r:14,s:0},{r:13,s:1}], [], 3, 5000)', 0.33, 0.46],
];
let eb = 0;
for (const [lb, expr, lo, hi] of eqs) {
  const v = vm.runInContext(expr, ctx);
  const ok = v >= lo && v <= hi;
  if (!ok) eb++;
  console.log(`   ${ok ? '✅' : '❌'} ${lb}: ${(v * 100).toFixed(1)}%  理论 ${lo * 100}~${hi * 100}%`);
}
console.log(`B. 胜率引擎: ${eb === 0 ? '✅ 全部命中理论区间' : `❌ ${eb} 项异常`}  (每次 5000 轮, 共 ${Date.now() - t0}ms)`);

/* ---------- C. 性能 ---------- */
const deck = vm.runInContext('makeDeck()', ctx);
const t1 = Date.now(); let acc = 0;
for (let i = 0; i < 300000; i++) acc += ev7(deck.slice(i % 20, i % 20 + 7));
const ms = Date.now() - t1;
console.log(`C. 性能: 30 万次 7 张牌评估 ${ms}ms (${(300000 / ms * 1000 / 1000).toFixed(0)}k 次/秒)`);
const t2 = Date.now();
vm.runInContext('eqCache.clear(); getEquity([{r:14,s:0},{r:14,s:1}], [], 7)', ctx);
console.log(`   单次 AI 决策胜率计算: ${Date.now() - t2}ms（浏览器里一帧 16ms，不会卡顿）`);

/* ---------- D. 长跑模拟 ---------- */
vm.runInContext(`
  globalThis.R = { act:[0,0,0,0], fold:[0,0,0,0], rai:[0,0,0,0], all:[0,0,0,0],
                   enter:[0,0,0,0], streetHands:[0,0,0,0],
                   hands:0, sd:0, humanActs:0, pots:0, allinHands:0, showdownBoardOk:true, reset:0 };
  const _log = logAction;
  logAction = function(p){
    const s = community.length === 0 ? 0 : (community.length === 3 ? 1 : community.length === 4 ? 2 : 3);
    R.act[s]++;
    if (p.actionType === 'fold') R.fold[s]++;
    else if (p.actionType === 'raise') R.rai[s]++;
    else if (p.actionType === 'allin') R.all[s]++;
    return _log(p);
  };
  // 用 bettingRound 包装来精确测量"每街入场人数"
  const _br = bettingRound;
  bettingRound = async function(startIdx){
    const st = street;
    R.streetHands[st]++;
    R.enter[st] += players.filter(p=>!p.folded).length;
    return await _br(startIdx);
  };
`, ctx);

vm.runInContext(`
  globalThis.RUN = async function(n){
    for (let h=0; h<n; h++){
      if (gameOver) { resetGame(); R.reset++; }
      const iv = setInterval(()=>{
        if (!resolveHuman) return;
        const p = players[0];
        const toCall = Math.max(0, currentBet - p.bet);
        const r = Math.random(); R.humanActs++;
        if (r < 0.30) submitHuman('fold');
        else if (r < 0.94) submitHuman('call');
        else {
          const maxTo = p.bet + p.chips, minTo = Math.min(maxTo, currentBet + minRaise);
          if (maxTo > currentBet && p.chips > toCall && raisesThisStreet < 4) submitHuman('raise', Math.min(maxTo, minTo));
          else submitHuman('call');
        }
      }, 0);
      await playHand();
      clearInterval(iv);
      R.hands++;
      R.pots += lastPot;
      const live = players.filter(p=>!p.folded).length;
      const revealed = players.filter(p=>p.reveal).length;
      if (revealed > 1){ R.sd++; if (community.length !== 5) R.showdownBoardOk = false; }
      if (players.some(p=>p.allIn)) R.allinHands++;
      const total = players.reduce((a,x)=>a+x.chips,0);
      if (total !== 8000) throw new Error('筹码不守恒! 第'+handNo+'手 total='+total);
      if (players.some(p=>p.chips < 0)) throw new Error('出现负筹码!');
    }
    return R;
  };
`, ctx);

ctx.__si = setInterval; ctx.__ci = clearInterval;
vm.runInContext(`setInterval=(f,m)=>globalThis.__si(f,m); clearInterval=h=>globalThis.__ci(h); sleep=()=>Promise.resolve();`, ctx);

(async () => {
  const t3 = Date.now();
  let R;
  try { R = await vm.runInContext('RUN(300)', ctx); }
  catch (e) { console.log('D. ❌ 运行中断:', e.message); process.exit(1); }
  const dt = Date.now() - t3;
  const n = R.hands;
  const pc = v => ((v / n) * 100).toFixed(0) + '%';
  const names = ['翻牌前', '翻牌圈', '转牌圈', '河牌圈'];
  console.log(`D. 长跑模拟 ${n} 手 (含 ${R.reset} 次自动重开) — 耗时 ${dt}ms`);
  console.log(`   ✅ 筹码守恒: ${n} 手结算后总额恒为 8000，无负筹码`);
  console.log(`   ✅ 摊牌时公共牌完整: ${R.showdownBoardOk ? '全部 5 张' : '存在异常'}`);
  console.log(`   摊牌 ${R.sd} 手(${pc(R.sd)}) · 弃牌定胜负 ${n - R.sd} 手(${pc(n - R.sd)}) · 出现过全下 ${R.allinHands} 手(${pc(R.allinHands)})`);
  console.log(`   平均底池 ${(R.pots / n).toFixed(0)} 筹码（起始筹码 1000）`);
  console.log('   各街节奏（入场人数 / 该街行动次数）:');
  for (let i = 0; i < 4; i++) {
    const sh = R.streetHands[i] || 1;
    const t = R.act[i] || 1;
    console.log(`     ${names[i]}: 平均 ${(R.enter[i] / sh).toFixed(1)} 人入场 · ${(R.act[i] / sh).toFixed(1)} 次行动 · 弃牌 ${(R.fold[i] / t * 100).toFixed(0)}% / 加注 ${(R.rai[i] / t * 100).toFixed(0)}%`);
  }
  const stacks = vm.runInContext('players.map(p=>p.name+":"+p.chips+(p.chips<=0?"(出局)":""))', ctx);
  console.log('   最终筹码:', stacks.join('  '));
})();
