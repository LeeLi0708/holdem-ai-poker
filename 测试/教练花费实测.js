/* =========================================================================
   教练复盘 · 花费实测
   -------------------------------------------------------------------------
   用真实分词器（cl100k_base）数出教练这四种请求的实际输入，加上对推理模式
   输出量的合理估计，按 DeepSeek 官方价目折算「每手多花多少钱」。

   两个关键前提（都是官方规则，不是猜的）：
     · 思考模式下，思维链（reasoning_content）按输出 token 计费 —— 它才是大头；
     · 上下文缓存按「前缀匹配、64 token 一块」，教练的 system 每个类型都恒定不变，
       所以第二次起几乎全部命中（比牌局决策的 system 命中率高得多，因为里面没有
       会变动的记忆）。
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { encodingForModel } = require('js-tiktoken');

const html = fs.readFileSync(path.join(__dirname, '..', '德州扑克.html'), 'utf8');
const enc = encodingForModel('gpt-4o');
const tok = s => enc.encode(String(s === undefined || s === null ? '' : s)).length;

const PRICE = { 'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 } };
const P = PRICE['deepseek-v4-flash'];

/* 推理模式下思维链长度的估计（high 强度）。这是本脚本唯一的假设，其余都是量的。 */
const REASONING_TOK = { 'coach-hand': 500, 'coach-phase': 900, 'coach-session': 1800, 'coach-mem': 1000 };

const records = [];
const lastSys = new Map();
const BLOCK = 64;

function reply(content, usage){
  return Promise.resolve({ ok: true, status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }], usage }),
    text: () => Promise.resolve(content) });
}
function classify(msgs){
  const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
  const first = (msgs.filter(m => m.role === 'user')[0] || {}).content || '';
  if (sys.indexOf('连通性探针') >= 0) return { kind: 'probe', sys, usr: first };
  if (first.indexOf('合并成一段新的长期记忆') >= 0) return { kind: 'reflect', sys, usr: first };
  if (sys.indexOf('你评的是「决策质量」') >= 0){
    if (sys.indexOf('逐手复盘') >= 0) return { kind: 'coach-hand', sys, usr: first };
    if (sys.indexOf('阶段总结') >= 0) return { kind: 'coach-phase', sys, usr: first };
    if (sys.indexOf('整局') >= 0) return { kind: 'coach-session', sys, usr: first };
    return { kind: 'coach-mem', sys, usr: first };
  }
  return { kind: 'decide', sys, usr: first };
}

function mockFetch(url, opts){
  const body = JSON.parse(opts.body);
  const info = classify(body.messages);
  const sysArr = enc.encode(info.sys);
  const prev = lastSys.get(info.kind) || [];
  let common = 0;
  const mn = Math.min(sysArr.length, prev.length);
  while (common < mn && sysArr[common] === prev[common]) common++;
  lastSys.set(info.kind, sysArr);
  const hit = Math.floor(common / BLOCK) * BLOCK;
  const sysTok = sysArr.length, usrTok = tok(info.usr);
  const miss = usrTok + (sysTok - hit);

  let answer;
  if (info.kind === 'probe') answer = '{"ok":true}';
  else if (info.kind === 'reflect') answer = '{"memory":"这五手收紧了不少，桌上普遍松，我拿边缘牌跟大注吃过亏。","milestones":["不拿边缘牌接大注"]}';
  else if (info.kind === 'coach-hand') answer = JSON.stringify({
    score: 68, verdict: '翻前用边缘牌跟了加注，位置又差，这手是白送的。',
    good: '翻牌没中就直接弃了，没有继续往里投钱。',
    bad: '没位置还用 Q9s 跟大注，翻前就不该进池。',
    fix: '没位置时只玩 AJ 以上或者对子，其余一律弃。',
    note: '没位置就别用同花连张去跟加注。' });
  else if (info.kind === 'coach-phase') answer = JSON.stringify({
    rating: 71, style: '偏保守的跟注型打法，位置感不错但很少主动做大局。',
    leak: '有强牌时下注尺寸偏小，赢的时候赚得太少。', strength: '翻前纪律好，垃圾牌能果断弃掉。',
    trend: '比上一阶段进步，入池率从 47% 降到 34%。',
    plan: ['顶对在干燥面照打三条街，河牌下 2/3 池', '没位置的边缘牌只跟最小注', '每手结束问自己有没有主动下过注'],
    keyhand: 33 });
  else if (info.kind === 'coach-session') answer = JSON.stringify({
    rating: 73, summary: '这一局纪律性明显好过以前，垃圾牌弃得干脆，位置感也建立起来了。最大的问题是有牌不敢收钱，三次大底池都过牌到河牌。',
    style: '紧的、有纪律的、位置意识不错的跟注型玩家，赢的钱主要来自对手犯错。',
    mistakes: ['有强牌时下注尺寸太小', '没位置用边缘牌跟加注', '翻后偏向过牌跟注，很少主动施压'],
    strengths: ['翻前纪律好', '位置感清晰', '河牌面对大注能收手'],
    keyHands: [{ h: 35, why: '顶对连过两条街，丢了 1560 的池' }, { h: 36, why: '72o 小盲果断弃，纪律的样板' }],
    plan: ['顶对以上照打三条街', '没位置只跟最小注', '每手自问有没有主动下注'],
    opening: '第一手拿到顶对就直接下 2/3 池。' });
  else if (info.kind === 'coach-mem') answer = JSON.stringify({
    memory: '我位置好的时候敢偷池，没位置就变形；最大的毛病是赢的时候赚太少，有牌也只走半池。',
    keep: ['翻前没位置的弱牌一律弃', '有牌就主动收价值，别等河牌'],
    tags: ['位置感变好', '价值下注偏小'] });
  else {
    answer = JSON.stringify({ action: 'call', size: null, amount: 99999999,
      read: '他大概在偷池', think: '再跟一手看看', say: '跟了' });
  }
  const outTok = tok(answer) + (REASONING_TOK[info.kind] || 0);
  const usage = { prompt_tokens: hit + miss, prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss, completion_tokens: outTok, total_tokens: hit + miss + outTok };
  records.push({ kind: info.kind, sysTok, usrTok, hit, miss, outTok, sysLen: info.sys.length, usrLen: info.usr.length });
  return reply(answer, usage);
}

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => {});

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'http://localhost/holdem', virtualConsole: vc,
  beforeParse(window){
    window.fetch = mockFetch;
    window.AbortController = globalThis.AbortController;
    window.localStorage.clear();
    let seed = 20260930 >>> 0 || 1;
    window.Math.random = function(){ seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  }
});
const w = dom.window, d = w.document;
const q = id => d.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main(){
  await sleep(220);
  const H = w.HOLDEM;
  q('btnAISet').click();
  q('aiBase').value = 'https://api.deepseek.com';
  q('aiKey').value = 'sk-test-coach-cost';
  q('aiModel').value = 'deepseek-v4-flash';
  q('aiSeats').value = '7';
  q('aiReflect').value = '5';
  q('aiSave').click();
  q('aiClose').click();
  const tg = q('tgBrain'); tg.checked = true; tg.dispatchEvent(new w.Event('change'));
  await sleep(120);

  const HANDS = Number(process.env.HANDS || 26);   // 26 手 ≈ 5 次阶段复盘 + 1 次长期记忆压缩
  let done = 0;
  const hardStop = Date.now() + 420000;
  while (done < HANDS && Date.now() < hardStop){
    let idle = false; const w1 = Date.now();
    while (Date.now() - w1 < 30000){
      if (!q('btnNext').disabled){ idle = true; break; }
      if (!q('btnFold').disabled) q('btnFold').click();
      await sleep(6);
    }
    if (!idle) continue;
    const me = H.players()[0];
    if (me && me.chips < 800) me.chips = 1000;
    q('btnNext').click(); done++;
    const w2 = Date.now();
    while (Date.now() - w2 < 60000){
      if (!q('btnFold').disabled) q('btnFold').click();
      if (!q('btnNext').disabled) break;
      await sleep(6);
    }
  }
  // 再补一次整局复盘
  await H.sessionReview();
  await new Promise(r => setTimeout(r, 400));

  const hands = done || 1;
  const kindOf = k => records.filter(r => r.kind === k);
  const sum = (a, k) => a.reduce((x, y) => x + y[k], 0);
  const cost = arr => {
    let c = 0;
    for (const r of arr) c += (r.hit * P.hit + r.miss * P.miss + r.outTok * P.out) / 1e6;
    return c;
  };

  console.log('\n============== 教练复盘 · 花费实测 ==============');
  console.log('跑了 ' + hands + ' 手 · 共 ' + records.length + ' 次请求' +
    (errors.length ? '  ⚠️ 脚本报错 ' + errors.length + ' 条' : '  ✅ 零脚本错误'));
  console.log('分词器：cl100k_base ｜ 价格：deepseek-v4-flash 空闲时段（高峰 ×2）');
  console.log('思维链按输出计费，本脚本按 ' + JSON.stringify(REASONING_TOK) + ' 估计\n');

  const names = { 'coach-hand': '单手复盘（每手）', 'coach-phase': '阶段大复盘（每 ' + (H.coach().deepEvery) + ' 手）',
                  'coach-session': '整局复盘（点「结束」时）', 'coach-mem': '长期记忆压缩（每 ' + (H.coach().memEvery) + ' 次大复盘）' };
  let total = 0;
  for (const k of ['coach-hand', 'coach-phase', 'coach-session', 'coach-mem']){
    const arr = kindOf(k);
    if (!arr.length){ console.log('—— ' + names[k] + '：此次没触发\n'); continue; }
    const c = cost(arr);
    total += c;
    console.log('—— ' + names[k] + ' · ' + arr.length + ' 次 ——');
    console.log('  输入 system : ' + (sum(arr, 'sysTok') / arr.length).toFixed(0) + ' token（其中命中 ' +
      (sum(arr, 'hit') / arr.length).toFixed(0) + '，命中率 ' +
      (sum(arr, 'hit') / (sum(arr, 'hit') + sum(arr, 'miss')) * 100).toFixed(0) + '%）');
    console.log('  输入 user   : ' + (sum(arr, 'usrTok') / arr.length).toFixed(0) + ' token');
    console.log('  输出（含思维链）: ' + (sum(arr, 'outTok') / arr.length).toFixed(0) + ' token');
    console.log('  单次花费    : ¥' + (c / arr.length).toFixed(5));
    console.log('  摊到每手    : ¥' + (c / hands).toFixed(5) + '\n');
  }
  console.log('=================================================');
  console.log('教练总花费（' + hands + ' 手）: ¥' + total.toFixed(4));
  console.log('摊到每手                      : ¥' + (total / hands).toFixed(5) + '（空闲）/ ¥' + (total / hands * 2).toFixed(5) + '（高峰）');
  console.log('对比：牌局本身实测约 ¥0.017/手（空闲）→ 教练让它贵了约 ' +
    (total / hands / 0.017 * 100).toFixed(0) + '%');
  process.exit(0);
})().catch(e => { console.log('❌ 脚本崩了: ' + (e && e.stack || e)); process.exit(1); });
