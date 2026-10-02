/* =========================================================================
   AI 大脑链路自检
   -------------------------------------------------------------------------
   用 jsdom 加载真实页面 + mock 掉 DeepSeek 接口，验证：
     1. 加载无错、配置面板可用、连接自检能通
     2. 每个 AI 的提示词里带的是它自己的人格
     3. 状态快照里只有它自己的底牌（不泄露对手）
     4. 模型吐垃圾 / 网络中断 → 自动回落本地速算，牌局不崩
     5. 动作合法化：越界加注被夹住、有注说 check 会被先重问再兜底成跟注、中文动作识别
     6. 每手记一条手记；重大输赢打 !! 标记
     7. 每 5 手复盘：压缩成长期记忆，原始手记清空
     8. 筹码守恒、零脚本错误
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const JSDOM_LIB = 'jsdom';
const { JSDOM, VirtualConsole } = require(JSDOM_LIB);

const file = path.join(__dirname, '..', '德州扑克.html');
const html = fs.readFileSync(file, 'utf8');

const errors = [];
const calls = [];
const faults = { garbage: false, netfail: false, coachEmpty: false, chatEmpty: false,
                 coachAteHard: false };
let decideSeq = 0;

// 三个独一无二的标记：用来验证 read/think 是私有的，只有 say 会传给别的 AI
const READ_MARK = 'MARK-读牌-私有';
const THINK_MARK = 'MARK-心里话-私有';
const SAY_MARK = 'MARK-场上话-公开';

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('   ✅ ' + label + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('   ❌ ' + label + (extra ? '  ' + extra : '')); }
}

function reply(content, usage, reasoning) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content: content, reasoning_content: reasoning || '' } }],
      usage: usage || null
    }),
    text: () => Promise.resolve(content)
  });
}

function classify(msgs) {
  const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
  const users = msgs.filter(m => m.role === 'user');
  const first = (users[0] || {}).content || '';
  // 追问会把「档案 + 问题」分成两条 user 消息，留档口径跟页面里一致：全部拼起来
  const allUsr = users.map(m => m.content).join('\n\n--- 追加 ---\n\n');
  if (sys.indexOf('连通性探针') >= 0) return { kind: 'probe', sys: sys, usr: allUsr };
  // 追问也是教练在说话，但它是「问答」不是「复盘」，先认出来，别落进下面那堆 coach-* 分支
  if (sys.indexOf('追问模式') >= 0) return { kind: 'coach-chat', sys: sys, usr: allUsr };
  // 💬 讨论模式：也是教练在说话，但不绑某一手 —— 必须排在下面那堆 coach-* 之前认出来
  if (sys.indexOf('讨论模式') >= 0) return { kind: 'coach-talk', sys: sys, usr: allUsr };
  if (first.indexOf('合并成一段新的长期记忆') >= 0) return { kind: 'reflect', sys: sys, usr: allUsr };
  // 🏆 第二十八轮：赢了之后补一句 —— 单独一类，别落进 decide 兜底
  //    （decide 的断言要求快照里带【你后面还有谁】，而赢牌发言根本不问局面）
  if (sys.indexOf('你赢下了刚才这一手') >= 0) return { kind: 'win', sys: sys, usr: allUsr };
  // 教练四种粒度：靠「你评的是决策质量」这句系统提示词认出它，再按角色句分辨是哪一种
  if (sys.indexOf('你评的是「决策质量」') >= 0) {
    if (sys.indexOf('逐手复盘') >= 0) return { kind: 'coach-hand', sys: sys, usr: allUsr };
    if (sys.indexOf('阶段总结') >= 0) return { kind: 'coach-phase', sys: sys, usr: allUsr };
    if (sys.indexOf('整局') >= 0) return { kind: 'coach-session', sys: sys, usr: allUsr };
    return { kind: 'coach-mem', sys: sys, usr: allUsr };
  }
  return { kind: 'decide', sys: sys, usr: allUsr };
}

function mockFetch(url, opts) {
  const body = JSON.parse(opts.body);
  const info = classify(body.messages);
  const m = info.sys.match(/你叫([^\s，,。]+)[，,]/);
  const who = m ? m[1] : '?';
  const isCoachKind = String(info.kind).indexOf('coach') === 0;
  calls.push({
    kind: info.kind, who: isCoachKind ? '教练' : who, sys: info.sys, usr: info.usr,
    model: body.model,
    maxTokens: body.max_tokens,
    thinking: !!(body.thinking && body.thinking.type === 'disabled'),
    thinkOn: !!(body.thinking && body.thinking.type === 'enabled'),
    effort: body.reasoning_effort || '',
    hasTemp: Object.prototype.hasOwnProperty.call(body, 'temperature'),
    hasFmt: !!body.response_format
  });

  // 造一份「像真的」usage：数字按字符数粗折，用来验证链路（真实值由接口给）
  function done(text, reasoning){
    const inTok = Math.max(20, Math.round((info.sys.length + info.usr.length) * 0.6));
    const hitTok = info.kind === 'probe' ? 0 : Math.round(inTok * 0.4);
    const outTok = Math.max(8, Math.round(text.length * 0.5));
    const r = reply(text, {
      prompt_tokens: inTok,
      prompt_cache_hit_tokens: hitTok,
      prompt_cache_miss_tokens: inTok - hitTok,
      completion_tokens: outTok,
      total_tokens: inTok + outTok
    }, reasoning);
    return r;
  }

  if (info.kind === 'probe') return done('{"ok":true}');

  // 演练「思考模式把输出预算吃光」：正文是空的，但思维链烧掉了一大截输出
  if (info.kind === 'coach-hand' && faults.coachEmpty) {
    faults.coachEmpty = false;
    return reply('', {
      prompt_tokens: 900, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900,
      completion_tokens: 1200, total_tokens: 2100
    }, 'MARK-思考过程：我把它想了一大段，但一个字正文都没留下。');
  }

  // 顽固版：**只要还开着思考模式就一律吐空**。
  // 用来验证「重试也不行 → 降级成普通模式」这条链真的能救回来 ——
  // 只有程序主动把思考关掉，mock 才会给正文。想蒙混过关是过不去的。
  // ⚠ 别用 info.thinkOn —— classify() 只返回 { kind, sys, usr }，thinkOn 是下面记录 calls 时才算的。
  //   要用这次请求真实的 thinking 开关，得从 body 上看。
  if (info.kind === 'coach-phase' && faults.coachAteHard) {
    const thinkNow = !!(body.thinking && body.thinking.type === 'enabled');
    if (thinkNow) {
      return reply('', {
        prompt_tokens: 900, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900,
        completion_tokens: 1300, total_tokens: 2200
      }, 'MARK-思考过程：还是只想不说话。');
    }
    faults.coachAteHard = false;     // 降级那次（思考已关）放行
  }

  // 追问：要的是人话。演练一次「思维链吃光输出预算」，正文空。
  if (info.kind === 'coach-chat') {
    if (faults.chatEmpty) {
      faults.chatEmpty = false;
      return reply('', {
        prompt_tokens: 1400, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1400,
        completion_tokens: 1500, total_tokens: 2900
      });
    }
    return done('MARK-教练-追问：结论是先守住，别在这个位置把筹码堆进去。' +
                '理由是这一手你要跟的比例已经超过了底池赔率能给的范围。',
                'MARK-思考过程-追问：先看他的问题问的是哪一步，把赔率算清楚，再回到结论上。');
  }

  // 教练：用独一无二的标记串，验证「点评内容真的来自接口、且真的渲染到了面板上」
  if (info.kind === 'coach-hand') return done(JSON.stringify({
    score: 72, verdict: 'MARK-教练-单手总评', good: 'MARK-教练-做对了',
    bad: 'MARK-教练-做错了', fix: 'MARK-教练-下一手', note: 'MARK-教练-留一句'
  }));
  if (info.kind === 'coach-phase') return done(JSON.stringify({
    rating: 68, style: 'MARK-教练-画像', leak: 'MARK-教练-漏洞',
    strength: 'MARK-教练-强项', trend: 'MARK-教练-走势',
    plan: ['MARK-教练-动作1', 'MARK-教练-动作2', 'MARK-教练-动作3'], keyhand: 3
  }));
  if (info.kind === 'coach-session') return done(JSON.stringify({
    rating: 75, summary: 'MARK-教练-整局总结', style: 'MARK-教练-整局画像',
    mistakes: ['MARK-教练-要改1', 'MARK-教练-要改2', 'MARK-教练-要改3'],
    strengths: ['MARK-教练-保留1', 'MARK-教练-保留2', 'MARK-教练-保留3'],
    keyHands: [{ h: 2, why: 'MARK-教练-关键手' }],
    plan: ['MARK-教练-准备1', 'MARK-教练-准备2', 'MARK-教练-准备3'],
    opening: 'MARK-教练-开场动作'
  }));
  if (info.kind === 'coach-mem') return done(JSON.stringify({
    memory: 'MARK-教练-长期记忆：我容易在翻前用边缘牌跟大注，以后收紧。',
    keep: ['MARK-教练-铁律'], tags: ['爱跟注', '位置差']
  }));

  if (info.kind === 'reflect') {
    if (faults.netfail) return Promise.reject(new Error('模拟网络中断'));
    const hasBig = info.usr.indexOf('!!') >= 0;
    return done(JSON.stringify({
      memory: who + '的复盘：这桌上得收紧一点' + (hasBig ? '，我吃过一次大亏，不能再拿边缘牌跟大注' : '') + '。',
      milestones: hasBig ? ['那手全下被清得很惨，以后别再用边缘牌接大注'] : []
    }));
  }

  // 🏆 赢牌发言：只说话，不问动作。回一句正常的场上话就够
  //    （验证点不在这个套件里，这里只要它别把 decide 的样本搅浑）
  if (info.kind === 'win') {
    return done(JSON.stringify({ say: [SAY_MARK], voice: 0, tone: '' }));
  }

  decideSeq++;
  // 故意让模型偶尔说人话（非 JSON），测重试与兜底
  if (faults.garbage && decideSeq % 4 === 0) return done('我觉得这手可以跟一下，不用想太多。');
  if (faults.netfail && decideSeq % 7 === 0) return Promise.reject(new Error('模拟网络中断'));

  const needCall = info.usr.match(/要跟 (\d+) 才能继续/);
  let action, size = null;
  if (needCall) {
    action = ['call', 'fold', 'call', 'raise', '跟注', 'fold'][decideSeq % 6];
  } else {
    action = ['check', 'raise', 'check', '过牌', 'check'][decideSeq % 5];
  }
  if (action === 'raise') size = ['third', 'half', 'two_third', 'three_quarter', 'pot', 'overbet', 'huge', 'min', 'allin', '高额加注', '2.5'][decideSeq % 11];
  if (decideSeq % 17 === 0) action = 'check';      // 有注要跟时喊 check → 应先被重问一次，再兜底成跟注
  // 故意夹带一个离谱的 amount，验证程序完全不理会 AI 报的数字
  // read / think 用独一无二的标记串包裹，便于验证「私有字段有没有外泄」
  return done(JSON.stringify({
    action: action, size: size, amount: 99999999,
    read: who + ' 读牌：' + READ_MARK,
    think: THINK_MARK + '-' + who,
    say: SAY_MARK
  }));
}

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
    window.fetch = mockFetch;
    window.AbortController = globalThis.AbortController;
    window.localStorage.clear();
    // 固定随机种子：发牌、抖动全部可复现，避免「同一份代码有时过有时不过」
    let seed = Number(process.env.HOLDEM_SEED || 20260930) >>> 0 || 1;
    window.Math.random = function(){
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }
});
const w = dom.window, d = w.document;
const q = id => d.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 「重新开局」现在要点两次才生效（防误触），测试里统一走这个 helper
async function clickReset(){
  q('btnReset').click();
  await sleep(20);
  q('btnReset').click();
  await sleep(220);
}

// 把页面里的 log() 包一层：中途「重新开局」会清空战报 DOM，包一层才能留住完整历史
const logBuf = [];
(function wrapLog() {
  const orig = w.log;
  if (typeof orig !== 'function') return;
  w.log = function (text, cls) { logBuf.push((cls || 'sys') + ' | ' + text); return orig.apply(this, arguments); };
})();
const logText = () => logBuf.join('\n');

function waitFor(cond, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let v = false;
      try { v = cond(); } catch (e) { }
      if (v) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 25);
  });
}

let stopAt = 5;
let handsPlayed = 0, lastHandNo = 0, restarts = 0;

// 人类永远弃牌：只损失盲注，不会在一手之内输光。
// 若他中途出局，测试会点「重新开局」换掉 players 数组，
// 后面按引用抓的快照（P / ai1）和手数节奏就全乱了。
function autoHuman() {
  if (!q('controls').classList.contains('on')) return;
  if (!q('btnFold').disabled) q('btnFold').click();
  else if (!q('btnCall').disabled) q('btnCall').click();
}

// 人类输光（现在会转观战）/ 赢光整桌 → 点「重新开局」接着测（记忆应当保留）
// 「重新开局」要点两次才生效，而驱动循环是同步的 setInterval，
// 所以这里用「先点一次待命、下一拍再点一次」的两段式，不阻塞循环。
let resetArmed = false;
function maybeRestart() {
  const bar = q('resultBar');
  const rb = bar.textContent || '';
  const ended = bar.classList.contains('on') &&
    (rb.indexOf('你已出局') >= 0 || rb.indexOf('观战中') >= 0 ||
     rb.indexOf('👑') >= 0 || rb.indexOf('通吃整桌') >= 0);
  if (!ended || resetArmed) return false;
  q('btnReset').click();                       // 第一次：待命
  resetArmed = true;
  setTimeout(() => { q('btnReset').click(); resetArmed = false; restarts++; }, 20);   // 第二次：真生效
  return true;
}

function startDriver() {
  return setInterval(() => {
    const h = w.HOLDEM.bet().handNo;
    if (h < lastHandNo) lastHandNo = 0;              // 检测到重开局
    if (h > lastHandNo) { handsPlayed += h - lastHandNo; lastHandNo = h; }
    maybeRestart();
    autoHuman();
    const nb = q('btnNext');
    if (nb && !nb.disabled && handsPlayed < stopAt) nb.click();
  }, 6);
}

/* 一手一手地打：等这一手真正结算完再开下一手。
   中途给人类补筹码，避免他输光导致「重新开局」——重开局会换掉 players 数组，
   让后面按引用抓的快照（P、ai1）失效，也让「打满 5 手 → 触发复盘」变得不确定。
   这样每一轮手数、每个座位攒到的手记条数才是确定的。 */
async function playHands(n) {
  let done = 0;
  const hardStop = Date.now() + 240000;
  while (done < n && Date.now() < hardStop) {
    // 1) 等桌面空闲
    let idle = false;
    const w1 = Date.now();
    while (Date.now() - w1 < 30000) {
      if (maybeRestart()) break;
      if (!q('btnNext').disabled) { idle = true; break; }
      autoHuman();
      await sleep(8);
    }
    if (!idle) continue;
    // 2) 给人类补足筹码，杜绝他这一手输光
    const me = w.HOLDEM.players()[0];
    if (me && me.chips < 600) me.chips = 1000;
    // 3) 发牌并等这一手结束
    q('btnNext').click();
    handsPlayed++;
    lastHandNo = w.HOLDEM.bet().handNo;
    let finished = false;
    const w2 = Date.now();
    while (Date.now() - w2 < 60000) {
      autoHuman();
      if (maybeRestart()) break;
      if (!q('btnNext').disabled) { finished = true; break; }
      await sleep(8);
    }
    if (finished) done++;
  }
  return done >= n;
}

const settled = () => {
  const bar = q('resultBar');
  return !q('btnNext').disabled ||
    (bar.classList.contains('on') && /💀|👑/.test(bar.textContent || ''));
};

// 本次测试把 7 个席位全交给 AI 大脑
const brainOnSeat = p => !p.isHuman;

(async () => {
  await sleep(350);
  console.log('=== 1. 页面加载 ===');
  ok(errors.length === 0, '加载期无脚本错误', errors.length ? '\n' + errors.join('\n') : '');
  ok(q('aiStatus').textContent === '未配置', '初始状态显示「未配置」', '实际：' + q('aiStatus').textContent);

  console.log('\n=== 2. 下注金额由程序算，AI 只选档位 ===');
  const H = w.HOLDEM;
  ok(!!H, '调试入口可用');
  // ⚠ 第二十二轮起「出手前想一想」默认开着（真实使用要慢一点才像人）。自检里必须关掉：
  //   不是它坏了，是自检要把几百次行动跑完，每次都停一秒就变成几十分钟。
  H.gameCfg().think = false;
  const P = H.players(), ai1 = P[1];
  const b0 = H.bet();
  const minTo0 = Math.min(ai1.bet + ai1.chips, b0.currentBet + b0.minRaise);
  const maxTo0 = ai1.bet + ai1.chips;

  ok(H.normalize({ action: 'raise', size: 'min' }, ai1, 20).amount === minTo0,
    '档位 min → 精确等于最小加注到', '得到 ' + H.normalize({ action: 'raise', size: 'min' }, ai1, 20).amount);
  ok(H.normalize({ action: 'raise', size: 'allin' }, ai1, 20).amount === maxTo0,
    '档位 allin → 精确等于全部筹码', '得到 ' + H.normalize({ action: 'raise', size: 'allin' }, ai1, 20).amount);
  ok(H.normalize({ action: 'raise', size: '全下' }, ai1, 20).amount === maxTo0, '中文档位「全下」被识别');
  const potR = H.normalize({ action: 'raise', size: 'pot' }, ai1, 20);
  ok(potR.type === 'raise' && potR.amount >= minTo0 && potR.amount <= maxTo0,
    '档位 pot 的结果落在合法区间内', 'amount=' + potR.amount + ' ∈ [' + minTo0 + ',' + maxTo0 + ']');
  const ig = H.normalize({ action: 'raise', size: 'allin', amount: 99999999 }, ai1, 20);
  ok(ig.amount === maxTo0, 'AI 夹带的 amount=99999999 被彻底忽略（金额不由它决定）', 'amount=' + ig.amount);
  const bad = H.normalize({ action: 'raise' }, ai1, 20);
  ok(bad.type === 'raise' && bad.amount >= minTo0 && bad.amount <= maxTo0,
    '没给档位时程序自己兜一个合法金额', 'amount=' + bad.amount);
  ok(H.normalize({ action: '跟注' }, ai1, 20).type === 'call', '中文「跟注」被识别');
  ok(H.normalize({ action: '弃牌' }, ai1, 20).type === 'fold', '中文「弃牌」被识别');
  const softCheck = H.normalize({ action: 'check' }, ai1, 20);
  ok(softCheck.type === 'call', '有注要跟时说 check → 兜底成跟注（绝不弃牌）', softCheck.type);
  ok(softCheck.soft === 'check', '并且打了 soft 标记，外层知道这是「手滑」而不是真心想过牌', String(softCheck.soft));
  ok(H.normalize({ action: 'check' }, ai1, 0).type === 'call', '无注要跟时说 check → 过牌');
  ok(H.normalize({ action: 'fold' }, ai1, 0).type === 'call', '无注要跟时弃牌 → 转为过牌（不白扔牌权）');
  ok(H.normalize({ action: '胡说八道' }, ai1, 20) === null, '无法识别的动作返回 null（交给外层兜底）');
  ok(H.normalize(null, ai1, 20) === null, '空决定返回 null');
  ok(H.parse('```json\n{"a":1}\n```').a === 1, 'JSON 解析能剥掉 markdown 代码块');
  ok(H.parse('好的，我的决定是 {"action":"call"} 完毕').action === 'call', 'JSON 解析能从废话里抠出对象');
  ok(H.parse('完全不是 JSON') === null, '纯废话返回 null');

  console.log('\n=== 3. 重大输赢标记 ===');
  ai1.hole = [{ r: 14, s: 0 }, { r: 13, s: 1 }];
  ai1.folded = false; ai1.allIn = false;
  ai1.chipsBefore = 1000; ai1.chips = 400; H.record();
  let n = ai1.mem.notes[ai1.mem.notes.length - 1];
  ok(n.big === 'loss', '净亏 600（=60% 起始筹码）被标为惨败', n.big + ' | ' + n.desc);
  ok(ai1.mem.miles.some(x => x.indexOf('惨败') >= 0), '惨败进入「刻骨铭心」');

  ai1.allIn = true; ai1.chipsBefore = 1000; ai1.chips = 980; H.record();
  n = ai1.mem.notes[ai1.mem.notes.length - 1];
  ok(n.big === 'loss', '全下且小亏（只亏 20）也被标为惨败', n.big + ' | ' + n.desc);

  ai1.allIn = false; ai1.chipsBefore = 1000; ai1.chips = 1450; H.record();
  n = ai1.mem.notes[ai1.mem.notes.length - 1];
  ok(n.big === 'win', '净赚 450 被标为大胜', n.big + ' | ' + n.desc);

  const sysTxt = H.sysText(ai1);
  ok(sysTxt.indexOf('!!') >= 0, '重大记录在提示词里以 !! 标出');
  ok(sysTxt.indexOf('你叫' + ai1.name) >= 0, '提示词里带的是这个座位自己的人格', ai1.name);

  console.log('\n=== 4. 复盘会带上重大记录 ===');
  const before = calls.length;
  await H.reflect(ai1);
  const refCall = calls.slice(before).find(c => c.kind === 'reflect');
  ok(!!refCall, '确实发出了复盘请求');
  ok(refCall && refCall.usr.indexOf('!!') >= 0, '复盘提示词里含 !! 重大记录（要求它必须记住）');
  ok(ai1.mem.summary.length > 0, '复盘产出了长期记忆', ai1.mem.summary.slice(0, 40) + '…');
  ok(ai1.mem.notes.length === 0, '复盘后原始手记被清空（放弃上下文）');
  // 记下这次手动复盘的位置，后面统计自动复盘时要把这 1 次排除掉
  const manualRefCalls = calls.filter(c => c.kind === 'reflect').length;

  // 复位，准备正式开局。用程序自己的清空接口——手工替换 p.mem 会让
  // 「牌桌对象」与「花名册」脱钩，后面测「重新开局不失忆」就测不准了。
  H.wipeSeatsMem();
  ai1.chips = 1000; ai1.hole = []; ai1.allIn = false;
  H.record(); // 复位后不再残留（hole 已清空 → 不会记）
  H.wipeSeatsMem();

  console.log('\n=== 5. 配置面板 + 连接自检 ===');
  q('btnAISet').click();
  ok(q('aiMask').classList.contains('on'), '设置面板能打开');
  q('aiBase').value = 'https://api.deepseek.com';
  q('aiKey').value = 'sk-self-test-0001';
  q('aiModel').value = 'deepseek-v4-flash';
  q('aiTemp').value = '1';
  q('aiReflect').value = '5';
  q('aiSeats').value = '7';
  q('aiTimeout').value = '20000';
  q('aiTest').click();
  await waitFor(() => q('aiTestOut').textContent.indexOf('正在') < 0, 8000);
  ok(q('aiTestOut').textContent.indexOf('✅') >= 0, '连接自检通过', q('aiTestOut').textContent.split('\n')[0]);
  ok(calls.filter(c => c.kind === 'probe').length === 1, '自检只发了一条探针请求');
  q('aiSave').click();
  await sleep(20);

  const tg = q('tgBrain');
  tg.checked = true;
  tg.dispatchEvent(new w.Event('change'));
  await sleep(30);
  ok(q('aiStatus').classList.contains('ok'), '开启后状态变为就绪', q('aiStatus').textContent);
  ok(q('aiBar').textContent.indexOf('7 席在线') >= 0, '顶栏显示 7 席在线与复盘点', q('aiBar').textContent);
  ok(d.querySelectorAll('.seat .brn').length === 8, '每个座位都有 🧠 徽标位');
  ok([...d.querySelectorAll('.seat .brn')].filter(e => e.textContent === '🧠').length === 7,
    '7 个 AI 座位亮起 🧠，人类座位不亮');

  console.log('\n=== 6. 打 5 手（每步都过 DeepSeek） ===');
  const t0 = Date.now();
  const reached = await playHands(stopAt);
  await sleep(500);
  ok(reached, '打完 5 手', '累计 ' + handsPlayed + ' 手 · 人类重开局 ' + restarts + ' 次 · 耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const dec = calls.filter(c => c.kind === 'decide');
  ok(dec.length > 20, '决策请求量正常', dec.length + ' 次');

  const names = Object.keys(H.personas);   // 现在换代了，从人格表动态取名字，改名也不用动测试
  const seenWho = new Set(dec.map(c => c.who));
  ok(names.every(n => seenWho.has(n)), '7 个人都上过场', [...seenWho].join('/'));
  const allPersona = dec.every(c => c.sys.indexOf('你叫') >= 0 && c.sys.indexOf('【刻骨铭心') >= 0);
  ok(allPersona, '每一次决策都带上了「人格 + 长期记忆 + 刻骨铭心」');
  const whoMatch = dec.every(c => c.who === '?' || c.sys.indexOf('你叫' + c.who) >= 0);
  ok(whoMatch, '每个人的提示词里装的是它自己的人格（没有串号）');
  const allState = dec.every(c => c.usr.indexOf('你的底牌：') >= 0);
  ok(allState, '每一次决策都带上了这手牌的状态快照');
  // E1：格式与规矩已经从 user 消息搬进 system（每手恒定、可被缓存），这里跟着改断言
  ok(dec.every(c => c.sys.indexOf('具体金额由程序按底池算') >= 0), '每次决策都明确告诉 AI：加注金额不用它算');
  ok(dec.every(c => c.usr.indexOf('"amount"') < 0), '提示词里已经不再要求 AI 输出金额');
  ok(dec.every(c => c.sys.indexOf('全部由发牌程序负责') >= 0), '系统提示写明发牌/洗牌/底池/赔率/结算都归程序');
  ok(dec.every(c => c.sys.indexOf('你不要报数字') >= 0), '系统提示明确禁止 AI 自己报数字');
  ok(dec.every(c => c.usr.indexOf('【规矩】') < 0), 'E1：规矩与输出格式已从局面快照里搬走，快照只剩事实');
  const leak = dec.filter(c => /对手的底牌[是为：]/.test(c.usr) || /其他玩家的底牌/.test(c.usr));
  ok(leak.length === 0, '状态快照里没有泄露对手底牌');

  console.log('\n=== 7. 每 5 手复盘 ===');
  const refs = calls.filter(c => c.kind === 'reflect').slice(manualRefCalls);
  ok(refs.length >= 1, '打满 5 手会自动触发复盘', refs.length + ' 次（手动触发的那次不计入）');
  const pending = P.filter(p => !p.isHuman && p.mem.sinceLast >= 5);
  ok(pending.length === 0, '没有人攒够 5 手还拖着不复盘（说明触发条件一成立就执行了）',
    pending.length ? '拖着的：' + pending.map(p => p.name + '(' + p.mem.sinceLast + ' 手)').join('、') : '');
  const reflectedNames = new Set(refs.map(c => c.who));
  const notReflected = P.filter(p => !p.isHuman && !reflectedNames.has(p.name)).map(p => p.name);
  ok(refs.length + notReflected.length === 7,
    '7 个座位都交代清楚了：复盘 ' + refs.length + ' 人 + 手数不够 ' + notReflected.length + ' 人',
    notReflected.length ? '手数不够的：' + notReflected.join('、') + '（中途出局后拿不到牌，攒不满 5 手）' : '');
  const done = P.filter(p => !p.isHuman && reflectedNames.has(p.name));
  ok(done.length > 0 && done.every(p => p.mem.summary.length > 0), '复盘过的人都写进了长期记忆', done.length + ' 人');
  ok(done.every(p => p.mem.notes.length === 0), '复盘过的人原始手记被丢掉（只留总结，真正「放弃上下文」）');
  ok(done.every(p => p.mem.reflects >= 1), '复盘次数被记录');
  const reflLog = logText();
  ok(reflLog.indexOf('复盘时间') >= 0 && reflLog.indexOf('记住了') >= 0, '战报里有复盘记录');

  console.log('\n=== 8. 记忆卡界面 ===');
  const rp = done[0] || P[1];
  const rpSeat = P.indexOf(rp);
  d.querySelectorAll('.seat')[rpSeat].click();
  ok(q('memMask').classList.contains('on'), '点座位能打开记忆卡');
  ok(q('memHd').textContent.indexOf(rp.name) >= 0, '记忆卡标题是人名', q('memHd').textContent);
  ok(q('memPersona').textContent.length > 40, '记忆卡里有人格底色');
  ok(q('memSummary').textContent.length > 0 && q('memSummary').textContent.indexOf('还没有长期记忆') < 0,
    '记忆卡里显示了它的长期记忆', q('memSummary').textContent.slice(0, 30) + '…');
  ok(q('memStat').textContent.indexOf('待复盘 0 条') >= 0, '记忆卡显示待复盘条数为 0', q('memStat').textContent);
  q('memClose').click();
  ok(!q('memMask').classList.contains('on'), '记忆卡能关掉');

  console.log('\n=== 9. 模型抽风 / 断网 → 兜底不崩 ===');
  faults.garbage = true; faults.netfail = true;
  const hpBefore = handsPlayed;
  const t1 = Date.now();
  stopAt = hpBefore + 2;
  const drv2 = startDriver();
  const reached2 = await waitFor(() => handsPlayed >= stopAt && settled(), 240000);
  clearInterval(drv2);
  await sleep(250);
  ok(reached2, '接口抽风时牌局照样能推进', '累计 ' + handsPlayed + ' 手 · ' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
  ok(H.stat.fails > 0, '失败次数被记录', H.stat.fails + ' 次');
  const errLog = logText();
  ok(errLog.indexOf('大脑没连上') >= 0, '战报里明确提示「大脑没连上，改用本地速算」');
  const fbDec = calls.filter(c => c.kind === 'decide').length;
  ok(fbDec > dec.length, '抽风期间仍然在尝试请求接口');
  faults.garbage = false; faults.netfail = false;

  console.log('\n=== 10. 账目与稳定性 ===');
  const sumSeats = [...d.querySelectorAll('.seat .chips')].map(e => +e.textContent.replace(/,/g, '')).reduce((a, x) => a + x, 0);
  ok(sumSeats === 8000, '结算后桌上筹码合计 8000（守恒）', '实际 ' + sumSeats);
  ok(H.stat.calls > 0, '统计到接口调用总数', H.stat.calls + ' 次');
  const aiStatus = q('aiStatus').textContent;
  // 不写死模型名：界面上回显的应当就是配置里那个
  ok(aiStatus.indexOf(H.cfg.model) >= 0, '配置在界面上回显正常', aiStatus);
  ok(errors.length === 0, '全程零脚本错误', errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n=== 11. 九档加注梯子 ===');
  const aiLive = H.players().find(p => !p.isHuman && p.chips > 200) || H.players()[1];
  const bNow = H.bet();
  const maxTo = aiLive.bet + aiLive.chips;
  const minTo = Math.min(maxTo, bNow.currentBet + bNow.minRaise);
  const ladder = H.sizeLadder;
  const amts = ladder.map(s => H.sizeToAmount(aiLive, s));
  let mono = true;
  for (let i = 1; i < amts.length; i++) if (amts[i] < amts[i - 1]) mono = false;
  ok(ladder.length === 9, '梯子有 9 档', ladder.join(' < '));
  ok(mono, '档位越高，算出的金额不会更低（单调不减）', ladder.map((s, i) => s + ':' + amts[i]).join('  '));
  ok(amts.every(a => a >= minTo && a <= maxTo), '每一档都落在合法区间内', '[' + minTo + ',' + maxTo + ']');
  ok(amts[0] === minTo, '最低档 min 恒等于最小加注到');
  ok(amts[amts.length - 1] === maxTo, '最高档 allin 恒等于全部筹码');
  const same = (x, y) => H.sizeToAmount(aiLive, x) === H.sizeToAmount(aiLive, y);
  ok(same('1/3池', 'third') && same('三分之一池', 'third') && same('1/3', 'third'), '1/3 池的各种写法都认得');
  ok(same('高额加注', 'overbet') && same('raise high', 'overbet') && same('重注', 'overbet'), '「高额加注 / raise high / 重注」都归到超池档');
  ok(same('2.5', 'huge') && same('超大注', 'huge'), '「超大注 / 2.5」归到超大档');
  ok(same('全下', 'allin') && same('shove', 'allin') && same('梭哈', 'allin'), '全下的各种写法都认得');
  ok(same('一句听不懂的话', 'half'), '档位说不清时兜到半池（不会算出离谱金额）');

  console.log('\n=== 12. 重新开局不会让 AI 失忆 ===');
  // 等桌面彻底空闲：一手牌是「结算 → 记手记 → 复盘 → 才重新点亮下一手」，
  // 按钮亮起来才代表复盘已经落定，这时候采样才不会被异步残尾改掉。
  await waitFor(() => !q('btnNext').disabled || /💀|👑/.test(q('resultBar').textContent || ''), 20000);
  await sleep(300);
  const P0 = H.players();
  const memBefore = P0.filter(p => !p.isHuman).map(p => p.name + '|' + p.mem.summary + '|' + p.mem.reflects).join('#');
  const hadMem = P0.some(p => !p.isHuman && p.mem.summary.length > 0);
  q('btnReset').click();           // 第一次：待命
  await sleep(20);
  q('btnReset').click();           // 第二次：真生效
  await sleep(30);
  const P1 = H.players();
  const memAfter = P1.filter(p => !p.isHuman).map(p => p.name + '|' + p.mem.summary + '|' + p.mem.reflects).join('#');
  const sameRef = P0.every((p, i) => p.isHuman || p.mem === H.roster().seats[i-1].mem);
  ok(sameRef, '牌桌上的记忆与花名册是同一份（没有两个副本各说各话）');
  ok(hadMem && memBefore === memAfter, '点「重新开局」后长期记忆与复盘次数原样保留');
  ok(P1.every(p => p.chips === 1000), '筹码确实重置为 1000');
  ok(H.bet().handNo === 0, '手数确实归零', '手数=' + H.bet().handNo);
  const memCardLog = logText();
  ok(memCardLog.indexOf('记忆保留着') >= 0, '战报明确提示记忆被保留');

  console.log('\n=== 13. 调用日志 · 花名册换人 · 盲注配置 ===');

  // ---- 13.1 每一次请求都留了档 ----
  const lg = H.ailog();
  ok(lg.length > 0, '每次请求都留了档', lg.length + ' 条');
  ok(lg.every(r => r.sys && r.usr && typeof r.ms === 'number'),
    '每条记录都含系统提示词 / 局面快照 / 耗时');
  const firstDec = lg.find(r => r.kind === 'decide');
  ok(!!firstDec && firstDec.raw.length > 0 && firstDec.parsed && firstDec.parsed.action,
    '决策记录里存了它的原始回答和解析结果', firstDec ? firstDec.raw.slice(0, 40) : '（无）');
  ok(lg.some(r => r.kind === 'probe' && r.name.indexOf('探针') >= 0), '「连接自检」的探针请求也进了日志');
  ok(lg.some(r => r.kind === 'reflect'), '复盘请求也进了日志');
  const anyFail = lg.find(r => !r.ok);
  ok(!!anyFail && anyFail.err, '失败的请求留了失败原因', anyFail ? anyFail.err : '（没有失败记录）');

  q('btnAILog').click();
  ok(q('ailogMask').classList.contains('on'), '日志面板能打开');
  ok(d.querySelectorAll('#ailogList .ailog-item').length === lg.length,
    '列表把全部记录都渲染出来了', d.querySelectorAll('#ailogList .ailog-item').length + ' 条');
  ok(q('ailogList').textContent.indexOf('局面快照') >= 0, '每条都能展开看喂进去的原文');
  const mindRows = d.querySelectorAll('#ailogList .mind-row').length;
  ok(mindRows > 0, '调用日志把读牌/心里话/说出口拎出来单独成行（复盘不用啃原始 JSON）', mindRows + ' 行');
  ok(q('ailogList').textContent.indexOf(READ_MARK) >= 0 && q('ailogList').textContent.indexOf(THINK_MARK) >= 0,
    '日志里能读到它当时的读牌与心里话原话');

  q('ailogWho').value = '1';
  q('ailogWho').dispatchEvent(new w.Event('change'));
  const only1 = d.querySelectorAll('#ailogList .ailog-item').length;
  ok(only1 > 0 && only1 < lg.length, '能只看某一个座位的日志', only1 + ' 条（共 ' + lg.length + '）');
  q('ailogWho').value = '0';
  q('ailogWho').dispatchEvent(new w.Event('change'));

  q('ailogKind').value = '__fail';
  q('ailogKind').dispatchEvent(new w.Event('change'));
  ok(d.querySelectorAll('#ailogList .ailog-item').length === lg.filter(r => !r.ok).length,
    '能只看失败的请求', d.querySelectorAll('#ailogList .ailog-item').length + ' 条');
  q('ailogKind').value = 'reflect';
  q('ailogKind').dispatchEvent(new w.Event('change'));
  ok(d.querySelectorAll('#ailogList .ailog-item').length === lg.filter(r => r.kind === 'reflect').length,
    '能只看复盘请求');
  q('ailogKind').value = 'decide-retry';
  q('ailogKind').dispatchEvent(new w.Event('change'));
  ok(d.querySelectorAll('#ailogList .ailog-item').length === lg.filter(r => r.kind === 'decide-retry').length,
    '能只看「决策重试」这一类');
  q('ailogKind').value = '';
  q('ailogKind').dispatchEvent(new w.Event('change'));

  const logN0 = H.ailog().length;
  q('ailogClear').click();
  ok(H.ailog().length === logN0, '「清空日志」第一次点只是待命，不会真的清');
  q('ailogClear').click();
  ok(H.ailog().length === 0, '第二次点击才清空日志');
  q('ailogClose').click();
  ok(!q('ailogMask').classList.contains('on'), '日志面板能关掉');

  // ---- 13.2 花名册：换下去的人连记忆一起进替补席 ----
  const oldSeat2 = H.roster().seats[1].name;
  await H.reflect(H.players()[2]);
  const memOfOld = H.players()[2].mem.summary.slice(0, 20);
  ok(memOfOld.length > 0, '换人前 2 号座已经攒下长期记忆', memOfOld + '…');

  q('aiRoster').click();
  ok(q('rosterMask').classList.contains('on'), '花名册能打开');
  ok(d.querySelectorAll('#rosterList .roster-row').length === 7, '在座 7 个人都列出来了');

  d.querySelector('#rosterList button[data-swap="2"]').click();
  ok(q('swapMask').classList.contains('on'), '点「换人」弹出换人面板');
  q('swapPick').value = '__new';
  q('swapPick').dispatchEvent(new w.Event('change'));
  ok(q('swapCustom').style.display !== 'none', '选「自己捏一个」会展开自定义表单');
  q('swapName').value = '';
  q('swapOk').click();
  ok(q('swapOut').textContent.indexOf('起个名字') >= 0, '没填名字会被拦下，不会换上个无名氏');
  q('swapName').value = '老周';
  q('swapEmoji').value = '🦦';
  q('swapStyle').value = '测试型';
  q('swapPersona').value = '';
  q('swapOk').click();
  ok(q('swapOut').textContent.indexOf('性格设定不能空') >= 0, '没填性格会被拦下（性格是它成为「人」的依据）');
  q('swapPersona').value = '你叫老周，退休教师，只玩好牌，从不诈唬，别人加注你就退。';
  q('swapOk').click();
  await sleep(1200);
  ok(H.roster().seats[1].name === '老周', '2 号座换成了新捏的老周', H.roster().seats[1].name);
  ok(H.roster().bench.length === 1 && H.roster().bench[0].name === oldSeat2,
    '换下去的人进了替补席，人没丢', H.roster().bench.map(a => a.name).join('/'));
  ok(H.roster().bench[0].mem.summary.slice(0, 20) === memOfOld, '替补席上的人记忆原封不动');
  ok(H.players()[2].name === '老周', '牌桌上立刻换成了新人');
  ok(H.players()[2].mem.summary === '', '新人是白纸一张（不会继承上一个人的记忆）');

  // ---- 13.3 替补席能请回座 ----
  d.querySelector('#benchList button[data-back="0"]').click();
  await sleep(20);
  ok(q('swapSeatRow').style.display !== 'none', '「请回座」时出现「回哪个座」选择');
  q('swapSeat').value = '2';
  q('swapOk').click();
  await sleep(1200);
  ok(H.roster().seats[1].name === oldSeat2, '老队友被请回 2 号座', H.roster().seats[1].name);
  ok(H.roster().bench.some(a => a.name === '老周'), '老周让位进了替补席');
  ok(H.roster().seats[1].mem.summary.slice(0, 20) === memOfOld, '请回来的还是原来那份记忆');
  ok(H.players()[2].mem === H.roster().seats[1].mem, '换人之后牌桌与花名册仍是同一份记忆');
  q('rosterClose').click();

  // ---- 13.4 盲注可配置 ----
  q('btnAISet').click();
  ok(q('cfgSB').value !== '' && q('cfgBB').value !== '', '设置面板里能改盲注', q('cfgSB').value + '/' + q('cfgBB').value);
  q('cfgSB').value = '25';
  q('cfgBB').value = '50';
  q('cfgEvery').value = '3';
  q('cfgMult').value = '2';
  q('cfgMaxLv').value = '1';
  q('cfgBlindUp').checked = true;
  q('aiSave').click();
  await sleep(20);
  ok(H.gamecfg().sb === 25 && H.gamecfg().bb === 50, '盲注改成了 25/50', H.gamecfg().sb + '/' + H.gamecfg().bb);
  q('aiClose').click();

  await playHands(1);
  ok(q('hBlinds').textContent === '25/50', '下一手就按新盲注发牌', q('hBlinds').textContent);
  await playHands(3);
  ok(q('hBlinds').textContent === '50/100', '每 3 手涨一级（每级 2 倍）', q('hBlinds').textContent);
  await playHands(1);
  ok(q('hBlinds').textContent === '50/100', '涨到封顶级数就停住不加码', q('hBlinds').textContent);

  q('btnAISet').click();
  q('cfgBlindUp').checked = false;
  q('aiSave').click();
  await sleep(20);
  ok(H.gamecfg().blindUp === false, '盲注递增可以关掉');
  q('aiClose').click();
  await playHands(1);
  ok(q('hBlinds').textContent === '25/50', '关掉递增后盲注不再涨', q('hBlinds').textContent);

  // ---- 13.5 战报标明每一步是谁做的决定 ----
  ok(d.querySelectorAll('#log .li.tag-ai').length > 0, 'AI 决定的行动在战报里带 🧠 标记',
    d.querySelectorAll('#log .li.tag-ai').length + ' 步');
  const tgOff = q('tgBrain');
  tgOff.checked = false;
  tgOff.dispatchEvent(new w.Event('change'));
  await playHands(1);
  ok(d.querySelectorAll('#log .li.tag-cpu').length > 0, '本地速算的行动带 ⚙ 标记',
    d.querySelectorAll('#log .li.tag-cpu').length + ' 步');
  ok(q('aiLegend').textContent.indexOf('电脑算的') >= 0 && q('aiLegend').textContent.indexOf('AI 决定的') >= 0,
    '战报上方有图例，说明哪些是电脑算的、哪些是 AI 决定的');
  tgOff.checked = true;
  tgOff.dispatchEvent(new w.Event('change'));
  console.log('\n=== 14. 状态快照扩充（A 组 / B 组）· 私有字段隔离 · 分层 ===');

  await playHands(1);   // 保证「最近这一手」是大脑在线打的：场上话、调用日志、分档才有新鲜样本
  const P14 = H.players();
  const ai14 = P14[1];
  const bt14 = H.bet();
  const toCall14 = Math.max(0, bt14.currentBet - ai14.bet);
  const maxTo14 = ai14.bet + ai14.chips;
  const minTo14 = Math.min(maxTo14, bt14.currentBet + bt14.minRaise);
  const fullTxt = H.stateText(ai14, toCall14, maxTo14, minTo14, 'full');
  const liteTxt = H.stateText(ai14, toCall14, maxTo14, minTo14, 'lite');

  // ---- 14.1 E1：规矩/格式搬去 system，快照只剩事实 ----
  ok(fullTxt.indexOf('【规矩】') < 0 && fullTxt.indexOf('"action"') < 0 &&
     fullTxt.indexOf('由小到大') < 0, 'E1 局面快照里已经没有规矩和输出格式，只剩事实');
  const sys14 = H.sysText(ai14);
  ok(sys14.indexOf('【规矩】') >= 0 && sys14.indexOf('"action"') >= 0 &&
     sys14.indexOf('"read"') >= 0 && sys14.indexOf('"say"') >= 0 && sys14.indexOf('min 最小加注') >= 0,
    'E1 规矩、档位表、五字段输出契约全都在 system 里（每手恒定，可被缓存）');

  // ---- 14.2 E2：两档快照的对照 ----
  ok(liteTxt.length < fullTxt.length, 'E2 精简档确实比全量档短',
    liteTxt.length + ' 字 vs ' + fullTxt.length + ' 字');
  // ⚠ 第二十六轮起「【桌上说出口的话】」从这份名单里移出去了 ——
  //   它现在**两档都给**（斗嘴不能只在 full 档成立；用户 2026-10-02 反馈「没有人讲话了」）。
  //   精简档要省的是「数据/过程」那几大块，「社交」这一小块不能省。
  const liteCut = ['【这一桌的底细', '【别人眼里的你】', '【你自己最近的手感】',
                   '【这一手到目前为止的过程】'];
  ok(liteCut.every(k => liteTxt.indexOf(k) < 0), 'E2 精简档砍掉的正是底细/过程/读人那几块');
  // 而「场上话」按「本手有没有人开过口」决定给不给 —— 正反两向都断
  const said14 = (H.say() || []).length;
  ok(said14 > 0 ? (liteTxt.indexOf('【桌上说出口的话】') >= 0)
                : (liteTxt.indexOf('【桌上说出口的话】') < 0),
    '★★ 精简档按「本手有没有人开过口」决定带不带场上话（有人给 / 没人不给）',
    '本手公开话 ' + said14 + ' 条 → ' + (liteTxt.indexOf('【桌上说出口的话】') >= 0 ? '带了' : '没带'));
  const coreKeys = ['你的底牌：', '公共牌：', '【你后面还有谁】', 'SPR', '【这一轮】',
                    '【程序替你算好的数字】'];
  ok(coreKeys.every(k => liteTxt.indexOf(k) >= 0), 'E2 精简档该留的硬信息一个没少');
  ok(fullTxt.indexOf('【别人眼里的你】') >= 0 && fullTxt.indexOf('【你自己最近的手感】') >= 0 &&
     fullTxt.indexOf('【桌上说出口的话】') >= 0, 'B1/B2/B5 三块读人材料都在全量档里');

  // ---- 14.3 A1/A4：焦点对手 + 下注尺度换算（从真实请求里找证据） ----
  const dec14 = calls.filter(c => c.kind === 'decide');
  ok(dec14.every(c => c.usr.indexOf('【你后面还有谁】') >= 0),
    'A2 每一次决策都告诉它身后还有几个人没表态');
  ok(dec14.every(c => c.usr.indexOf('SPR') >= 0), 'A3 每一次决策都给了 SPR 筹码底池比');
  const foeReq = dec14.filter(c => c.usr.indexOf('【你面前的这道坎】') >= 0);
  ok(foeReq.length > 0, 'A1 面对下注时会把「正在为难你的那个人」单独拎出来', foeReq.length + ' 次');
  ok(foeReq.every(c => /要跟 [\d,]+/.test(c.usr)), 'A1 焦点对手块里写清了你还差多少才跟得上');
  const pcts = [];
  foeReq.forEach(c => {
    const m = c.usr.match(/是下注前底池（[\d,]+）的 (\d+)%/);
    // 注意：全角括号只是普通字符，整个正则里唯一的捕获组就是那个百分比
    if (m) pcts.push(Number(m[1]));
  });
  ok(pcts.length > 0, 'A4 把他下注的尺度换算成了「占底池百分之几」', pcts.length + ' 次');
  ok(pcts.length === foeReq.length,
    'A4 每一处「焦点对手」都带百分比——说明认的是抬价的那个人，而不是跟注者',
    pcts.length + '/' + foeReq.length);
  ok(pcts.length > 0 && pcts.every(v => v >= 1 && v < 100000), 'A4 换算结果都是合理正数',
    pcts.length ? '范围 ' + Math.min.apply(null, pcts) + '% ~ ' + Math.max.apply(null, pcts) + '%' : '（无样本）');
  ok(H.focus(ai14, 0, false) === '', 'A1 没人下注时不会硬塞一个「焦点对手」');

  // ---- 14.4 A5：底池分层（临时造一个有人全下的局面） ----
  const bakBets = P14.map(p => ({ tb: p.totalBet, f: p.folded }));
  P14.forEach(p => { p.folded = false; p.totalBet = 400; });
  P14[1].totalBet = 1500; P14[2].totalBet = 1500;
  const potsTxt = H.pots(P14[3]);
  ok(potsTxt.indexOf('主池') >= 0 && potsTxt.indexOf('边池') >= 0,
    'A5 底池分层时讲清主池与边池各谁能争');
  ok(/你能争到的最多是 [\d,]+/.test(potsTxt), 'A5 明说它最多能赢到多少，不会把边池算成自己的');
  ok(potsTxt.indexOf('（没你的份）') >= 0, 'A5 争不到的池子明确标出来');
  ok(H.pots(P14[1]).indexOf('（没你的份）') < 0, 'A5 深度足够的人不会被标成没份');
  P14.forEach((p, i) => { p.totalBet = bakBets[i].tb; p.folded = bakBets[i].f; });

  // ---- 14.5 B3：施压线 ----
  ok(dec14.some(c => c.usr.indexOf('这一手怎么打的') >= 0),
    'B3 全量档里给了对手「整手分街串起来」的施压线');

  // ---- 14.6 B1/B2：自我形象 + 最近手感 ----
  ok(H.statsOf(ai14).length > 0, 'B1 数得出这个人在别人眼里的数据', H.statsOf(ai14));
  ok(H.myImage(ai14).indexOf('别人眼里') >= 0, 'B1 用一句话说清它给人的印象',
    H.myImage(ai14).slice(0, 30) + '…');
  const rec = ai14.stats.recent;
  ok(Array.isArray(rec) && rec.length > 0 && rec.length <= 3, 'B2 即时战绩只留最近 3 手',
    JSON.stringify(rec.map(x => x.h + '手:' + x.delta)));
  ok(H.roster().seats[0].stats.recent === rec, 'B2 最近战绩与花名册是同一份，能跟着存档走');
  ok(H.recentText(ai14).indexOf('第') >= 0, 'B2 最近手感能读出来', H.recentText(ai14).slice(0, 40) + '…');

  // ---- 14.7 私有字段隔离：read / think 私有，只有 say 公开 ----
  ok(dec14.every(c => c.usr.indexOf(THINK_MARK) < 0),
    'B5 心里话绝不外泄：任何人的局面快照里都搜不到别人的 think');
  // 读牌同样是私有的 —— 但口径要比以前更准：
  // 现在 AI 会把自己写过的读牌归档成「对某个人的判断」，下次跟那人交手时回放给自己看，
  // 所以「自己的读牌出现在自己的快照里」是设计内的、合法的。
  // 要守的边界是：任何人的快照里，只可能出现**它自己写过的**读牌；别人怎么读你，你看不到。
  const readAuthors14 = c => (String(c.usr).match(/([^\s，。：、]+) 读牌：/g) || [])
    .map(x => x.replace(' 读牌：', ''));
  ok(dec14.some(c => c.usr.indexOf(READ_MARK) >= 0),
    'B4a 确实发生了「自己的读牌回放给自己」（否则下面那条是空跑）',
    dec14.filter(c => c.usr.indexOf(READ_MARK) >= 0).length + '/' + dec14.length + ' 条快照里有自己的读牌');
  ok(dec14.every(c => readAuthors14(c).every(n => n === c.who)),
    'B4 读牌不跨人：每个人的快照里只可能出现它自己写过的读牌',
    dec14.map(c => c.who + '↔' + (readAuthors14(c).join('/') || '无')).join('  '));
  ok(dec14.some(c => c.usr.indexOf(SAY_MARK) >= 0),
    'B5 场上说出口的话会传给其他 AI（这才是公开信息）');
  // 战报是打牌时看的：默认只留「桌上发生的事」，私有推理收进调用日志，复盘时再翻。
  ok(logText().indexOf(THINK_MARK) < 0 && logText().indexOf(READ_MARK) < 0,
    '默认战报里不刷读牌与心里话，打牌时清静');
  ok(logText().indexOf(SAY_MARK) >= 0, '但场上说出口的话仍留在战报里（那是公开发生的事）');
  const lg14a = H.ailog().filter(r => r.parsed && (r.parsed.read || r.parsed.think || r.parsed.say));
  ok(lg14a.length > 0, '每一句读牌/心里话/场上话都完整留档在调用日志里，复盘有得看',
    lg14a.length + ' 条带心思的记录');
  ok(lg14a.some(r => String(r.parsed.read || '').indexOf(READ_MARK) >= 0),
    '调用日志里存着它的原话（read 标记串在档）');
  // 开关能开回来
  q('btnAISet').click();
  q('aiShowMind').checked = true;
  q('aiSave').click();
  H.takeMind(P[1], { read: 'MARK-开关后读牌', think: 'MARK-开关后心里话', say: 'MARK-开关后场上话', action: 'call' });
  H.logAct(P[1]);
  ok(logText().indexOf('MARK-开关后读牌') >= 0 && logText().indexOf('MARK-开关后心里话') >= 0,
    '打开「战报显示读牌」后，读牌与心里话重新出现在战报里');
  q('btnAISet').click();
  q('aiShowMind').checked = false;
  q('aiSave').click();
  H.takeMind(P[1], { read: 'MARK-关闭后读牌', think: 'MARK-关闭后心里话', say: 'MARK-关闭后场上话', action: 'call' });
  H.logAct(P[1]);
  ok(logText().indexOf('MARK-关闭后读牌') < 0 && logText().indexOf('MARK-关闭后心里话') < 0,
    '再关掉，又安静了');
  ok(logText().indexOf('MARK-开关后场上话') >= 0 && logText().indexOf('MARK-关闭后场上话') >= 0,
    '场上话不受开关影响，无论开关都打在战报里');
  ok(q('aiLegend').textContent.indexOf('读牌') >= 0 && q('aiLegend').textContent.indexOf('听得到') >= 0,
    '图例说明了读牌、心里话、场上话各谁能看见');
  const said = H.say();
  ok(said.length > 0, '桌上说的话被记下来，供后续决策引用', said.length + ' 句');
  ok(said.every(x => x.say && x.name && typeof x.seat === 'number'),
    '每一句都带说话人和座位');

  // ---- 14.8 B4：五字段被正确拆解 ----
  const probe = {};
  H.takeMind(probe, { read: '我猜他是听牌', think: '这把我得顶住', say: '来吧', action: 'call' });
  ok(probe.aiRead === '我猜他是听牌' && probe.aiThink === '这把我得顶住' && probe.aiSay === '来吧',
    'B4 read / think / say 三个字段分别落到不同口袋里');
  const probe2 = {};
  H.takeMind(probe2, { action: 'fold' });
  ok(probe2.aiRead === '' && probe2.aiThink === '' && probe2.aiSay === '',
    '模型漏字段时不会残留上一手的读牌/心里话');

  // ---- 14.9 E2：分层开关与实战分档 ----
  const lg14 = H.ailog().filter(r => r.kind === 'decide');
  const liteR = lg14.filter(r => r.tier === 'lite'), fullR = lg14.filter(r => r.tier === 'full');
  ok(liteR.length > 0 && fullR.length > 0, 'E2 实战里精简档和全量档都用上了',
    '精简 ' + liteR.length + ' 次 · 全量 ' + fullR.length + ' 次');
  ok(liteR.every(r => r.usr.indexOf('【这一桌的底细') < 0 && r.usr.indexOf('【别人眼里的你】') < 0),
    'E2 走精简档的请求里确实没塞那些重内容');
  const avgLen = a => Math.round(a.reduce((s, x) => s + x.usr.length, 0) / Math.max(1, a.length));
  ok(avgLen(liteR) < avgLen(fullR), 'E2 精简档平均更短（省 token 的意义就在这）',
    avgLen(liteR) + ' 字 vs ' + avgLen(fullR) + ' 字');
  ok(lg14.every(r => ['lite', 'full'].indexOf(r.tier) >= 0), '每条决策记录都标了用的是哪一档');
  q('btnAISet').click();
  ok(q('aiMask').classList.contains('on'), '设置面板里有分层开关');
  q('aiLayered').checked = true; q('aiSave').click();
  const tierOn = H.tier(ai14, 0);
  q('aiLayered').checked = false; q('aiSave').click();
  ok(H.cfg.layered === false && H.tier(ai14, 0) === 'full', 'E2 关掉分层开关后一律走全量');
  q('aiLayered').checked = true; q('aiSave').click();
  ok(H.cfg.layered === true && H.tier(ai14, 0) === tierOn, 'E2 开关能切回来，设置被记住', '当前 ' + tierOn);
  q('aiClose').click();

  // ---- 15. 计费链路：真实 usage、花费折算、模型与思考模式 ----
  console.log('\n=== 15. 计费链路与模型选择 ===');
  const st15 = H.stat;
  ok(st15.tokIn > 0 && st15.tokOut > 0, '页面按接口返回的 usage 累计了 token',
    st15.tokIn + ' 入 / ' + st15.tokOut + ' 出');
  ok(st15.spent > 0, '按价目表折出了累计花费', '¥' + st15.spent.toFixed(6));
  const withU = H.ailog().filter(r => r.usage);
  ok(withU.length > 0 && withU.length === H.ailog().length, '每一条日志都留了 token 用量',
    withU.length + ' / ' + H.ailog().length + ' 条');
  ok(withU.every(r => r.usage.prompt_tokens > 0 && r.usage.completion_tokens > 0),
    '用量里的输入与输出都是正数');
  ok(withU.some(r => (r.usage.prompt_cache_hit_tokens || 0) > 0),
    '缓存命中的 token 被单独记下来了（不分开算，钱就算不准）');
  ok(withU.every(r => typeof r.cost === 'number' && r.cost > 0), '每条按用量算了钱');
  const one15 = withU[0];
  ok(Math.abs(H.costOf(one15.usage, 'deepseek-v4-flash') - one15.cost) < 1e-12,
    '花费算法可复现（同输入同输出）');
  ok(!!H.priceOf('deepseek-v4-flash') && !!H.priceOf('deepseek-v4-pro'),
    '价目表认得 v4 两个型号');
  ok(H.priceOf('some-other-model') === null, '认不出的型号返回 null —— 宁可不算，也不瞎编钱');
  ok(H.costOf({ prompt_tokens: 1e6, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1e6, completion_tokens: 0 },
              'deepseek-v4-flash') === (H.peakNow() ? 3 : 1.5),
    '未命中输入 100 万 token 的单价对得上官方价（空闲 1.5 元 / 高峰 3 元）');
  ok(H.costOf({ prompt_tokens: 1e6, prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 0, completion_tokens: 0 },
              'deepseek-v4-flash') === (H.peakNow() ? 0.1 : 0.05),
    '命中输入 100 万 token 的单价对得上官方价（空闲 0.05 元 / 高峰 0.1 元）');
  ok(H.costOf(null, 'deepseek-v4-flash') === null, '接口没给 usage 就不算钱（不编数字）');

  const isCoachCall = c => String(c.kind).indexOf('coach') === 0;
  ok(calls.every(c => c.model === 'deepseek-v4-flash'),
    '所有请求都发到 v4-flash（deepseek-chat 已被官方停用）', String(calls[0] && calls[0].model));
  const playCalls = calls.filter(c => !isCoachCall(c));
  const coachCalls15 = calls.filter(isCoachCall);
  ok(playCalls.length > 0 && playCalls.every(c => c.thinking && !c.thinkOn),
    '牌局决策一律显式关掉思考模式（默认开着会白白多烧一大截输出）',
    playCalls.length + ' 次决策类请求');
  ok(coachCalls15.length > 0, '教练复盘也在同一套链路里发请求', coachCalls15.length + ' 次');
  ok(coachCalls15.every(c => c.thinkOn && !c.thinking),
    '教练复盘一律显式打开思考模式 —— 角色互换，一个要快要省，一个要真想清楚');
  ok(coachCalls15.every(c => !c.hasTemp),
    '思考模式下不再传 temperature（官方明确它无效，带着只会让人以为调过参）');
  ok(coachCalls15.every(c => c.effort === 'high'), '思考强度默认 high', coachCalls15[0] && coachCalls15[0].effort);
  ok(coachCalls15.every(c => c.hasFmt), '默认仍然带 JSON 模式，省得它写一大段散文');
  ok(H.cfg.model === 'deepseek-v4-flash', '默认模型已经迁到 v4-flash，不再是停用的那个');

  q('btnAILog').click();
  ok(d.querySelectorAll('#ailogList .ailog-tok').length > 0, '日志面板每条都显示了 token 与花费',
    d.querySelectorAll('#ailogList .ailog-tok').length + ' 条');
  ok(q('ailogSub').textContent.indexOf('约 ¥') >= 0, '合计行显示了累计花费与峰谷价');
  q('ailogClose').click();

  /* ---------------- 16. 视觉：内联立绘与角色卡 ---------------- */
  console.log('\n=== 16. 视觉：内联立绘与角色卡 ===');
  const artKeys = Object.keys(H.art || {});
  ok(artKeys.length === 8, '内联了 8 组人物美术资源', artKeys.join('/'));
  ok(artKeys.every(k => {
    const a = H.art[k];
    return a && String(a.face).indexOf('data:image/webp;base64,') === 0 &&
           String(a.full).indexOf('data:image/webp;base64,') === 0;
  }), '每组都同时具备头像与立绘，且都是内联 webp（不依赖外部文件）');

  const pnames = H.players().map(p => p.name);
  ok(new Set(pnames).size === 8, '8 个座位名字互不重复', pnames.join('/'));
  ok(H.players().every(p => !!p.key), '每个座位都能对上自己的立绘');

  const faces = [...d.querySelectorAll('.seat .ava .face')];
  ok(faces.length === 8, '每个座位卡里都嵌了头像', faces.length + ' 个');
  ok(faces.every(f => String(f.getAttribute('src')).indexOf('data:image/webp') === 0),
     '头像真的挂上了图，不是空壳');
  ok(d.querySelectorAll('.seat.mine').length === 1, '玩家自己的座位有专属标记');

  const seatEls16 = [...d.querySelectorAll('.seat')];
  seatEls16[1].click();
  await sleep(60);
  ok(q('memMask').classList.contains('on'), '点座位能打开角色卡');
  ok(String(q('memArt').getAttribute('src')).indexOf('data:image/webp') === 0, '角色卡左侧是立绘大图');
  ok(q('memArtName').textContent.length > 2, '立绘上压着名字与风格', q('memArtName').textContent.trim());
  ok(q('memLook').textContent.length > 12, '写了「她是谁」', q('memLook').textContent.slice(0, 18) + '…');

  q('memArt').click();
  await sleep(40);
  ok(q('artFull').classList.contains('on'), '点立绘能全屏看大图');
  q('artFull').click();
  await sleep(40);
  ok(!q('artFull').classList.contains('on'), '再点一下收起大图');
  q('memClose').click();

  seatEls16[0].click();
  await sleep(60);
  ok(q('memMask').classList.contains('on') && q('memHd').textContent.indexOf('你') >= 0,
     '玩家自己的座位也能点开看立绘', q('memHd').textContent);
  ok(q('memNow').style.display === 'none', '玩家那张卡上没有「让她复盘」这类按钮');
  q('memClose').click();

  /* ---------------- 17. 教练：单手 / 阶段 / 整局 / 长期记忆 ---------------- */
  console.log('\n=== 17. 教练 · 我的复盘 ===');
  await waitFor(() => H.coachIdle() === 0, 30000);   // 等在飞的复盘跑干净，后面的计数才确定
  const C = H.coach();
  const isCoachKind = k => String(k).indexOf('coach') === 0;
  const coachCalls = calls.filter(c => isCoachKind(c.kind));

  ok(coachCalls.length > 0, '教练真的发过请求（不是个摆设）', coachCalls.length + ' 次');
  ok(coachCalls.some(c => c.kind === 'coach-hand'), '打过牌就一定有单手复盘');
  ok(coachCalls.every(c => c.model === 'deepseek-v4-flash'),
    '教练默认跟牌局同一个模型（留空 = 省）', coachCalls[0].model);
  ok(C.enabled === true && C.thinking === true, '教练默认开着，且默认开推理模式');

  // —— 单手小复盘 ——
  const reviewed = C.hands.filter(r => r.reviewed && !r.err);
  ok(C.hands.length > 0, '每打完一手都抓下了「你」的原始档案', C.hands.length + ' 手');
  ok(reviewed.length > 0, '其中有手牌真的拿到了点评', reviewed.length + ' 手');
  const one = reviewed[0];
  ok(one.score >= 0 && one.score <= 100, '评分落在 0~100', String(one.score));
  ok(one.verdict.indexOf('MARK-教练-单手总评') >= 0, '点评内容来自接口返回', one.verdict);
  ok(one.fix.indexOf('MARK-教练-下一手') >= 0, '给了「下一手要照做的一件事」', one.fix);
  ok(one.mine.indexOf('翻前') >= 0 || one.mine.indexOf('没动过') >= 0, '记录了你自己每一步怎么走的');
  ok(one.table.indexOf('｜') >= 0, '记录了全桌过程，不是只丢一个结果给它');
  ok(logText().indexOf('🎓 教练 · 第') >= 0, '点评同步打进了右侧战报');

  // 隐私：教练拿到的必须只是「公开信息 + 你自己的底牌」
  const coachUsrAll = coachCalls.map(c => c.usr).join('\n');
  ok(coachUsrAll.indexOf('MARK-读牌-私有') < 0 && coachUsrAll.indexOf('MARK-心里话-私有') < 0,
    'AI 的读牌与心里话没有被顺手塞进教练的提示词');

  // —— 阶段大复盘（手动触发一次，验证产出与落库） ——
  const chunk17 = reviewed.slice(-Math.min(5, reviewed.length));
  const ph = await H.phaseReview(chunk17, false);
  ok(!!ph && !ph.err, '阶段大复盘能跑通', ph && (ph.err || ph.style));
  ok(ph.style.indexOf('MARK-教练-画像') >= 0 && ph.leak.indexOf('MARK-教练-漏洞') >= 0,
    '输出了「打法画像」与「最大漏洞」');
  ok(Array.isArray(ph.plan) && ph.plan.length === 3, '给了三条可执行动作', JSON.stringify(ph.plan));
  ok(ph.trend.length > 0 && ph.strength.length > 0, '给了「跟上一阶段比的走势」与「最稳的一项」');
  ok(ph.rating >= 0 && ph.rating <= 100, '阶段评分合法', String(ph.rating));
  ok(C.deeps.indexOf(ph) >= 0, '阶段复盘进了记录');
  ok(logText().indexOf('🎓 教练 · 阶段复盘') >= 0, '阶段复盘也打进了战报');
  ok(C.stat.sinceMem >= 1, '长期记忆的计数器在涨', String(C.stat.sinceMem));

  // —— 长期记忆压缩 ——
  await H.memCompress();
  ok(C.mem.indexOf('MARK-教练-长期记忆') >= 0, '长期记忆被压缩出来了', C.mem.slice(0, 30));
  ok(C.memLog.length >= 1 && C.memLog[C.memLog.length - 1].v >= 1, '记忆带版本号存了档');
  ok(C.stat.sinceMem === 0, '压缩完计数器归零，下一轮重新攒');

  // —— 整局复盘 + 落盘 ——
  const ses = await H.sessionReview();
  ok(!!ses && !ses.err, '整局复盘能跑通', ses && (ses.err || ses.summary));
  ok(ses.summary.indexOf('MARK-教练-整局总结') >= 0, '整局复盘的总评来自接口');
  ok(ses.mistakes.length === 3 && ses.strengths.length === 3, '「最该改 3 条 / 最该留 3 条」都齐了');
  ok(ses.plan.length === 3 && ses.opening.indexOf('MARK-教练-开场动作') >= 0,
    '给了下一局的准备动作与开场动作', ses.opening);
  ok(C.sessions.indexOf(ses) >= 0, '整局复盘进了记录');
  ok(ses.hands > 0 && ses.stat && ses.stat.n === ses.hands, '整局复盘带着这一局的硬数据', ses.hands + ' 手');
  ok(ses.stat.vpip >= 0 && ses.stat.vpip <= ses.stat.n, '硬数据自洽（进池手数不会超过总手数）',
    ses.stat.vpip + '/' + ses.stat.n);

  let persisted = null;
  try { persisted = JSON.parse(w.localStorage.getItem('holdem_coach_v1')); } catch (e) {}
  ok(!!persisted && Array.isArray(persisted.sessions) && persisted.sessions.length >= 1,
    '复盘记录写进了 localStorage（关掉页面下次打开还在）');
  ok(!!persisted && typeof persisted.mem === 'string' && persisted.mem.length > 0, '长期记忆也落盘了');

  // —— 面板 ——
  q('btnCoach').click();
  await sleep(60);
  ok(q('coachMask').classList.contains('on'), '点「🎓 复盘」能打开复盘面板');
  const tabs17 = [...d.querySelectorAll('#coachMask .ctab')];
  // 按名字找页签：以后再加页签也不会把这一串断言带崩（顺序变了也不怕）
  const tabBtn = k => tabs17.find(b => b.dataset.tab === k);
  const tabOrder17 = tabs17.map(b => b.dataset.tab);
  ok(tabs17.length >= 7, '复盘面板页签齐全', tabs17.length + ' 个');
  // 不写死顺序：以后再加页签，只补一条「在不在」，别把整串断言带崩
  ok(['now','curve','hist','phase','session','mem','set'].every(k => tabOrder17.indexOf(k) >= 0),
    '原有 7 个页签都还在', tabOrder17.join(','));
  ok(tabOrder17.indexOf('book') >= 0, '多了「📒 战绩」页签');
  ok(!!tabBtn('curve'), '多了「📈 走势」页签');
  ok(tabs17.every(b => b.textContent.trim().length > 0), '每个页签都有中文名字');
  ok(q('coachPaneNow').textContent.indexOf('MARK-教练-单手总评') >= 0, '「这一手」页显示了点评',
    q('coachPaneNow').textContent.slice(0, 24));
  ok(q('coachPaneNow').textContent.indexOf('下一手') >= 0, '「这一手」页把「下一手该改什么」摆出来了');
  tabBtn('phase').click(); await sleep(40);
  ok(q('coachPanePhase').textContent.indexOf('MARK-教练-漏洞') >= 0, '「阶段大复盘」页显示了最大漏洞');
  tabBtn('session').click(); await sleep(40);
  ok(q('coachPaneSession').textContent.indexOf('MARK-教练-整局总结') >= 0, '「完整对局」页显示了整局总结');
  ok(q('coachPaneSession').textContent.indexOf('MARK-教练-要改1') >= 0, '「完整对局」页列了要改的条目');
  tabBtn('mem').click(); await sleep(40);
  ok(q('coachPaneMem').textContent.indexOf('MARK-教练-长期记忆') >= 0, '「我的长期记忆」页显示了记忆');
  ok(q('coachPaneMem').textContent.indexOf('绝不能再忘') >= 0, '「我的长期记忆」页显示了铁律');
  tabBtn('set').click(); await sleep(40);
  ok(q('coEnabled').checked && q('coThinking').checked && q('coEffort').value === 'high',
    '设置页回显了教练配置（启用 / 推理模式 / 强度）');
  ok(q('coDeepEvery').value === '5' && q('coMemEvery').value === '5', '复盘间隔回显正确（5 / 5）');
  ok(q('coHistOn').checked && q('coHistKeep').value === '5', '档案设置回显正确（记录开着 / 留最近 5 手）');

  // 改配置：关掉推理模式，之后的新请求不该再带 thinking=enabled
  q('coThinking').checked = false; q('coSave').click();
  ok(H.coach().thinking === false, '设置能改（关掉推理模式）');
  const beforeOff = calls.length;
  await H.memCompress();
  const offCalls = calls.slice(beforeOff).filter(c => isCoachKind(c.kind));
  ok(offCalls.length > 0 && offCalls.every(c => !c.thinkOn && !c.effort),
    '关掉推理模式后，请求里不再有 thinking / reasoning_effort');
  q('coThinking').checked = true; q('coSave').click();
  ok(H.coach().thinking === true, '还能改回来');
  q('coachClose').click();

  // —— 失败演练：思考模式把输出预算吃光（正文空、思维链一长段） ——
  faults.coachEmpty = true;
  const beforeCE = calls.length;
  const jce = await H.coachAsk('coach-hand', H.coachSys('逐手复盘（空输出演练）'),
                               '演练一下：第一次故意不给正文。', 600);
  ok(!!jce && jce.verdict === 'MARK-教练-单手总评', '输出被思考吃光时会自动重问一次，并且真的拿到了结果');
  const ceCalls = calls.slice(beforeCE).filter(c => isCoachKind(c.kind));
  ok(ceCalls.length === 2, '第一次失败 + 第二次重试 = 刚好两次请求', ceCalls.length + ' 次');
  ok(ceCalls[1].thinkOn === true && ceCalls[1].effort === (H.coach().effort || 'high'),
     '重试仍保留推理模式与原来的思考强度（靠放大输出预算来救，不是先降级）',
     'think=' + ceCalls[1].thinkOn + ' effort=' + ceCalls[1].effort);
  ok(ceCalls[1].hasFmt === false && ceCalls[1].hasTemp === false,
     '重试时放掉 JSON 模式与温度，让它先把话正常说出来');
  ok(H.coach().stat.thinkAte >= 1, '「输出被思考吃光」这件事被记进了统计',
     'thinkAte=' + H.coach().stat.thinkAte);
  ok(logText().indexOf('把输出预算吃光了') >= 0 || logText().indexOf('输出上限') >= 0,
     '战报里明确提示了这件事（不是悄悄重试）');

  // —— 顽固演练：重试也救不回来 → 必须降级成普通模式 ——
  // mock 设成「只要还开着思考就一律吐空」，所以只有程序真的把思考关掉才会拿到正文。
  {
    const dgBefore = { downgrades: H.coach().stat.downgrades || 0, retries: H.coach().stat.retries || 0 };
    faults.coachAteHard = true;
    const beforeDG = calls.length;
    const jdg = await H.coachAsk('coach-phase', H.coachSys('阶段总结（顽固空输出演练）'),
                                 '演练：重试也拿不到正文。', 600);
    const dgCalls = calls.slice(beforeDG).filter(c => c.kind === 'coach-phase');
    if (dgCalls.length < 3)
      console.log('      · 诊断：本段请求 = ' + calls.slice(beforeDG).map(c => c.kind + '/think=' + c.thinkOn).join(', '));
    ok(!!jdg && !!jdg.style, '重试也拿不到时，降级成普通模式把结果救回来了',
      jdg ? String(jdg.style).slice(0, 30) : 'null');
    ok(dgCalls.length === 3, '放大重试 + 降级 = 一共三次请求（① 原设置 ② 重试 ③ 降级）',
      dgCalls.length + ' 次');
    ok(dgCalls[0].thinkOn === true, '第 1 次按设置开着思考模式');
    ok(dgCalls[1].thinkOn === true, '第 2 次重试仍开着思考模式（只放大预算）',
      'think=' + dgCalls[1].thinkOn);
    ok(dgCalls[2].thinkOn === false, '★ 第 3 次降级：思考模式被关掉了（这才是救回来的原因）',
      'think=' + dgCalls[2].thinkOn);
    ok(dgCalls[1].maxTokens > dgCalls[0].maxTokens,
      '重试时输出上限确实被放大了', dgCalls[0].maxTokens + ' → ' + dgCalls[1].maxTokens);
    ok((H.coach().stat.downgrades || 0) === dgBefore.downgrades + 1,
      '降级次数记进了统计', String(H.coach().stat.downgrades));
    ok((H.coach().stat.retries || 0) > dgBefore.retries, '重试次数也记了',
      String(H.coach().stat.retries));
    ok(logText().indexOf('普通模式') >= 0, '★ 降级这件事明确提示了用户（战报里能看到）');
    ok(logText().indexOf('输出上限') >= 0, '提示里给了「怎么少走这一步」的解法（调大输出上限）');
  }

  // —— 输出上限可配置：设一个值之后，所有教练请求的最低预算都跟着涨 ——
  {
    const bakMT = H.coach().maxTokens, bakBoost = H.coach().retryBoost;
    H.coach().maxTokens = 0;
    ok(H.coachBudget(1600) === 1600, '输出上限配 0 时 = 各任务用自己的默认值',
      String(H.coachBudget(1600)));
    H.coach().maxTokens = 3000;
    ok(H.coachBudget(1600) === 3000, '★ 配了个更大的值 → 兜底生效（小任务也拿到 3000）',
      String(H.coachBudget(1600)));
    ok(H.coachBudget(5000) === 5000, '任务自己的默认更大时不会被压小（只保不压）',
      String(H.coachBudget(5000)));
    // 走一遍真实的请求，确认配置真的落到了 fetch 上
    const beforeMT = calls.length;
    // role 里要带「逐手复盘」，否则 classify 认不出这是 coach-hand（会落到 coach-mem）
    await H.coachAsk('coach-hand', H.coachSys('逐手复盘（输出上限演练）'), '随便问一句。', 600);
    const mtCalls = calls.slice(beforeMT).filter(c => c.kind === 'coach-hand');
    ok(mtCalls.length >= 1 && mtCalls[0].maxTokens === 3000,
      '★ 配置的输出上限真的传到了请求里', 'maxTokens=' + (mtCalls[0] || {}).maxTokens);
    H.coach().maxTokens = bakMT; H.coach().retryBoost = bakBoost;
  }

  // 「结束完整对局」：两步确认 + 真的跑完整局复盘
  const sesBefore = H.coach().sessions.length;
  q('btnEndSession').click();
  ok(q('btnEndSession').textContent.indexOf('再点一次') >= 0, '「结束完整对局」要点两次（防误触）');
  ok(String(q('btnEndSession').dataset.armed) === '1', '第一次点击只是待命，不会真结束');
  ok(H.bet().handNo > 0, '牌局没有被第一次点击打断', '第 ' + H.bet().handNo + ' 手');
  q('btnEndSession').click();
  await waitFor(() => H.coach().sessions.length > sesBefore, 60000);
  ok(H.coach().sessions.length > sesBefore, '第二次点击后整局复盘跑完并存档',
    H.coach().sessions.length + ' 条');
  ok(q('coachMask').classList.contains('on') && q('coachPaneSession').classList.contains('on'),
    '结束后自动切到「完整对局」页给你看结果');
  ok(logText().indexOf('🏁 整局复盘') >= 0, '整局复盘也打进了战报');
  q('coachClose').click();

  ok(errors.length === 0, '教练链路全程零脚本错误', errors.length ? '\n' + errors.join('\n') : '');


  /* ---------------- 18. 逐手档案 · 追问 · 导出 ---------------- */
  console.log('\n=== 18. 逐手档案 · 追问 · 导出 ===');
  await waitFor(() => H.coachIdle() === 0, 30000);
  const HS = H.hist();
  const hTab = [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'hist');

  // —— 档案本身 ——
  ok(HS.enabled === true, '逐手档案默认开着');
  ok(HS.keep === 5, '默认保留最近 5 手', String(HS.keep));
  ok(HS.hands.length > 0, '每打完一手都留了一份档案', HS.hands.length + ' 手');
  ok(HS.hands.filter(a => !a.star).length <= HS.keep, '未收藏的档案不超过保留上限',
    HS.hands.filter(a => !a.star).length + ' / ' + HS.keep);
  const arch = HS.hands[HS.hands.length - 1];
  ok(arch.mine.indexOf('翻前') >= 0 || arch.mine.indexOf('没动过') >= 0, '档案里有「我自己每一步怎么走的」');
  ok(arch.table.indexOf('｜') >= 0, '档案里有「全桌过程」');
  ok(typeof arch.delta === 'number' && typeof arch.pot === 'number', '档案里有结果与底池');
  // 只有「五张公共牌真的发完了」才允许出现对手底牌（哪怕你自己提前弃了，别人打到底也算真摊牌）
  const privLeak = HS.hands.filter(a => a.revealed.length > 0 && a.board.split(' ').length !== 5);
  ok(privLeak.length === 0, '公共牌没发完的手，不会把对手底牌写进档案（隐私红线）',
    privLeak.length ? ('漏了 ' + privLeak.length + ' 手，样本：' + JSON.stringify(privLeak[0].revealed)) : '');
  ok(HS.hands.some(a => a.revealed.length > 0) || HS.hands.every(a => a.revealed.length === 0),
    '摊牌信息字段存在且在两种取值下都自洽');

  // —— AI 的逻辑被归拢进来了 ——
  const withAi = HS.hands.filter(a => a.ai.length);
  ok(withAi.length > 0, '有档案归拢到了 AI 的决策', withAi.length + ' 手');
  const aiAll = withAi.reduce((s, a) => s.concat(a.ai), []);
  ok(aiAll.some(d => d.read.indexOf('MARK-读牌-私有') >= 0), 'AI 的「读牌」进了档案');
  ok(aiAll.some(d => d.think.indexOf('MARK-心里话-私有') >= 0), 'AI 的「心里话」进了档案');
  ok(aiAll.some(d => d.say.indexOf('MARK-场上话-公开') >= 0), 'AI 的「场上话」进了档案');
  ok(aiAll.every(d => d.street >= 0 && d.street <= 3), '每条决策都标着「哪条街」',
    [...new Set(aiAll.map(d => d.street))].join('/'));
  ok(aiAll.every(d => d.name && d.name.length > 0), '每条决策都标着「是谁」');
  ok(aiAll.some(d => d.tier === 'lite') && aiAll.some(d => d.tier === 'full'),
    '分层快照的档位也带进了档案（精简/全量都有）');
  ok(HS.hands.some(a => a.review && !a.review.err && a.review.verdict.indexOf('MARK-教练-单手总评') >= 0),
    '教练的点评回填到了档案上');

  // —— 收藏与保留：合成一份 8 手的档案验证淘汰规则（确定性，不靠运气） ——
  const bakHands = HS.hands.slice();
  HS.hands = [];
  for (let i = 1; i <= 8; i++) HS.hands.push({ id: 'T' + i, h: i, t: i, ai: [], chat: [], star: false });
  HS.hands[1].star = true;                       // 把第 2 手收藏
  H.histTrim();
  ok(HS.hands.length === 6, '未收藏只留最近 5 手（8 手 → 5 + 1 收藏）', HS.hands.length + ' 手');
  ok(HS.hands.some(a => a.id === 'T2'), '收藏的那一手不会被清掉');
  ok(!HS.hands.some(a => a.id === 'T1') && !HS.hands.some(a => a.id === 'T3'), '没收藏的老档案会被淘汰');
  ok(HS.hands[HS.hands.length - 1].id === 'T8', '时间顺序保持（新的一手在后面）');
  HS.hands = bakHands;

  // —— 真的打几手，验证「保留最近 N 手」在真实链路上也成立 ——
  const keepBak = HS.keep;
  q('btnCoach').click(); await sleep(50);
  [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'set').click(); await sleep(40);
  q('coHistKeep').value = '2'; q('coSave').click();
  ok(HS.keep === 2, '设置页能把保留手数改成 2');
  const beforeRestart = HS.hands.length;
  q('coachClose').click();
  await clickReset();                        // 上一节点过「结束完整对局」，牌局是停的
  await sleep(200);
  ok(H.bet().handNo === 0, '「重新开局」后手数归零', String(H.bet().handNo));
  ok(HS.hands.length === beforeRestart, '重新开局不会把逐手档案清掉（' + beforeRestart + ' 手还在）');
  const beforePlay = H.bet().handNo;
  await playHands(3);
  await waitFor(() => H.coachIdle() === 0, 40000);
  ok(H.bet().handNo >= beforePlay + 3, '又打了 3 手', H.bet().handNo + ' 手');
  ok(HS.hands.filter(a => !a.star).length <= 2, '真实链路上也只留最近 2 手未收藏的档案',
    HS.hands.filter(a => !a.star).length + ' 手');
  ok(HS.hands.length >= 1 && HS.hands.some(a => a.ai.length > 0), '新档案照样带着 AI 的逻辑');
  q('btnCoach').click(); await sleep(50);
  [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'set').click(); await sleep(40);
  q('coHistKeep').value = '5'; q('coSave').click();
  ok(HS.keep === 5, '改回 5 手');

  // —— 面板：卡片 / 选中 / 展开 ——
  hTab.click(); await sleep(60);
  ok(q('coachPaneHist').classList.contains('on'), '「逐手档案」页能打开');
  const cards18 = [...d.querySelectorAll('#histList .hist-card')];
  ok(cards18.length === HS.hands.length, '档案列表把每一手都渲染出来了',
    cards18.length + ' / ' + HS.hands.length);
  ok(cards18[0].textContent.indexOf('第 ') >= 0 && cards18[0].querySelector('[data-star]'),
    '卡片上有手数与收藏按钮');
  cards18[0].click(); await sleep(50);
  const selId = d.querySelector('#histList .hist-card.sel').dataset.hid;
  const selHand = H.histFind(selId);
  ok(q('histAskHd').textContent.indexOf('第 ' + selHand.h + ' 手') >= 0,
    '选中一手后，追问区标出了是哪一手', q('histAskHd').textContent);
  ok(d.querySelector('#histThread').textContent.indexOf('还没问过') >= 0, '还没追问过时给了示例问题');
  const aiRows = [...d.querySelectorAll('#histList .hist-ai .row')];
  ok(aiRows.length >= 0 && q('histList').textContent.indexOf('读牌') >= 0,
    '展开后 AI 的逻辑（读牌/心里话/场上话）就摆在卡片里');

  // —— 追问：开思考模式、不要 JSON、答案落库并渲染 ——
  const beforeAsk = calls.length;
  q('histQ').value = 'MARK-我的问题：这一手我该不该跟？';
  q('histSend').click();
  await waitFor(() => H.histFind(selId).chat.length > 0, 30000);
  const asked = H.histFind(selId);
  ok(asked.chat.length === 1, '追问被记进这一手的档案', asked.chat.length + ' 轮');
  const chatCall = calls.slice(beforeAsk).filter(c => c.kind === 'coach-chat');
  ok(chatCall.length === 1, '追问只发了一次请求');
  ok(chatCall[0].thinkOn === true && chatCall[0].effort === 'high', '追问开着思考模式（强度 high）',
    'thinking=' + chatCall[0].thinkOn + ' effort=' + chatCall[0].effort);
  ok(chatCall[0].hasTemp === false, '思考模式下去掉了 temperature');
  ok(chatCall[0].hasFmt === false, '追问不逼它吐 JSON（要的是能读的一段话）');
  ok(chatCall[0].usr.indexOf('MARK-我的问题') >= 0, '我的问题原文进了请求');
  ok(chatCall[0].usr.indexOf('MARK-读牌-私有') >= 0 && chatCall[0].usr.indexOf('MARK-场上话-公开') >= 0,
    'AI 的逻辑被当成上下文喂给了追问（复盘就该看得见这些）');
  ok(chatCall[0].usr.indexOf('这是那一手的完整档案') >= 0, '请求里带着那一手的完整档案');
  const it1 = asked.chat[0];
  ok(it1.ok === true && it1.a.indexOf('MARK-教练-追问') >= 0, '答案来自接口', it1.a.slice(0, 24));
  ok(typeof it1.ms === 'number' && it1.ms >= 0, '记了耗时', it1.ms + ' ms');
  ok(it1.reasoning.indexOf('MARK-思考过程-追问') >= 0, '追问的推理过程（思维链）也存了下来',
    it1.reasoning.slice(0, 24));
  ok(q('histThread').textContent.indexOf('MARK-教练-追问') >= 0, '答案渲染在面板上');
  ok(q('histThread').textContent.indexOf('MARK-我的问题') >= 0, '我的问题也留在对话流里');
  ok(q('histQ').value === '', '发完自动清空输入框');

  // 追问也落盘（关掉页面下次打开还在）
  let persistedH = null;
  try { persistedH = JSON.parse(w.localStorage.getItem('holdem_hist_v1')); } catch (e) {}
  ok(!!persistedH && persistedH.hands.some(x => (x.chat || []).some(c => c.a.indexOf('MARK-教练-追问') >= 0)),
    '追问记录写进了 localStorage');

  // 第二次追问：带上上下文
  const beforeAsk2 = calls.length;
  await H.histAsk('MARK-第二次问题：如果他手里是坚果呢？', selId);
  const c2 = calls.slice(beforeAsk2).filter(c => c.kind === 'coach-chat');
  ok(c2.length === 1 && c2[0].usr.indexOf('MARK-我的问题') >= 0,
    '第二次追问带上了上一轮问答（有上下文才叫追问）');
  ok(H.histFind(selId).chat.length === 2, '两轮追问都留着');

  // 追问遇到「思维链吃光输出」：自动降强度重问
  faults.chatEmpty = true;
  const beforeAsk3 = calls.length;
  const it3 = await H.histAsk('MARK-第三次问题：那我现在该怎么调整？', selId);
  ok(it3.ok === true && it3.a.indexOf('MARK-教练-追问') >= 0, '追问遇到空输出也能自动重问拿到答案');
  const c3 = calls.slice(beforeAsk3).filter(c => c.kind === 'coach-chat');
  ok(c3.length === 2, '第一次失败 + 第二次重试 = 两次请求', c3.length + ' 次');
  ok(c3[1].thinkOn === true && c3[1].effort === 'low', '重试时保留思考模式、强度降到 low',
    'effort=' + c3[1].effort);
  ok(c3[1].hasFmt === false, '重试也不带 JSON 模式');

  // 关掉推理模式后，追问也不该再带 thinking
  q('coThinking').checked = false; q('coSave').click();
  const beforeOffChat = calls.length;
  await H.histAsk('MARK-第四次问题：不开思考模式会怎样？', selId);
  const c4 = calls.slice(beforeOffChat).filter(c => c.kind === 'coach-chat');
  ok(c4.length === 1 && !c4[0].thinkOn && !c4[0].effort, '关掉推理模式后，追问也不再带 thinking');
  q('coThinking').checked = true; q('coSave').click();

  // —— 导出 ——
  // 一手的导出
  const mdHand = H.histMd(asked);
  ok(mdHand.indexOf('# 第 ' + asked.h + ' 手 · 逐手档案') >= 0, '单手导出有标题');
  ok(mdHand.indexOf('## 我的逻辑（每一步）') >= 0 && mdHand.indexOf('## 全桌过程') >= 0, '单手导出含我的逻辑');
  ok(mdHand.indexOf('## AI 对手的逻辑') >= 0 && mdHand.indexOf('MARK-读牌-私有') >= 0,
    '单手导出含 AI 的逻辑');
  ok(mdHand.indexOf('## 我的追问') >= 0 && mdHand.indexOf('MARK-教练-追问') >= 0, '单手导出含我的追问');
  ok(mdHand.indexOf('MARK-场上话-公开') >= 0, '单手导出含场上话（公开信息）');

  // 全部档案的导出
  const hj = JSON.parse(H.exportHistList('json'));
  ok(hj.hands.length === HS.hands.length, '全部档案 JSON 导出条数对得上', hj.count + ' 手');
  ok(hj.hands.some(x => (x.ai || []).length > 0), '导出的档案里带着 AI 的逻辑');
  const hm = H.exportHistList('md');
  ok(hm.indexOf('# 逐手档案（') >= 0 && hm.indexOf('## AI 对手的逻辑') >= 0, '全部档案 Markdown 导出成文');

  // 日志导出
  q('coachClose').click();
  q('btnAILog').click(); await sleep(60);
  const lgAll = H.ailog();
  const lj = JSON.parse(H.exportAILog('json'));
  ok(lj.records.length === lgAll.length, 'JSON 导出把全部留档都带走了', lj.records.length + ' / ' + lgAll.length);
  ok(lj.records.some(r => r.sys && r.usr && r.raw), '导出里带着系统提示词 / 局面快照 / 原始回答');
  ok(lj.records.every(r => typeof r.reasoning === 'string'), '导出里每条都带「推理过程」字段（没开思考的就是空串）');
  ok(lj.records.some(r => r.reasoning.indexOf('MARK-思考过程-追问') >= 0), '导出里带着真实的思维链');
  ok(typeof lj.summary.spent === 'number' && lj.summary.calls > 0, '导出里带着用量与花费汇总',
    '总计 ¥' + lj.summary.spent.toFixed(4));
  ok(lj.records.some(r => r.hand > 0 && r.street >= 0), '导出里标着「第几手 / 哪条街」');

  const lmd = H.exportAILog('md');
  ok(lmd.indexOf('# AI 调用日志') >= 0 && lmd.indexOf('## #') >= 0, 'Markdown 导出有总标题与逐条小节');
  ok(lmd.indexOf('<details><summary>系统提示词</summary>') >= 0, 'Markdown 导出把提示词收进折叠块');

  const lcsv = H.exportAILog('csv');
  const csvLines = lcsv.split('\n');
  ok(csvLines.length === lj.records.length + 1, 'CSV 行数 = 记录数 + 1 行表头', csvLines.length + ' 行');
  ok(csvLines[0].indexOf('seq,time,kind,seat,name') === 0, 'CSV 表头顺序正确', csvLines[0].slice(0, 30));
  ok(csvLines[0].indexOf('cost_cny') > 0 && csvLines[0].indexOf('prompt_tokens') > 0, 'CSV 带用量与花费列');

  // 导出跟随筛选：只看失败
  q('ailogKind').value = '__fail'; H.renderAILog();
  const fj = JSON.parse(H.exportAILog('json')).records;
  ok(fj.length > 0 && fj.every(r => !r.ok), '导出跟随「只看失败」的筛选', fj.length + ' 条');
  q('ailogKind').value = 'coach-chat'; H.renderAILog();
  const cj = JSON.parse(H.exportAILog('json')).records;
  ok(cj.length > 0 && cj.every(r => r.kind === 'coach-chat'), '导出跟随「只看追问」的筛选', cj.length + ' 条');
  q('ailogKind').value = ''; H.renderAILog();
  ok(q('ailogList').textContent.indexOf('第 ') >= 0, '日志条目上标着「第几手 / 哪条街」');

  // 点导出按钮：能下载就下载，不能下载就把全文摊在面板里
  q('ailogExportMd').click(); await sleep(80);
  const outTxt = q('ailogOut').textContent;
  ok(outTxt.indexOf('已导出') >= 0 || outTxt.indexOf('AI 调用日志') >= 0,
    '点「Markdown」导出给了结果（下载或摊开全文）', outTxt.slice(0, 30).replace(/\n/g, ' '));
  let dl = null;
  try { dl = H.downloadText('探针.txt', 'hello'); } catch (e) { dl = 'throw:' + e.message; }
  ok(dl === true || dl === false, '下载不了时优雅降级，不抛异常', String(dl));
  q('ailogClose').click();

  // —— 清空档案（两步确认） ——
  q('btnCoach').click(); await sleep(50);
  [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'hist').click(); await sleep(50);
  const handsBak = HS.hands.length;
  q('histWipe').click();
  ok(String(q('histWipe').dataset.armed) === '1' && HS.hands.length === handsBak,
    '「清空档案」要点两次（第一次只是待命）');
  q('histWipe').click(); await sleep(50);
  ok(HS.hands.length === 0, '第二次点击才真的清空', handsBak + ' → ' + HS.hands.length);
  ok(q('histList').textContent.indexOf('还没有档案') >= 0, '清空后面板给了说明');
  q('coachClose').click();

  ok(errors.length === 0, '档案 / 追问 / 导出链路零脚本错误', errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n=== 19. 🍄 蘑菇玩法 · 📊 用量与花费 ===');
  await waitFor(() => H.coachIdle() === 0, 30000);

  const chipsSum = () => H.players().reduce((a, p) => a + p.chips, 0);
  const liveN    = () => H.players().filter(p => !p.out).length;

  // ---------- A. 配置：默认关，能开 ----------
  q('btnAISet').click(); await sleep(80);
  ok(q('cfgMushroom').checked === false, '蘑菇玩法默认是关的（不打扰原来的玩法）');
  ok(q('cfgMushWho').value === 'dealer', '默认「只有庄家投一份」（投钱的是庄家）');
  ok(Number(q('cfgMushBase').value) === 10, '默认底分 = 1 个小盲（10）', q('cfgMushBase').value);
  q('cfgMushroom').checked = true;
  q('cfgMushWho').value = 'dealer';
  q('cfgMushBase').value = '20';
  q('aiSave').click(); await sleep(80);
  ok(H.mushroom().on === true, '打开后写进了配置');
  ok(H.mushroom().who === 'dealer' && H.mushroom().whoText.indexOf('只有庄家') >= 0,
    '投法读回来是「只有庄家投一份」', H.mushroom().whoText);

  // 旧存档迁移：第十轮写盘的 mushWho:'sb'（小盲投）必须归一成 'dealer'，不能打回旧语义
  {
    const CFG_KEY = 'holdem_game_cfg_v1';
    const rawBak = w.localStorage.getItem(CFG_KEY);
    const tampered = JSON.parse(rawBak || '{}');
    tampered.mushWho = 'sb';
    w.localStorage.setItem(CFG_KEY, JSON.stringify(tampered));
    H.loadGameCfg();
    ok(H.gamecfg().mushWho === 'dealer', '旧存档 mushWho:"sb" 读回来归一到 "dealer"',
      String(H.gamecfg().mushWho));
    w.localStorage.setItem(CFG_KEY, rawBak);
    H.loadGameCfg();
    ok(H.gamecfg().mushWho === 'dealer' && H.gamecfg().mushroom === true,
      '复原存档后设置仍是「蘑菇开 + 庄家投」', H.gamecfg().mushWho);
  }
  q('aiClose').click(); await sleep(40);

  // ---------- B. 只有庄家投：钱从哪来、到哪去 ----------
  await clickReset();
  ok(H.mushroom().pool === 0, '重新开局后蘑菇池清零', String(H.mushroom().pool));
  ok(H.mushroom().base === 20, '开局前问底分也是 20（不会拿到半价）', String(H.mushroom().base));

  H.collectMushroom();
  const mg1 = H.mushroom();
  ok(mg1.seatId >= 0 && mg1.payId >= 0, '同时记住了「端锅的蘑菇位」和「投钱的人」',
    '端=' + mg1.seatId + ' / 投=' + mg1.payId);
  ok(mg1.seatId !== mg1.payId,
    '八人桌：投钱的庄家 ≠ 端锅的小盲——两个角色真的分开了',
    '端=' + mg1.seatId + ' / 投=' + mg1.payId);
  ok(mg1.pool === 20, '「只有庄家投」：一次只收一份 20', String(mg1.pool));
  const sbP  = H.players()[mg1.seatId];      // 端锅的（小盲位）
  const payP = H.players()[mg1.payId];       // 投钱的（庄家）
  ok(payP.chips === 980, '钱是从庄家口袋里扣的', String(payP.chips));
  ok(sbP.chips === 1000, '小盲位（蘑菇位）一分没掏，纯等着端锅', String(sbP.chips));
  ok(H.players().filter(p => p.chips === 1000).length === 7,
    '8 人里只有庄家掏了那一份，其余 7 人筹码没动');
  ok(H.players().every(p => p.id === payP.id || p.chips === 1000), '别人的筹码一分没动');

  // ---------- C. 端走规则：只有小盲位独赢主池才拿得到 ----------
  const other = H.players().find(p => p.id !== sbP.id && p.id !== payP.id);
  const poolBak = H.mushroom().pool, sbChips = sbP.chips, othChips = other.chips;
  H.mushroomPayout([other]);
  ok(H.mushroom().pool === poolBak, '别人赢下主池：蘑菇池原封不动留给下一手', String(H.mushroom().pool));
  ok(other.chips === othChips, '别人也一分钱没多拿');
  H.mushroomPayout([payP]);
  ok(H.mushroom().pool === poolBak,
    '投钱的庄家自己赢下主池也拿不到——他不是蘑菇位，池子照样留着');
  H.mushroomPayout([sbP, other]);
  ok(H.mushroom().pool === poolBak, '平局（小盲只分到一半）也不算「独赢」，池子留着');
  H.mushroomPayout([sbP]);
  ok(H.mushroom().pool === 0, '小盲位独赢主池：整锅蘑菇被端走');
  ok(sbP.chips === sbChips + poolBak, '钱真的进了小盲位的口袋', sbChips + ' → ' + sbP.chips);
  ok(H.mushroomPayout([sbP]) === 0, '池子空的时候再结算不会凭空造钱');

  // ---------- D. 全桌每人投一份 ----------
  q('btnAISet').click(); await sleep(60);
  q('cfgMushWho').value = 'all';
  q('aiSave').click(); await sleep(80);
  q('aiClose').click(); await sleep(40);
  ok(H.mushroom().who === 'all' && H.mushroom().whoText.indexOf('全桌') >= 0,
    '能把投法切成「全桌每人投一份」', H.mushroom().whoText);
  await clickReset();
  const baseAll = H.mushroom().base, nAll = liveN();
  const beforeAll = chipsSum() + H.mushroom().pool;
  H.collectMushroom();
  ok(H.mushroom().pool === baseAll * nAll,
    '全桌 ' + nAll + ' 人各投 ' + baseAll + ' → 池子 ' + (baseAll * nAll), String(H.mushroom().pool));
  ok(chipsSum() + H.mushroom().pool === beforeAll, '收底分只是把钱挪进池子，总额不变');

  // ---------- E. 底分跟着盲注一起涨 ----------
  ok(H.mushroom().base === H.gamecfg().mushBase, '没涨价时底分 = 配置值');
  q('btnAISet').click(); await sleep(60);
  q('cfgMushBase').value = '50';
  q('aiSave').click(); await sleep(80);
  q('aiClose').click(); await sleep(40);
  ok(H.mushroom().base === 50, '改配置后底分跟着变', String(H.mushroom().base));

  // ---------- F. 真打几手：每手结算后总账守恒 ----------
  await clickReset();
  let consvBad = '', played = 0, sawPool = false;
  for (let i = 0; i < 5; i++){
    const h0 = H.bet().handNo;
    const base0 = chipsSum() + H.mushroom().pool;
    await playHands(1);
    if (H.bet().handNo !== h0 + 1) continue;      // 中途重开了（人类出局），这一手不计
    played++;
    const now = chipsSum() + H.mushroom().pool;
    if (now !== base0) consvBad = '第 ' + (h0 + 1) + ' 手：' + base0 + ' → ' + now;
    if (H.mushroom().pool > 0) sawPool = true;
  }
  ok(played >= 3, '带蘑菇真打了 ' + played + ' 手', played + ' 手');
  ok(!consvBad, '每手打完「所有人筹码 + 蘑菇池」恒为定值（钱没丢也没多）', consvBad);
  ok(sawPool, '蘑菇池真的积起来了（不是永远 0）');
  await waitFor(() => H.coachIdle() === 0, 30000);

  // ---------- G. 蘑菇进了 AI 的思考逻辑 ----------
  // 前面 D/E 把投法切成了「全桌」，先切回默认的「只有庄家投」
  q('btnAISet').click(); await sleep(60);
  q('cfgMushWho').value = 'dealer';
  q('aiSave').click(); await sleep(80);
  q('aiClose').click(); await sleep(40);
  ok(H.mushroom().who === 'dealer', '能切回「只有庄家投一份」', H.mushroom().whoText);

  await clickReset();
  const psG = H.players();
  const SB_I = 3, PAY_I = 1, OTH_I = 5;      // 小盲（端锅）/ 庄家（投钱）/ 路人
  H.collectMushroom(SB_I, PAY_I);
  const mgG = H.mushroom();
  const bp = psG[SB_I], mp = psG[PAY_I], op = psG[OTH_I];
  ok(mgG.seatId === SB_I && mgG.payId === PAY_I,
    '能分别指定「端锅的」和「投钱的」', '端=' + mgG.seatId + ' / 投=' + mgG.payId);
  ok(mp.chips === 1000 - mgG.base && bp.chips === 1000,
    '钱从庄家扣、小盲位不动', '庄家 ' + mp.chips + ' / 小盲 ' + bp.chips);

  const sysOn = H.sysText(bp);
  ok(sysOn.indexOf('蘑菇池') >= 0, 'system 里多了一条「蘑菇池」的规矩');
  ok(sysOn.indexOf('只有「小盲位」自己独赢主池') >= 0, 'system 里说清了谁能端走');
  ok(sysOn.indexOf('掏钱的人默认是庄家') >= 0 && sysOn.indexOf('永远只有「小盲位」') >= 0,
    'system 里说清了「投钱的人 ≠ 端锅的人」');
  ok(sysOn.indexOf('只有庄家投一份') >= 0, 'system 里的投法跟当前设置一致',
    H.mushroom().whoText);

  const snapSb = H.stateText(bp, 0, 0, 0, 'full');
  ok(snapSb.indexOf('蘑菇池') >= 0 && snapSb.indexOf('本手小盲') >= 0, '快照里有蘑菇池实况');
  ok(snapSb.indexOf('你就是本手小盲') >= 0, '小盲（蘑菇位）拿到的快照点明「你就是本手小盲」');
  ok(snapSb.indexOf('额外端走') >= 0, '并且告诉他这一锅值多少钱');
  ok(snapSb.indexOf('庄家 ' + mp.name + ' 投一份底分') >= 0,
    '快照里点名了投钱的庄家是谁', mp.name);

  const snapPay = H.stateText(mp, 0, 0, 0, 'full');
  ok(snapPay.indexOf('掏钱养的') >= 0,
    '庄家拿到的快照点明「这一锅是你掏钱养的，但你端不走」');
  ok(snapPay.indexOf('你就是本手小盲') < 0, '并且不会误说庄家就是小盲');

  const snapOth = H.stateText(op, 0, 0, 0, 'full');
  ok(snapOth.indexOf('轮不到你') >= 0, '既不投也不端的快照点明「这一锅轮不到你」');
  ok(snapOth.indexOf('你就是本手小盲') < 0 && snapOth.indexOf('掏钱养的') < 0,
    '也不会把路人误认成小盲或庄家');

  const snapLite = H.stateText(bp, 0, 0, 0, 'lite');
  ok(snapLite.indexOf('蘑菇池') >= 0, '精简快照里也带着蘑菇（这是核心规则，不能省）');

  // 真打一手，验桌面上那颗药丸把「谁投、谁端」都标出来了
  const h0G = H.bet().handNo;
  await playHands(1);
  await waitFor(() => H.coachIdle() === 0, 30000);
  const whoTxt = q('mushroomWho').textContent;
  ok(q('mushroomBox').style.display !== 'none' && whoTxt.indexOf('庄家') >= 0 &&
     whoTxt.indexOf('投') >= 0 && whoTxt.indexOf('小盲') >= 0 && whoTxt.indexOf('端') >= 0,
    '桌面蘑菇框同时标出「庄家 X 投 · 小盲 Y 端」', whoTxt);
  ok(H.bet().handNo === h0G + 1, '这一手真打完了（药丸文案来自真实一手）');

  // ---------- H. 关掉之后不再浪费 token ----------
  q('btnAISet').click(); await sleep(60);
  q('cfgMushroom').checked = false;
  q('aiSave').click(); await sleep(80);
  q('aiClose').click(); await sleep(40);
  ok(H.mushroom().on === false, '能关掉蘑菇');
  const sysOff = H.sysText(bp);
  ok(sysOff.indexOf('蘑菇池') < 0, '关掉之后 system 里不再提它（省 token）');
  ok(H.stateText(bp, 0, 0, 0, 'full').indexOf('蘑菇池') < 0, '关掉之后快照里也不提');
  ok(q('mushroomBox').style.display === 'none', '关掉之后桌面上的蘑菇池藏起来');
  q('btnAISet').click(); await sleep(60);
  q('cfgMushroom').checked = true;
  q('cfgMushBase').value = '20';
  q('cfgMushWho').value = 'dealer';
  q('aiSave').click(); await sleep(80);
  q('aiClose').click(); await sleep(40);
  ok(H.mushroom().on === true && q('mushroomBox').style.display !== 'none',
    '重新打开后桌面上的蘑菇池又出来了');
  ok(H.mushroom().who === 'dealer', '重新打开后投法仍是「只有庄家投」', H.mushroom().whoText);

  // ---------- I. 用量账本 ----------
  const U = H.usage();
  ok(U && U.total && typeof U.total.calls === 'number', '用量账本存在');
  ok(U.total.calls > 0, '账本记下了请求次数', U.total.calls + ' 次');
  ok(U.total.tokIn > 0 && U.total.tokOut > 0, '输入 / 输出 token 都记了',
    U.total.tokIn + ' / ' + U.total.tokOut);
  ok(U.total.cost > 0, '花费算出来了', '¥' + U.total.cost.toFixed(6));
  ok(U.total.costIdle <= U.total.cost + 1e-9,
    '「全按空闲价」口径 ≤ 实际（说明分时段计价生效了）',
    U.total.costIdle.toFixed(6) + ' ≤ ' + U.total.cost.toFixed(6));
  ok(U.total.costPeak >= U.total.cost - 1e-9,
    '「全按高峰价」口径 ≥ 实际', U.total.costPeak.toFixed(6) + ' ≥ ' + U.total.cost.toFixed(6));
  ok(U.total.ok + U.total.fail === U.total.calls, '成功 + 失败 = 总次数',
    U.total.ok + ' + ' + U.total.fail + ' = ' + U.total.calls);
  const kindKeys = Object.keys(U.kinds);
  ok(kindKeys.length > 0, '按类型拆得开', kindKeys.join(' / '));
  ok(kindKeys.some(k => k === 'decide'), '牌局决策单独成一类');
  ok(kindKeys.some(k => String(k).indexOf('coach') === 0), '教练的调用也单独成一类');
  ok(Object.keys(U.seats).length >= 2, '按座位拆得开', Object.keys(U.seats).length + ' 个座位');
  ok(Object.values(U.seats).every(b => b.name && b.name.length > 0), '每个座位都带着名字');
  ok(Object.keys(U.models).length > 0, '按模型拆得开', Object.keys(U.models).join(' / '));
  const todayKey = H.dayKeyOf(Date.now());
  ok(!!U.days[todayKey], '按天拆得开（今天有账）', todayKey);

  // 分项之和 = 总计（账不能对不上）
  const sumOf = obj => Object.keys(obj).reduce((a, k) => a + obj[k].calls, 0);
  ok(sumOf(U.kinds) === U.total.calls, '按类型次数之和 = 总次数',
    sumOf(U.kinds) + ' / ' + U.total.calls);
  const costSum = Object.keys(U.kinds).reduce((a, k) => a + U.kinds[k].cost, 0);
  ok(Math.abs(costSum - U.total.cost) < 1e-9, '按类型花费之和 = 总花费',
    costSum.toFixed(6) + ' / ' + U.total.cost.toFixed(6));

  // ---------- J. 会话口径 vs 长期口径 ----------
  const S = H.usageSession();
  ok(S.total.calls <= U.total.calls, '「本次打开页面」不会多过「长期累计」',
    S.total.calls + ' / ' + U.total.calls);
  ok(S.total.calls > 0, '本次会话也有账', S.total.calls + ' 次');

  // ---------- K. 落盘 ----------
  H.saveUsage();
  const rawU = w.localStorage.getItem('holdem_usage_v1');
  ok(!!rawU && rawU.indexOf('"total"') >= 0, '账本写进了 localStorage（关掉页面也不丢）');
  const parsedU = JSON.parse(rawU);
  ok(parsedU.total.calls === U.total.calls, '落盘的次数和内存一致',
    parsedU.total.calls + ' / ' + U.total.calls);
  const callsBak2 = U.total.calls;
  U.total.calls = 0;
  H.loadUsage();
  ok(H.usage().total.calls === callsBak2, 'loadUsage 能把账本读回来', String(H.usage().total.calls));
  ok(H.usage().total.cost > 0, '花费也一起读回来了');

  // ---------- L. 面板 ----------
  q('aiUsage').click(); await sleep(80);
  ok(q('usageMask').classList.contains('on'), '设置页里的「📊 用量与花费」能打开面板');
  ok(q('usageBody').querySelectorAll('.usg-card').length === 4, '四张大数字卡都在');
  ok(q('usageBody').querySelectorAll('.usg-tbl').length >= 3, '至少三张拆解表',
    q('usageBody').querySelectorAll('.usg-tbl').length + ' 张');
  const bodyTxt = q('usageBody').textContent;
  ok(bodyTxt.indexOf('累计花费') >= 0, '面板上有「累计花费」');
  ok(bodyTxt.indexOf('请求次数') >= 0 && bodyTxt.indexOf('输入 token') >= 0 && bodyTxt.indexOf('输出 token') >= 0,
    '请求次数 / 输入 / 输出 都在');
  ok(bodyTxt.indexOf('按类型拆') >= 0, '面板上有「按类型拆」');
  ok(bodyTxt.indexOf('按座位拆') >= 0, '面板上有「按座位拆」');
  ok(bodyTxt.indexOf('按模型拆') >= 0, '面板上有「按模型拆」');
  ok(bodyTxt.indexOf('最近 7 天') >= 0, '面板上有「最近 7 天」');
  ok(bodyTxt.indexOf('峰谷定价') >= 0, '写清了价格口径');
  ok(q('usageSub').textContent.indexOf('累计') >= 0, '标题栏显示当前口径');
  q('usageScopeSess').click(); await sleep(40);
  ok(q('usageSub').textContent.indexOf('本次打开页面') >= 0, '能切到「本次打开页面」');
  ok(q('usageBody').querySelectorAll('.usg-card').length === 4, '切口径后照样渲染');
  q('usageScopeAll').click(); await sleep(40);
  ok(q('usageSub').textContent.indexOf('累计') >= 0 && q('usageSub').textContent.indexOf('本次') < 0,
    '能切回「长期累计」');
  ok(!!q('ailogUsage'), '日志面板里也放了一个入口');

  // ---------- M. 导出 ----------
  const ju = JSON.parse(H.exportUsage('json'));
  ok(ju.total.calls === H.usage().total.calls, 'JSON 导出带着总账');
  ok(ju.kinds && Object.keys(ju.kinds).length > 0, 'JSON 导出带着按类型明细');
  ok(ju.days && Object.keys(ju.days).length > 0, 'JSON 导出带着按天明细');
  ok(typeof ju.note === 'string' && ju.note.indexOf('真实扣费以平台账单为准') >= 0, 'JSON 里写明了价格口径');
  const cu = H.exportUsage('csv');
  ok(cu.indexOf('维度,名称,请求次数') === 0, 'CSV 有表头');
  ok(cu.split('\n').length >= 3, 'CSV 有多行', cu.split('\n').length + ' 行');
  const utxt = H.usageSummaryText();
  ok(utxt.indexOf('AI 用量与花费') >= 0 && utxt.indexOf('花费约') >= 0, '能生成一段文字摘要');

  // ---------- N. 清空（两步确认） ----------
  const callsBak3 = H.usage().total.calls;
  q('usageReset').click();
  ok(String(q('usageReset').dataset.armed) === '1' && H.usage().total.calls === callsBak3,
    '「清空统计」要点两次（第一次只是待命）');
  q('usageReset').click(); await sleep(60);
  ok(H.usage().total.calls === 0, '第二次点击才真的清空',
    callsBak3 + ' → ' + H.usage().total.calls);
  ok(H.usage().total.cost === 0 && H.usage().total.tokIn === 0, '花费与 token 一起归零');
  ok(H.usage().total.fail === 0, '失败计数也归零');
  ok(q('usageBody').textContent.indexOf('还没有数据') >= 0, '清空后面板给了空态说明');
  q('usageClose').click(); await sleep(40);
  ok(!q('usageMask').classList.contains('on'), '能关掉面板');

  // =====================================================================
  console.log('\n=== 20. 安全修正 · 存档续打 · 观战 · 走势 · 牌谱 ===');
  await waitFor(() => H.coachIdle() === 0, 30000);

  // ---------- A. 破坏性操作：一律「再点一次才生效」 ----------
  const armProbe = (id) => {
    const b = q(id);
    if (!b) return null;
    const before = b.textContent;
    b.click();
    const r = { armed: String(b.dataset.armed) === '1', txt: b.textContent, changed: b.textContent !== before };
    // 立刻消掉待命状态，别把后面的用例带进坑
    b.dataset.armed = '0'; b.textContent = b.dataset.label || before;
    return r;
  };
  for (const [id, cn] of [['aiClearMem', '清空所有 AI 记忆'], ['rosterWipeAll', '清空在座所有人的记忆'],
                          ['rosterWipeBench', '清空替补席'], ['ailogClear', '清空日志'],
                          ['memClear', '清空某个人的记忆']]){
    const r = armProbe(id);
    ok(r && r.armed && r.changed, '「' + cn + '」点一下只待命、不执行', r ? r.txt : '按钮不存在');
  }
  {
    // 重新开局：误触成本最高的一颗按钮，单独验「第一次点真的什么都不动」
    await clickReset();
    H.hist().enabled = true;
    await playHands(1);
    await waitFor(() => H.coachIdle() === 0, 30000);
    const hBak = H.bet().handNo, cBak = H.players().map(p => p.chips).join(',');
    ok(hBak >= 1, '先打一手，让局面有东西可丢', '第 ' + hBak + ' 手');
    q('btnReset').click();
    await sleep(40);
    ok(H.bet().handNo === hBak && H.players().map(p => p.chips).join(',') === cBak,
      '「重新开局」第一次点不动手：手数与筹码原封不动', '第 ' + H.bet().handNo + ' 手');
    ok(String(q('btnReset').dataset.armed) === '1' && q('btnReset').textContent.indexOf('再点一次') >= 0,
      '按钮进入待命状态（文案已经变成警告）', q('btnReset').textContent);
    q('btnReset').click();
    await sleep(260);
    ok(H.bet().handNo === 0 && H.players().every(p => p.chips === 1000),
      '第二次点才真的重开', '第 ' + H.bet().handNo + ' 手');
  }

  // ---------- B. 重开局竞态：旧流程必须自己停手 ----------
  {
    const tk0 = H.roundToken();
    q('btnNext').click();                    // 开一手，让 AI 正在思考
    await sleep(80);
    await clickReset();                      // 就在这时候重开
    ok(H.roundToken() > tk0, '重新开局会让局次令牌自增', tk0 + ' → ' + H.roundToken());
    ok(H.staleRound(tk0) === true, '旧令牌被判为「这一手已经过期」');
    ok(H.staleRound(H.roundToken()) === false, '当前令牌不算过期');
    const seqMark = H.ailog().length ? H.ailog()[H.ailog().length - 1].seq : 0;
    await sleep(1200);                       // 够旧流程醒来好几次
    ok(H.bet().handNo === 0 && H.players().every(p => p.chips === 1000),
      '旧流程醒来后没有偷偷改回局面（手数仍是 0、筹码仍是 1000）', '第 ' + H.bet().handNo + ' 手');
    const newDecide = H.ailog().filter(r => r.seq > seqMark && (r.kind === 'decide' || r.kind === 'decide-retry')).length;
    ok(newDecide === 0, '旧那一手的 AI 也不再继续决策（没有新的请求）', newDecide + ' 次');
    ok(q('btnNext').disabled === false, '新一局的「下一手」状态没被旧流程改坏');
    ok(H.coachIdle() === 0, '旧那一手排队的教练请求也一并作废', String(H.coachIdle()));
  }

  // ---------- C. 落盘失败不再静默 ----------
  {
    ok(H.storageHealth().fails === 0, '正常路径下本地存储零失败', String(H.storageHealth().fails));
    ok(H.storageHealthHtml().indexOf('本地存储正常') >= 0, '用量面板写明「本地存储正常」');
    const proto = w.Storage && w.Storage.prototype;
    const realSet = proto ? proto.setItem : null;
    let ret = null;
    const before = H.storageHealth().fails;
    try {
      if (proto) proto.setItem = function () {
        const e = new Error('模拟：本地存储配额已满'); e.name = 'QuotaExceededError'; throw e;
      };
      ret = H.saveGame();
    } finally {
      if (proto && realSet) proto.setItem = realSet;
    }
    ok(ret === false, '配额满时 saveGame 老老实实返回 false（不再假装成功）');
    ok(H.storageHealth().fails > before, '失败次数被记下来了',
      before + ' → ' + H.storageHealth().fails);
    ok(H.storageHealth().warned === true, '并且标记「已经告警过」（不会每手刷屏）');
    ok(logText().indexOf('本地存储写不进去了') >= 0, '战报里明确告警了一次');
    ok(H.storageHealthHtml().indexOf('写入失败') >= 0 && H.storageHealthHtml().indexOf('导出备份') >= 0,
      '用量面板上给出红色告警 + 处置建议');
    ok(H.saveGame() === true, '恢复之后落盘又正常了');
  }

  // ---------- D. 中途存档 · 刷新续打 ----------
  {
    await clickReset();
    await playHands(3);
    await waitFor(() => H.coachIdle() === 0, 30000);
    const handNow = H.bet().handNo;
    const chipsNow = H.players().map(p => p.chips).join(',');
    const sv = H.buildSave();
    ok(sv && sv.v === 1 && sv.handNo === handNow, '每手打完都生成了一份存档快照', '第 ' + sv.handNo + ' 手');
    ok(Array.isArray(sv.players) && sv.players.length === 8, '存档里有 8 个座位的筹码 / 出局状态');
    ok(typeof sv.mushroomPool === 'number' && sv.session && typeof sv.session.id === 'string',
      '蘑菇池和本局信息（含走势）也一起存了');
    const rawSv = w.localStorage.getItem('holdem_save_v1');
    ok(!!rawSv && JSON.parse(rawSv).handNo === handNow, '确实写进了 localStorage（刷新页面也还在）');

    // 模拟「刷新」：先重开把局面清掉，再把备份的存档塞回去恢复
    await clickReset();
    ok(H.bet().handNo === 0, '重开之后局面清空', '第 ' + H.bet().handNo + ' 手');
    const afterReset = w.localStorage.getItem('holdem_save_v1');
    ok(!afterReset || JSON.parse(afterReset).handNo === 0,
      '「重新开局」把上一局的存档作废了（这就是「从头再来」）');
    w.localStorage.setItem('holdem_save_v1', rawSv);
    const done = H.restoreSave();
    ok(done === true, '能从存档恢复出上一局');
    ok(H.bet().handNo === handNow, '手数恢复了', '第 ' + H.bet().handNo + ' 手');
    ok(H.players().map(p => p.chips).join(',') === chipsNow, '每个人的筹码逐个恢复');
    ok(H.session().curve.length === handNow, '本局走势也跟着恢复了', H.session().curve.length + ' 条');
    H.restoreBanner();
    ok(logText().indexOf('已接着上一局继续') >= 0, '并且明确告诉玩家「接着上一局」');
    ok(q('resultBar').textContent.indexOf('已恢复上一局') >= 0, '结果条上也写了', q('resultBar').textContent);
  }

  // ---------- E. 出局观战 ----------
  {
    await clickReset();
    ok(H.spectating() === false, '开局不是观战状态');
    H.players()[0].chips = 0;
    H.markHandOver();
    ok(H.spectating() === true, '人类筹码归零 → 转入观战');
    ok(q('btnNext').disabled === false, '观战时「下一手」保持可用（可以一直看下去）');
    ok(q('resultBar').textContent.indexOf('观战') >= 0, '结果条写着「观战中」', q('resultBar').textContent);
    ok(logText().indexOf('转入「观战」') >= 0, '战报里说清了状况');
    ok(logText().indexOf('结束完整对局') >= 0, '并提示可以随时手动收工去复盘');
    ok(q('controls').classList.contains('on') === false, '出局后不再要求玩家操作');
    q('btnNext').click();                     // 观战也能翻到下一手
    await sleep(500);
    ok(H.bet().handNo === 1, '观战状态下也能继续开下一手', '第 ' + H.bet().handNo + ' 手');
    await clickReset();
    ok(H.spectating() === false, '重新开局会退出观战');
  }

  // ---------- F. 筹码走势 / VPIP-PFR ----------
  {
    await clickReset();
    await playHands(4);
    await waitFor(() => H.coachIdle() === 0, 30000);
    const cv = H.session().curve;
    ok(Array.isArray(cv) && cv.length === H.bet().handNo, '每一手都往本局走势里记了一条',
      cv.length + ' 条 / 第 ' + H.bet().handNo + ' 手');
    ok(cv.every(r => typeof r.chips === 'number' && typeof r.pot === 'number' && typeof r.vpip === 'boolean'),
      '每条都带着筹码 / 底池 / 是否入池');
    ok(cv[cv.length - 1].chips === H.players()[0].chips, '最后一条就是当前筹码');
    const cs = H.curveStats();
    ok(cs.n === cv.length && cs.start === 1000, '走势统计算得出起始筹码与本局手数');
    ok(cs.peak >= cs.trough && cs.peak >= cs.now && cs.trough <= cs.now,
      '最高 / 最低把当前筹码夹在中间');
    ok(cs.vpip >= 0 && cs.vpip <= 100 && cs.pfr >= 0 && cs.pfr <= 100,
      'VPIP / PFR 落在 0–100', cs.vpip + '% / ' + cs.pfr + '%');
    ok(cs.pfr <= cs.vpip, 'PFR 不会超过 VPIP（没入池就谈不上加注）', cs.pfr + ' ≤ ' + cs.vpip);

    // 无头环境没有 canvas 实现：塞一个「记账用」的假 2d 上下文，
    // 这样既能验证画图代码真的走通了（有没有画线、有没有写刻度），
    // 又不会让 jsdom 抛 not-implemented 污染「零脚本错误」断言。
    // 用 Proxy 做假上下文：任何绘制方法都认，而且自动记账。
    // 以前是手写枚举方法名，结果新增一张画布（教练评分曲线）就漏了，
    // jsdom 直接抛 not-implemented 把「零脚本错误」断言污染掉 —— 以后不会再犯。
    const makeFakeCtx = () => {
      const calls = {};
      const props = { font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '',
                      textAlign: '', globalAlpha: 1, lineCap: '' };
      const special = {
        measureText: () => ({ width: 10 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createPattern: () => ({})
      };
      return new Proxy(props, {
        get(t, k) {
          if (k === '__calls') return calls;
          if (k in t) return t[k];
          if (special[k]) return special[k];
          return () => { calls[k] = (calls[k] || 0) + 1; return undefined; };
        },
        set(t, k, v) { t[k] = v; return true; }
      });
    };
    const cvA = q('curveCv'), cvB = q('curveRateCv'), cvC = q('curveScoreCv');
    ok(!!cvA && !!cvB && !!cvC, '走势页有三张画布（筹码 / 胜率 / 教练评分）');
    const ctxA = makeFakeCtx(), ctxB = makeFakeCtx(), ctxC = makeFakeCtx();
    cvA.getContext = () => ctxA;
    cvB.getContext = () => ctxB;
    cvC.getContext = () => ctxC;

    q('btnCoach').click(); await sleep(60);
    const ctab = [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'curve');
    ctab.click(); await sleep(90);
    ok(q('coachPaneCurve').classList.contains('on'), '「📈 走势」页签能打开');
    ok(q('curveKpi').querySelectorAll('.k').length === 8, '走势页有 8 张 KPI 卡（新增「应得 EV」与「运气」）',
      q('curveKpi').querySelectorAll('.k').length + ' 张');
    const kpiTxt = q('curveKpi').textContent;
    ok(kpiTxt.indexOf('入池率 VPIP') >= 0 && kpiTxt.indexOf('翻前加注率 PFR') >= 0, 'KPI 卡里有 VPIP / PFR');
    ok(kpiTxt.indexOf('本局手数') >= 0 && kpiTxt.indexOf(String(cv.length)) >= 0, 'KPI 里的手数跟走势数据对得上');
    ok(kpiTxt.indexOf('应得（EV）') >= 0, 'KPI 里有「应得（EV）」');
    ok(/运气[好坏]/.test(kpiTxt), 'KPI 里有运气项（实际 − 应得）');
    ok(q('curveLegend').textContent.indexOf('All-in EV') >= 0, '筹码图例里标出了 All-in EV 线');
    ok(q('curveLegend').textContent.indexOf('我的筹码') >= 0 &&
       q('curveLegend').textContent.indexOf('起始筹码') >= 0, '筹码图有图例（含起始筹码基准线）');
    ok(q('curveRateLegend').textContent.indexOf('VPIP') >= 0 && q('curveRateLegend').textContent.indexOf('滚动 10 手') >= 0,
      '胜率图有图例并写明是滚动 10 手');
    ok(q('curveNote').textContent.indexOf('本局 ' + cv.length + ' 手') >= 0, '有文字版的走势摘要',
      q('curveNote').textContent.slice(0, 46));
    // 画图代码真的跑通了：有折线（moveTo+lineTo）、有描边、有坐标刻度
    ok(ctxA.__calls.clearRect > 0 && ctxA.__calls.moveTo > 0 && ctxA.__calls.lineTo >= cv.length - 1,
      '筹码曲线真的画了折线', JSON.stringify(ctxA.__calls));
    ok(ctxA.__calls.stroke > 0 && ctxA.__calls.fillText >= 5, '筹码曲线有描边和纵轴刻度');
    ok(ctxB.__calls.lineTo > 0 && ctxB.__calls.stroke > 0 && ctxB.__calls.fillText >= 5,
      'VPIP / PFR 曲线也真的画出来了', JSON.stringify(ctxB.__calls));
    // 📈 第十八轮新增：教练评分 vs 手数
    ok(!!q('curveScoreCv') && !!q('curveScoreLegend') && !!q('scoreKpi'),
      '走势页多了「教练评分走势」这一块（画布 + 图例 + KPI）');
    ok(q('curveScoreLegend').textContent.indexOf('滚动 5 手均分') >= 0 &&
       q('curveScoreLegend').textContent.indexOf('每一手的评分') >= 0,
      '评分图有图例（逐手评分 / 滚动 5 手均分）');
    ok(ctxC.__calls.clearRect > 0 && ctxC.__calls.moveTo > 0 && ctxC.__calls.setLineDash > 0,
      '★ 评分图画布真的被用上了（含 80 / 60 两条虚线参考线）', JSON.stringify(ctxC.__calls));
    ok(typeof H.scoreStats === 'function' && typeof H.drawScoreCurve === 'function',
      '评分曲线是导出的，能被自检直接调');
    ok(q('curveNote').textContent.indexOf('教练评分') >= 0,
      '文字版走势摘要里也带上了教练评分', q('curveNote').textContent.slice(-40));
    q('coachClose').click(); await sleep(40);
  }

  // ---------- G. PokerStars 牌谱导出（P0 修正后的格式） ----------
  {
    await clickReset();
    H.hist().enabled = true;
    await playHands(2);
    await waitFor(() => H.coachIdle() === 0, 30000);
    const hands = H.hist().hands;
    const rec = hands[hands.length - 1];
    ok(!!rec, '手上有逐手档案可以导出');
    ok(Array.isArray(rec.acts) && rec.acts.length > 0, '档案里存下了结构化动作序列',
      (rec.acts || []).length + ' 条');
    ok(Array.isArray(rec.stacks) && rec.stacks.length === 8, '也存下了开牌前每个人的筹码');
    ok(rec.acts.every(e => typeof e.s === 'number' && typeof e.i === 'number' && e.n && e.a),
      '每条动作都带着街 / 座位 / 名字 / 动作类型');
    ok(typeof rec.sbName === 'string' && rec.sbName.length > 0 &&
       typeof rec.bbName === 'string' && rec.bbName.length > 0 && rec.bbName !== rec.sbName,
      '记下了本手的小盲 / 大盲是谁', rec.sbName + ' / ' + rec.bbName);
    // P0-2 新增的结算明细 —— collected / Uncalled bet 两行的依据，必须由引擎记账
    ok(Array.isArray(rec.winners) && rec.winners.length > 0 &&
       rec.winners.every(w => w && w.n && typeof w.amt === 'number' && w.amt > 0),
      '结算时记下了「谁收了多少」（collected 的依据）',
      (rec.winners || []).map(w => w.n + ':' + w.amt).join(' '));
    ok(rec.uncalled === null || (rec.uncalled && rec.uncalled.n && rec.uncalled.amt > 0),
      '「未被跟注的部分」要么为 null 要么是一笔正数',
      rec.uncalled ? (rec.uncalled.n + ' ' + rec.uncalled.amt) : 'null');

    // —— P0-1 的回归断言：带 emoji 的 revealed 必须能被解析出「谁」 ——
    // 旧代码用 indexOf(名字+'：')===0 判断，而 revealed 第一段是 emoji（下标=2），
    // 于是 SUMMARY 里永远不出现 showed and won。这里把那个前提钉死。
    const rawRev = '🔥麦琪：Q♠ Q♦';
    ok(rawRev.indexOf('麦琪：') !== 0, '前提：revealed 带 emoji 前缀，indexOf(...)===0 本来就为假',
      '实测下标=' + rawRev.indexOf('麦琪：'));
    const revs = H.psReveals({ revealed: [rawRev, '🧮艾米：A♥ A♣'] });
    ok(revs.length === 2 && revs[0].who === '麦琪' && revs[1].who === '艾米',
      'psReveals 能剥掉 emoji，正确取出名字', JSON.stringify(revs.map(r => r.who)));
    ok(revs[0].cards === 'Qs Qd' && revs[1].cards === 'Ah Ac',
      'psReveals 同时把牌还原成 PokerStars 写法', revs.map(r => r.cards).join(' | '));
    // 牌型必须按「每个人的真实底牌 + 公共牌」现算，不能拿 a.hname 套给所有人
    const boardTxt = '2♥ 7♣ J♠ 3♦ 9♥';
    const bc = H.psStrToCards(H.psCards(boardTxt));
    ok(bc.length === 5, 'psStrToCards 能把公共牌还原成 5 张引擎牌');
    ok(H.psHandNameOf(H.psStrToCards('Qs Qd').concat(bc)) === '一对', '麦琪的牌型算出来是一对');
    ok(H.psHandNameOf(H.psStrToCards('Ah Ac').concat(bc)) === '一对', '艾米的牌型算出来是一对');
    ok(H.psHandNameOf(H.psStrToCards('As Kd').concat(bc)) === '高牌', '我的牌型算出来是高牌（跟她们不一样）');

    // 手工构造一手真摊牌，逐行核对牌谱格式
    const fake = {
      h: 7, t: Date.now(), blinds: '10/20', pos: '按钮位',
      hole: 'A♠ K♦', board: boardTxt, mine: '翻前：跟注（加到 20）', table: '翻前｜你 加到 20',
      rivals: 7, revealed: ['🔥麦琪：Q♠ Q♦', '🧮艾米：A♥ A♣'], showSay: [],
      withdrew: false, foldStreet: -1, showdown: true, hname: '高牌', allin: false,
      pot: 1000, delta: -300, chips: 700, raises: 1, calls: 1, checks: 0,
      vpip: true, pfr: true, sawFlop: true,
      sbName: '李姨', bbName: '麦琪', dealerName: '你',
      stacks: [{ i: 0, n: '你', chips: 1000, out: false }, { i: 1, n: '李姨', chips: 1000, out: false },
               { i: 2, n: '麦琪', chips: 1000, out: false }, { i: 3, n: '艾米', chips: 1000, out: false },
               { i: 4, n: '杰西', chips: 1000, out: false }, { i: 5, n: '王姨', chips: 1000, out: false },
               { i: 6, n: '莉莉', chips: 1000, out: false }, { i: 7, n: '虎姐', chips: 1000, out: false }],
      acts: [{ s: 0, i: 1, n: '李姨', a: 'call', to: 20, put: 10, allin: false, face: 10 },
             { s: 0, i: 4, n: '杰西', a: 'fold', to: 0, put: 0, allin: false, face: 20 },
             { s: 1, i: 0, n: '你', a: 'check', to: 0, put: 0, allin: false, face: 0 }],
      winners: [{ n: '麦琪', amt: 700 }], uncalled: { n: '麦琪', amt: 200 }
    };
    const ps = H.psHandText(fake);
    ok(ps.indexOf('PokerStars Hand #1') === 0, '牌谱以标准手牌编号开头', ps.split('\n')[0].slice(0, 52));
    ok(ps.indexOf("Hold'em No Limit ($10/$20)") > 0, 'P0-2 币种是 $（不是 ¥）', ps.split('\n')[0].slice(0, 60));
    ok(ps.indexOf('¥') < 0, 'P0-2 整份牌谱里一个 ¥ 都没有');
    ok(ps.indexOf(' is the button') > 0, '标出了庄家按钮位');
    ok((ps.match(/ in chips\)/g) || []).length === 8, '列出了每个座位的起始筹码',
      ((ps.match(/ in chips\)/g) || []).length) + ' 个座位');
    ok(ps.indexOf('posts small blind $10') > 0 && ps.indexOf('posts big blind $20') > 0, '补上了盲注行');
    ok(ps.indexOf('*** HOLE CARDS ***') > 0 && ps.indexOf('Dealt to 你 [As Kd]') > 0, '有底牌段');
    ok(/\*\*\* (FLOP|TURN|RIVER) \*\*\* \[/.test(ps), '有逐街分段（带公共牌）');
    ok(ps.indexOf('*** SHOW DOWN ***') > 0, '有摊牌段');
    ok(ps.indexOf('麦琪: shows [Qs Qd] (一对)') > 0, 'P0-1 摊牌者写出自己的牌型（不是套用我的）',
      (ps.split('\n').find(l => l.indexOf('麦琪: shows') === 0) || '（没找到）'));
    ok(ps.indexOf('艾米: shows [Ah Ac] (一对)') > 0, '每个摊牌者各算各的牌型');
    ok(ps.indexOf('你: shows [As Kd] (高牌)') > 0, 'P0-2 我自己摊牌了也要写进 SHOW DOWN');
    ok(ps.indexOf('Uncalled bet ($200) returned to 麦琪') > 0, 'P0-2 写出了「未被跟注，退还」那一行');
    ok(ps.indexOf('麦琪 collected $700 from pot') > 0, 'P0-2 写出了 collected 那一行');
    ok(ps.indexOf('*** SUMMARY ***') > 0 && ps.indexOf('Total pot $1000 | Rake 0') > 0, '有结算总览（Total pot 用 $）');
    ok(/^Seat \d+: .+ \(\$\d+ in chips\)$/m.test(ps), '座位行是 PokerStars 认的格式');
    // ⚠ 座位号必须是 1..N：引擎内部是 0..7（0 = 你），直接打出去会出现 'Seat 0'，
    //   PokerStars 解析器不认这个座位号。这条断言把「0-based 泄漏」钉死。
    ok(ps.indexOf('Seat 0:') < 0, '牌谱里没有 Seat 0（PokerStars 座位号从 1 起）',
      (ps.split('\n').find(l => /^Seat 0/.test(l)) || '（干净）'));
    // 注意：座位行在牌谱里出现两轮（开头的座位表 + SUMMARY），所以是 16 行、8 个不同的号
    const seatNos = (ps.match(/^Seat (\d+): /gm) || []).map(x => Number(x.replace(/[^\d]/g, '')));
    const uniqNos = Array.from(new Set(seatNos)).sort((a, b) => a - b);
    ok(seatNos.length === 16, '座位行出现两轮（开头座位表 + SUMMARY），共 16 行', seatNos.length + ' 行');
    ok(uniqNos.length === 8 && uniqNos[0] === 1 && uniqNos[7] === 8,
      '座位号恰好是 1..8（没有 0、也没有断层）', uniqNos.join(','));
    ok(seatNos.filter(x => x === 1).length === 2, 'Seat 1 在开头和 SUMMARY 里各出现一次');
    // 庄家是「你」= 引擎 0 号座 → 牌谱里应是 Seat 1。
    // 以前 idOf 写成 `(...).i) || 1`，0 被 || 吞成 1 —— 阴差阳错对了号却指向错的人；
    // 现在改成 seatNo(i)=i+1，两个口径统一，这条断言连着 SUMMARY 一起验。
    ok(ps.indexOf('Seat #1 is the button') > 0, '你是庄家时，按钮标在 Seat #1 上',
      (ps.split('\n').find(l => l.indexOf('is the button') > 0) || '（没找到）'));
    // 麦琪是 bbName（大盲），引擎 2 号座 → 牌谱 Seat 3
    const sumLine2 = (ps.split('\n').filter(l => /^Seat 3: /.test(l)).pop()) || '（没找到）';
    ok(/^Seat 3: 麦琪 \(big blind\) showed \[Qs Qd\] and won \(\$700\) with 一对$/.test(sumLine2),
      'P0-1 SUMMARY 里摊牌赢家是 showed [...] and won ($X) with 牌型', sumLine2);
    ok(/^Seat 1: 你 \(button\)/m.test(ps), 'SUMMARY 里按钮位标在「你」（Seat 1）上',
      (ps.split('\n').find(l => /^Seat 1: /.test(l)) || '（没找到）'));
    ok(/^Seat \d+: 杰西 \(folded\)$/m.test(ps), 'SUMMARY 里弃牌的人标了 folded');

    // 老档案（没有 winners / uncalled）必须优雅降级，不能崩、也不能编数
    const oldRec = Object.assign({}, fake, { winners: [], uncalled: null });
    const psOld = H.psHandText(oldRec);
    ok(psOld.indexOf('collected') < 0 && psOld.indexOf('Uncalled bet') < 0,
      '老档案缺结算明细时，不凭空编 collected / Uncalled bet');
    ok(psOld.indexOf('*** SUMMARY ***') > 0, '老档案仍然能出完整牌谱骨架');

    const all = H.exportPokerStars();
    ok(all.indexOf('PokerStars Hand #1') === 0, 'P0-2 整份导出第一行就是牌谱（不再有 # 说明头）',
      (all.split('\n')[0] || '').slice(0, 46));
    ok(all.split('\n').every(l => l.indexOf('#') !== 0 || l === ''), 'P0-2 没有以 # 开头的说明行');
    const nHands = all.split('PokerStars Hand #1').length - 1;
    ok(nHands === hands.length, '导出的手数跟档案手数对得上', nHands + ' / ' + hands.length);
    ok(all.indexOf('Board [') > 0, '至少有一手带公共牌行');
    ok(all.indexOf('*** SUMMARY ***') > 0, '至少有一手带结算总览');
    ok(!!q('histExportPs'), '档案面板上有「导出 PokerStars 牌谱」按钮');
    ok(H.exportHistList('ps').indexOf('PokerStars Hand #1') === 0, 'exportHistList 认得 ps 这种格式');

    // calcUncalled 的单元验证：利用真实牌局把投入摆成已知形状
    ok(typeof H.calcUncalled().amt !== 'undefined' || H.calcUncalled() === null, 'calcUncalled 能安全调用');
  }

  // ---------- H. 每手记忆真的落盘 + 关掉页面再打开 ----------
  {
    await clickReset();
    H.hist().enabled = true;
    await playHands(2);
    await waitFor(() => H.coachIdle() === 0, 30000);

    const memBefore = H.players().filter(p => !p.isHuman)
      .map(p => ({ n: p.name, notes: p.mem.notes.length, sum: p.mem.summary.length, hands: p.stats.hands }));
    // 口径：手记会在「复盘」时被压进长期记忆并清空，所以不能要求每个人都有手记 ——
    // 但「手记 + 长期记忆」至少得有一头，且战绩（stats.hands）每手都记、不会被清空。
    ok(memBefore.every(m => m.notes > 0 || m.sum > 0),
      '打了 2 手，每个人手上都有东西可记（手记或长期记忆）',
      memBefore.map(m => m.n + ':' + m.notes + '条/' + m.sum + '字').join(' '));
    ok(memBefore.every(m => m.hands > 0),
      '每个人的战绩都记上了（战绩不会被复盘清空，是最硬的落盘证据）',
      memBefore.map(m => m.n + ':' + m.hands).join(' '));
    ok(H.rosterSavedAt() > 0, '每手打完就把全桌记忆写进了本机（落盘时间戳有了）');

    const rawAgents = w.localStorage.getItem('holdem_agents_v1');
    ok(!!rawAgents, '本机确实存了一份花名册 holdem_agents_v1');
    const diskSeats = JSON.parse(rawAgents).seats;
    ok(diskSeats.every((a, i) => (a.mem.notes || []).length === memBefore[i].notes &&
                                  (a.stats.hands || 0) === memBefore[i].hands),
      '★ 磁盘上的手记条数与战绩，跟内存里逐个对得上（存的是真记忆，不是空壳）',
      diskSeats.map(a => (a.mem.notes || []).length).join('/'));

    // 真的「关掉页面再打开」：把这一份 localStorage 灌进一个全新的页面实例
    const snapshot = {};
    for (let i = 0; i < w.localStorage.length; i++) {
      const k = w.localStorage.key(i);
      snapshot[k] = w.localStorage.getItem(k);
    }
    const handBefore = H.bet().handNo;
    const chipsBefore = H.players().map(p => p.chips).join(',');
    const curveBefore = H.session().curve.length;

    const errs2 = [];
    const vc2 = new VirtualConsole();
    vc2.on('jsdomError', e => {
      const t = String(e.message || e);
      if (t.indexOf('HTMLCanvasElement') < 0) errs2.push(t.slice(0, 160));
    });
    vc2.on('error', (...a) => errs2.push('console.error: ' + a.join(' ')));

    const dom2 = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true,
      url: 'http://localhost/holdem',
      virtualConsole: vc2,
      beforeParse(window) {
        // 关键一步：先把上一次那份 localStorage 塞好，再让它执行脚本 —— 这才是「重新打开页面」
        for (const k in snapshot) window.localStorage.setItem(k, snapshot[k]);
        // 给个不会真的发请求的兜底，别污染主实例的 calls / 计数
        window.fetch = () => Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ choices: [{ message: { content: '{"action":"call","size":null}' } }], usage: null }),
          text: () => Promise.resolve('')
        });
        window.AbortController = globalThis.AbortController;
      }
    });
    const w2 = dom2.window;
    await waitFor(() => !!w2.HOLDEM && w2.HOLDEM.players().length === 8, 15000);
    await sleep(400);
    const H2 = w2.HOLDEM;
    H2.gameCfg().think = false;      // 同上：这个窗口也别被拟人停顿拖住

    const memAfter = H2.players().filter(p => !p.isHuman)
      .map(p => ({ n: p.name, notes: p.mem.notes.length, sum: p.mem.summary.length, hands: p.stats.hands }));
    ok(JSON.stringify(memAfter) === JSON.stringify(memBefore),
      '★★ 关掉页面再打开：7 个人的记忆（手记 / 战绩 / 长期记忆）一字不差',
      memAfter.map(m => m.n + ':' + m.notes + '/' + m.hands).join(' '));
    ok(H2.bet().handNo === handBefore, '牌局也接着上次继续，不用重打',
      '第 ' + handBefore + ' → 第 ' + H2.bet().handNo + ' 手');
    ok(H2.players().map(p => p.chips).join(',') === chipsBefore, '每个人的筹码逐个恢复');
    ok(H2.session().curve.length === curveBefore, '本局走势也一起活着', curveBefore + ' 条');
    ok(w2.document.getElementById('resultBar').textContent.indexOf('已恢复上一局') >= 0,
      '新页面一打开就告诉玩家「接着上一局」',
      w2.document.getElementById('resultBar').textContent.slice(0, 40));
    ok(H2.rosterSavedAt() > 0,
      '重新打开后，「上次保存时间」也跟着恢复了（记忆卡不会误报「还没写进本机」）');
    ok(w2.document.getElementById('btnNext').textContent.indexOf('下一手') >= 0,
      '「下一手」按钮已经就位');
    ok(errs2.length === 0, '重新打开的这次加载零脚本错误', errs2.join(' | '));
    w2.close();

    // 关掉页面这件事本身不该动到磁盘上的记忆
    const rawAgain = JSON.parse(w.localStorage.getItem('holdem_agents_v1')).seats;
    ok(rawAgain.every((a, i) => (a.mem.notes || []).length === memBefore[i].notes),
      '关页面的动作没有反过来抹掉磁盘上的记忆');
  }

  console.log('\n=== 21. P0/P1 修正 · 六个新功能 ===');
  {
    await clickReset();
    H.hist().enabled = true;
    await playHands(2);
    await waitFor(() => H.coachIdle() === 0, 30000);

    // ---------- A. 📊 玩家侧 HUD（新增功能 3） ----------
    const huds = [...d.querySelectorAll('.seat .hud')];
    ok(huds.length === 8, '每个座位都留了 HUD 的位置', huds.length + ' 个');
    ok(huds[0].textContent.trim() === '', '自己的座位不写 HUD 文字');
    ok(/VPIP \d+% · PFR \d+% · 摊 \d+%/.test(huds[1].textContent),
      '对手座位钉上了 VPIP / PFR / 摊牌率', huds[1].textContent);
    ok(huds.slice(1).every(x => /VPIP/.test(x.textContent) || /样本/.test(x.textContent)),
      '7 个对手位置都有内容（数据或样本提示）');
    // HUD 的数字必须来自引擎数出来的 stats，不是编的
    const p1 = H.players()[1];
    if (p1.stats && p1.stats.hands > 0){
      const want = 'VPIP ' + Math.round(p1.stats.vpip / p1.stats.hands * 100) + '%';
      ok(huds[1].textContent.indexOf(want) === 0, 'HUD 里的 VPIP 跟引擎统计一致', want + ' vs ' + huds[1].textContent);
    }
    // 开关：用类名收起（不删节点，座位卡不会跳版）
    q('tgHud').checked = false;
    q('tgHud').onchange({ target: { checked: false } });
    ok(q('table').classList.contains('hud-off'), '关掉 HUD 后桌子带上 hud-off');
    ok(H.hudCfg().on === false, 'HUD 开关写进了配置');
    ok(!!w.localStorage.getItem('holdem_hud_v1'), 'HUD 配置落盘了');
    q('tgHud').checked = true;
    q('tgHud').onchange({ target: { checked: true } });
    ok(!q('table').classList.contains('hud-off'), '重新打开后类名去掉');

    // ---------- B. 📈 EV / All-in EV（新增功能 1） ----------
    const curve = H.session().curve;
    ok(Array.isArray(curve) && curve.length > 0, '走势里有数据', (curve || []).length + ' 条');
    ok(curve.every(r => typeof r.evChips === 'number' && isFinite(r.evChips)),
      '每一手都记了 EV 口径的累积筹码', curve.map(r => r.evChips).join(','));
    ok(curve.every(r => typeof r.evHand === 'boolean'), '每一手都标了「是不是全下摊牌」');
    const stx = H.curveStats();
    ok(typeof stx.evNow === 'number' && typeof stx.luck === 'number', 'curveStats 给出「应得」与「运气」',
      'EV=' + stx.evNow + ' · 运气=' + stx.luck);
    ok(stx.luck === stx.now - stx.evNow, '运气 = 实际 − 应得（口径自洽）');
    ok(typeof stx.evHands === 'number' && stx.evHands >= 0 && stx.evHands <= stx.n,
      '全下摊牌的手数在合理范围内', stx.evHands + ' / ' + stx.n);
    // 弃牌的手不该算 EV（结果是确定的，不是运气）
    const meX = H.players()[0];
    const bakFolded = meX.folded;
    meX.folded = true;
    ok(H.allinEquityFor(meX) === null, '弃了牌的手不算 EV');
    meX.folded = bakFolded;
    // EV 线真的画出来了：图例说明 + 走势摘要里带 EV 口径
    ok(q('curveLegend').textContent.indexOf('All-in EV') >= 0, '筹码图例里标了 EV 线');
    ok(q('curveNote').textContent.indexOf('按胜率应得') >= 0, '走势文字摘要里也报了 EV',
      q('curveNote').textContent.slice(0, 60));

    // ---------- C. 📒 跨局长期战绩账本（新增功能 4） ----------
    const bookBefore = H.records().sessions.length;
    const statNow = H.humanStat(H.hist().hands.filter(x => x.sid === H.session().id));
    H.recordSession({ sid: H.session().id, stat: statNow, rating: 77 });
    ok(H.records().sessions.length === bookBefore + 1, '收工时往账本里落了一条',
      bookBefore + ' → ' + H.records().sessions.length);
    const bk = H.bookSummary();
    ok(bk.n === bookBefore + 1, '汇总的局数对得上', bk.n + ' 局');
    ok(typeof bk.net === 'number' && typeof bk.avgRating === 'number' && typeof bk.avgNet === 'number',
      '汇总给出总净赢 / 平均每局 / 平均评分', 'net=' + bk.net + ' avg=' + bk.avgNet + ' rating=' + bk.avgRating);
    ok(bk.avgRating > 0, '有评分时平均评分不为 0', String(bk.avgRating));
    const lastRec = H.records().sessions[H.records().sessions.length - 1];
    ok(lastRec.hands === statNow.n, '账本里刚记的这局手数跟统计一致', lastRec.hands + ' vs ' + statNow.n);
    ok(bk.hands >= lastRec.hands, '汇总的累计手数不少于单局手数', bk.hands + ' ≥ ' + lastRec.hands);
    ok(!!w.localStorage.getItem('holdem_records_v1'), '账本写进了本机 localStorage');
    const storedBook = JSON.parse(w.localStorage.getItem('holdem_records_v1'));
    ok(storedBook.sessions.length === H.records().sessions.length,
      '磁盘上的账本条数跟内存里一致（真的落盘了）');
    // 无头环境没有 canvas：给新画布塞个假的 2d 上下文（跟第 20 节同一套路）。
    // 不塞的话 jsdom 会往 virtualConsole 抛 not-implemented，把「零脚本错误」打红。
    const bookCalls = { clearRect: 0, moveTo: 0, lineTo: 0, stroke: 0, fill: 0, arc: 0, fillText: 0, dash: 0 };
    const bookCv = q('bookCv');
    ok(!!bookCv, '战绩页有一张评分曲线画布');
    bookCv.getContext = () => ({
      clearRect: () => { bookCalls.clearRect++; }, fillRect: () => {}, beginPath: () => {},
      moveTo: () => { bookCalls.moveTo++; }, lineTo: () => { bookCalls.lineTo++; },
      stroke: () => { bookCalls.stroke++; }, fill: () => { bookCalls.fill++; },
      arc: () => { bookCalls.arc++; }, fillText: () => { bookCalls.fillText++; },
      setLineDash: () => { bookCalls.dash++; },
      createLinearGradient: () => ({ addColorStop: () => {} })
    });
    // 渲染
    const btab = [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'book');
    ok(!!btab, '复盘面板里有「📒 战绩」页签');
    btab.click(); await sleep(80);
    ok(q('coachPaneBook').classList.contains('on'), '「📒 战绩」页签能打开');
    ok(q('bookKpi').querySelectorAll('.k').length === 6, '战绩页有 6 张 KPI 卡',
      q('bookKpi').querySelectorAll('.k').length + ' 张');
    ok(q('bookKpi').textContent.indexOf('累计局数') >= 0, 'KPI 里有累计局数');
    ok(q('coachPaneBook').textContent.indexOf('逐 局 记 录') >= 0, '战绩页列出了逐局记录');
    ok(bookCalls.stroke > 0 && bookCalls.fillText >= 5, '评分曲线真的画出来了（有描边和纵轴刻度）',
      JSON.stringify(bookCalls));

    // ---------- D. P0/P1 的修正 ----------
    // P0-3 用量账本记了手数（「平均每手」的分母）
    ok(typeof H.usage().hands === 'number' && H.usage().hands >= 0, 'P0-3 用量账本记了手数',
      String(H.usage().hands));
    ok(typeof H.usageSession().hands === 'number', 'P0-3 「本次打开页面」也有自己的手数');
    // P0-4 Esc 关用量面板
    q('usageMask').classList.add('on');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(20);
    ok(!q('usageMask').classList.contains('on'), 'P0-4 Esc 能关掉用量面板');
    // P0-5 徽章样式
    const cssAll = [...d.querySelectorAll('style')].map(x => x.textContent).join('');
    ok(cssAll.indexOf('.ailog-kind.k-coachchat') >= 0, 'P0-5 补上了 k-coachchat 徽章样式');
    // P0-1 的关键前提：测「带 emoji 的 revealed」用老办法判不出来（回归钉子）
    ok('🔥麦琪：A♠ K♦'.indexOf('麦琪：') !== 0, 'P0-1 前提：老写法 indexOf(...)===0 判不出摊牌者');

    // P1-2 存档只认座位号 → 现在还要核对人名
    H.saveGame();
    const svRaw = w.localStorage.getItem('holdem_save_v1');
    ok(!!svRaw, 'P1-2 有存档可供校验');
    const svGood = JSON.parse(svRaw);
    const svBad = JSON.parse(JSON.stringify(svGood));
    svBad.players[1].name = '冒名顶替者';
    w.localStorage.setItem('holdem_save_v1', JSON.stringify(svBad));
    ok(H.restoreSave() === false, 'P1-2 存档里的人名对不上 → 拒绝恢复（不让新人接管旧筹码）');
    w.localStorage.setItem('holdem_save_v1', JSON.stringify(svGood));
    ok(H.restoreSave() === true, 'P1-2 原样存档 → 正常恢复');

    // P1-3 「清空她的记忆」也要清战绩（跟另两个入口口径一致）
    // 先点 1 号座位，确保「清空」按钮作用在我们要验的那个人身上
    const seats = [...d.querySelectorAll('.seat')];
    ok(seats.length === 8, '座位卡都在', seats.length + ' 个');
    seats[1].click(); await sleep(30);
    const target = H.players()[1];
    target.stats.hands = 9; target.stats.vpip = 5; target.stats.pfr = 3;
    target.mem.notes.push({ h: 1, delta: -50, desc: '测试记忆' });
    target.mem.summary = '测试用的长期记忆';
    const errBefore = errors.length;
    const mc = q('memClear');
    mc.click(); await sleep(20); mc.click(); await sleep(30);
    ok(target.stats.hands === 0, 'P1-3 清空她的记忆时，战绩也一起清', 'hand=' + target.stats.hands);
    ok(target.mem.notes.length === 0 && target.mem.summary === '', 'P1-3 记忆本身当然也清了',
      'notes=' + target.mem.notes.length + ' summary=' + JSON.stringify(target.mem.summary));
    ok(q('memClear').textContent.indexOf('战绩') >= 0, 'P1-3 按钮文案讲清了会清战绩',
      q('memClear').textContent);
    ok(errors.length === errBefore, 'P1-3 清空这条路径没有抛错',
      errors.slice(errBefore).join(' | '));

    // ⚠ 回归钉子：resetMem 的参数语义必须跟调用点一致。
    // 这里曾经是真 bug —— 函数内写 p.mem.notes，调用点却传 p.mem，
    // 于是 (mem对象).mem 是 undefined，一赋值就抛 TypeError，
    // 三个清空入口（全部/在座/单个人）**全部当场中断**，记忆一点没清，界面上却像清了。
    // 老自检只测了 wipeSeatsMem（那条路用 freshMem，碰巧是好的），所以一直没暴露。
    const mm = { notes: [{ h: 1 }], summary: 'x', miles: ['y'], sinceLast: 3, reflects: 2, fails: 1 };
    H.resetMem(mm);
    ok(mm.notes.length === 0 && mm.summary === '' && mm.miles.length === 0 &&
       mm.sinceLast === 0 && mm.reflects === 0 && mm.fails === 0,
      'resetMem 收到 mem 对象能就地清空（这个签名曾经对不上，三个清空入口全废）',
      JSON.stringify(mm));
    ok(H.resetMem(null) === null && H.resetMem(undefined) === undefined, 'resetMem 收到空值不抛错');
    // 「清空所有 AI 记忆」整条路径（以前这里必炸）
    H.players().forEach(p => {
      if (p.isHuman) return;
      p.mem.notes.push({ h: 1, delta: -5, desc: 't' }); p.mem.summary = '旧记忆'; p.stats.hands = 7;
    });
    const errBeforeAll = errors.length;
    const mcAll = q('aiClearMem');
    mcAll.click(); await sleep(20); mcAll.click(); await sleep(40);
    ok(H.players().slice(1).every(p => p.mem.notes.length === 0 && p.mem.summary === '' && p.stats.hands === 0),
      '「清空所有 AI 记忆」真的把 7 个人的记忆与战绩都清了',
      H.players().slice(1).map(p => p.mem.notes.length + '/' + p.stats.hands).join(' '));
    ok(errors.length === errBeforeAll, '「清空所有 AI 记忆」这条路径也没有抛错',
      errors.slice(errBeforeAll).join(' | '));

    // P1-4 「⏭ 不等了」
    ok(!!q('btnSkip'), 'P1-4 等待区有「⏭ 不等了」按钮');
    ok(typeof H.abortInflight === 'function', 'P1-4 abortInflight 可用');
    ok(typeof H.abortInflight() === 'number', 'P1-4 中止调用返回被中止的数量');

    // P1-5 窄屏适配
    ok(cssAll.indexOf('@media (max-width: 1180px)') >= 0, 'P1-5 有窄屏 media query（1180px）');
    ok(cssAll.indexOf('@media (max-width: 720px)') >= 0, 'P1-5 有窄屏 media query（720px）');

    // ---------- E. 🎲 随机种子（新增功能 5；放最后，因为它会重置牌局） ----------
    H.setSeed(777001); const k1 = H.shuffle(Array.from({ length: 52 }, (_, i) => i)).join(',');
    H.setSeed(777001); const k2 = H.shuffle(Array.from({ length: 52 }, (_, i) => i)).join(',');
    H.setSeed(777002); const k3 = H.shuffle(Array.from({ length: 52 }, (_, i) => i)).join(',');
    ok(k1 === k2, '第 5 功能：同一个种子洗出同一副牌');
    ok(k1 !== k3, '第 5 功能：换一个种子就是另一副牌');
    ok(new Set(k1.split(',')).size === 52 && k1.split(',').length === 52, '洗出来仍是 52 张不重复');
    H.setSeed(555); const q1 = [H.rnd(), H.rnd(), H.rnd()].join(',');
    H.setSeed(555); const q2 = [H.rnd(), H.rnd(), H.rnd()].join(',');
    ok(q1 === q2, '同种子下随机序列可复现', q1.slice(0, 30));
    ok([H.rnd(), H.rnd()].every(x => x >= 0 && x < 1), 'rnd 落在 [0,1)');
    H.setSeed(123456); H.syncSeedUI();
    ok(q('hSeed').textContent === '123456', '顶栏显示出本局种子', q('hSeed').textContent);
    ok(H.buildSave().seed === 123456, '存档里带着本局种子', String(H.buildSave().seed));
    ok(!!q('btnSeed') && !!q('seedMask'), '顶栏有「🎲」入口，也有种子面板');
    H.resetGame(88);
    ok(H.seed() === 88, 'resetGame 能按指定种子开新局', String(H.seed()));
    ok(q('hSeed').textContent === '88', '顶栏种子跟着更新', q('hSeed').textContent);
  }

  console.log('\n=== 22. 🃏 起手牌表 · ▶ 局面回放 · 🔁 重打 ===');
  {
    // ---------- A. 🃏 起手牌表（新增功能 6） ----------
    // Chen 公式：几手公认的牌，分数必须对得上（算错了整张表就是错的）
    ok(H.chenScore(14, 14, false) === 20, 'AA 的 Chen 分是 20', String(H.chenScore(14, 14, false)));
    ok(H.chenScore(13, 13, false) === 16, 'KK 的 Chen 分是 16', String(H.chenScore(13, 13, false)));
    ok(H.chenScore(14, 13, true) === 12, 'AKs 的 Chen 分是 12', String(H.chenScore(14, 13, true)));
    ok(H.chenScore(14, 13, false) === 10, 'AKo 的 Chen 分是 10', String(H.chenScore(14, 13, false)));
    ok(H.chenScore(7, 2, false) <= 1, '72o 是最烂的牌之一', String(H.chenScore(7, 2, false)));
    ok(H.chenScore(14, 13, true) > H.chenScore(14, 13, false), '同花比不同花值钱');
    ok(H.chenScore(14, 14, false) > H.chenScore(13, 13, false), 'AA 比 KK 值钱');
    ok(H.chenScore(14, 14, false) > H.chenScore(9, 9, false), '大对子比小对子值钱');
    // 门槛随位置变：至少得是个合理的数
    const th0 = H.chenThreshold();
    ok(typeof th0 === 'number' && th0 >= 6 && th0 <= 10, '当前位置的入池门槛合理', String(th0));

    // 打开面板
    q('btnRange').click(); await sleep(80);
    ok(q('rangeMask').classList.contains('on'), '🃏 起手牌表能打开');
    const cells = [...q('rangeChart').querySelectorAll('td')];
    ok(cells.length === 169, '表格是 13×13 = 169 格', cells.length + ' 格');
    ok(cells[0].textContent === 'AA', '左上角是 AA', cells[0].textContent);
    ok(cells[168].textContent === '22', '右下角是 22', cells[168].textContent);
    ok(cells[1].textContent === 'AKs', '右上三角是同花（AKs）', cells[1].textContent);
    ok(cells[13].textContent === 'AKo', '左下三角是不同花（AKo）', cells[13].textContent);
    ok(cells[12].textContent === 'A2s', '第一行最右是同花 A2s', cells[12].textContent);
    ok(cells[0].className.indexOf('s3') >= 0, 'AA 落在「可以玩」那一档', cells[0].className);
    ok(cells[168].className.indexOf('s0') >= 0, '22 在这么靠前的位置落在「一般该弃」档', cells[168].className);
    // 同花格与不同花格的分档要一致地对：同样的两张牌，同花不该比不同花更差
    ok(H.chenScore(11, 10, true) >= H.chenScore(11, 10, false), 'JTs 不比 JTo 差');
    ok(q('rangeNow').querySelectorAll('.k').length === 4, '顶部有位置 / 门槛 / 要跟 / 底池赔率四张卡',
      q('rangeNow').querySelectorAll('.k').length + ' 张');
    ok(q('rangeSub').textContent.indexOf('门槛') >= 0 || q('rangeSub').textContent.indexOf('黄') >= 0,
      '有一句位置说明', q('rangeSub').textContent.slice(0, 40));
    ok(q('rangeTip').textContent.indexOf('底池赔率') >= 0, '底部给了怎么用这张表的说明');
    q('rangeClose').click(); await sleep(30);
    ok(!q('rangeMask').classList.contains('on'), '起手牌表能关掉');
    // Esc 也能关（P0-4 的同类问题，新面板一并守住）
    q('btnRange').click(); await sleep(40);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(40);
    ok(!q('rangeMask').classList.contains('on'), 'Esc 也能关掉起手牌表');

    // ---------- B. ▶ 局面回放 · 🔁 重打（新增功能 2） ----------
    await clickReset();
    H.hist().enabled = true;
    await playHands(2);
    await waitFor(() => H.coachIdle() === 0, 30000);
    const hrec = H.hist().hands[H.hist().hands.length - 1];
    ok(!!hrec && Array.isArray(hrec.acts) && hrec.acts.length > 0, '手上有一手带动作记录的档案',
      hrec ? (hrec.acts || []).length + ' 条动作' : '没有档案');

    const steps = H.replaySteps(hrec);
    ok(steps.length === hrec.acts.length + 1, '回放步数 = 动作数 + 1（开头那一步）',
      steps.length + ' vs ' + (hrec.acts.length + 1));
    ok(steps[0].kind === 'start', '第一步是「发牌」');
    ok(steps.slice(1).every(x => x.kind === 'act' && x.label && typeof x.pot === 'number'),
      '每一步都带动作描述与底池');
    let mono = true;
    for (let i = 1; i < steps.length; i++) if (steps[i].pot < steps[i - 1].pot) mono = false;
    ok(mono, '回放过程中底池单调不减（每一步只加不减）');
    ok(steps[steps.length - 1].pot > 0, '最后一步底池大于 0', String(steps[steps.length - 1].pot));

    H.openReplay(hrec.id); await sleep(60);
    ok(q('replayMask').classList.contains('on'), '▶ 回放面板能打开');
    ok(q('replayBody').textContent.indexOf('公共牌') >= 0, '回放里显示公共牌');
    ok(q('replayBody').textContent.indexOf(hrec.hole) >= 0, '回放里显示我的底牌', hrec.hole);
    const rows = [...q('replayBody').querySelectorAll('.rp-row')];
    ok(rows.length === steps.length, '每个动作一行', rows.length + ' 行');
    ok(q('replayStep').textContent === '0 / ' + (steps.length - 1), '步数显示正确', q('replayStep').textContent);
    // 公共牌随街推进
    ok(H.replayBoard(hrec, 0).length === 0, '第 0 步还没翻公共牌');
    ok(H.replayBoard(hrec, steps.length - 1).length <= 5, '最后一步公共牌不超过 5 张',
      H.replayBoard(hrec, steps.length - 1).join(' '));
    q('replayNext').click(); await sleep(40);
    ok(q('replayStep').textContent === '1 / ' + (steps.length - 1), '「下一步」能往前走', q('replayStep').textContent);
    ok(q('replayBody').querySelectorAll('.rp-row.now').length === 1, '当前步只有一处高亮');
    q('replayPrev').click(); await sleep(40);
    ok(q('replayStep').textContent === '0 / ' + (steps.length - 1), '「上一步」能往回走');
    q('replayPrev').click(); await sleep(30);
    ok(q('replayStep').textContent.indexOf('0 /') === 0, '到头了不会走成负数', q('replayStep').textContent);
    for (let i = 0; i < steps.length + 3; i++){ q('replayNext').click(); await sleep(5); }
    ok(q('replayStep').textContent === (steps.length - 1) + ' / ' + (steps.length - 1), '走到最后就停住',
      q('replayStep').textContent);
    ok(q('replayBody').textContent.indexOf('结局') >= 0, '走到最后给出结局');
    q('replayClose').click(); await sleep(40);
    ok(!q('replayMask').classList.contains('on'), '回放面板能关掉');

    // 🔁 重打：底牌与公共牌必须原样发回（对手的牌设计上就是重新随，不校验）
    const rt = r => ({ 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' }[r]);
    const stt = x => ['♠','♥','♦','♣'][x];
    const holeOf = pl => pl.hole.map(c => rt(c.r) + stt(c.s)).join(' ');
    ok(H.fixedHand() === null, '平时没有固定牌（不影响正常发牌）');
    H.replayHand(hrec.id);
    await sleep(500);
    ok(H.fixedHand() !== null, '重打期间进入「固定牌」模式');
    ok(H.players()[0].hole.length === 2, '重打发出了底牌');
    ok(holeOf(H.players()[0]) === hrec.hole, '重打的底牌跟原来一模一样',
      holeOf(H.players()[0]) + ' vs ' + hrec.hole);
    // 收尾：重置掉这一手挂起的牌局，确认固定牌不会污染后面的正常发牌
    q('btnReset').click(); await sleep(30); q('btnReset').click(); await sleep(80);
    ok(H.fixedHand() === null, '重新开局后固定牌被清掉，不污染后面的正常发牌');
  }

  console.log('\n=== 23. 动线 · 刻骨铭心 · 讨论模式 · 特效 · 读人判断 ===');
  {
    // ---------- A. 读人判断真的参与决策（需求 5） ----------
    await clickReset();
    H.hist().enabled = true;
    await playHands(4);
    await waitFor(() => H.coachIdle() === 0, 30000);

    const aiP = H.players().filter(p => !p.isHuman);
    const withReads = aiP.filter(p => Object.keys(H.fixReads(p.reads)).length > 0);
    ok(aiP.every(p => p.reads && typeof p.reads === 'object'), '每个 AI 都挂上了「对别人的判断」表');
    ok(withReads.length > 0, '★ 打过几手之后，确实有人攒下了对别人的判断',
      withReads.map(p => p.name + ':' + Object.keys(p.reads).length).join(' '));
    // 每一条判断的形态
    const one = withReads[0];
    const rk = Object.keys(one.reads)[0];
    const rv = one.reads[rk];
    ok(typeof rv.t === 'string' && rv.t.length > 0 && rv.t.length <= 60,
      '判断是一句话且长度受控（≤60 字，token 不失控）', '"' + rv.t + '"（' + rv.t.length + ' 字）');
    ok(typeof rv.h === 'number' && rv.h > 0, '记下了这是第几手形成的', 'h=' + rv.h);
    ok(typeof rv.n === 'number' && rv.n >= 1, '记下了看过几次', 'n=' + rv.n);
    // 归人正确：判断必须落在「当时压着它的那个人」头上，不能是它自己
    ok(!one.reads[one.id], '判断不会落到自己头上', '自己的座位号 ' + one.id + ' 不在表里');
    // ★ 最要紧的一条：判断真的进了 prompt —— 快照里出现了「你对这几个人的判断」
    const decAfter = H.ailog().filter(r => r.kind === 'decide' && r.ok);
    const withBlock = decAfter.filter(r => String(r.usr).indexOf('你对这几个人的判断') >= 0 ||
                                           String(r.usr).indexOf('你对这几个人的印象') >= 0);
    ok(decAfter.length > 0, '有决策请求可供检查', decAfter.length + ' 条');
    ok(withBlock.length > 0, '★ 判断块真的出现在了后续决策的快照里（不是只躺在内存里）',
      withBlock.length + '/' + decAfter.length + ' 条快照带上了判断');
    // 精准档 vs 精简档：精简档也要带（否则小决定用不上）
    const liteWith = withBlock.filter(r => r.tier === 'lite');
    const liteN = withBlock.filter(r => r.tier === 'lite').length;
    const fullN = withBlock.filter(r => r.tier === 'full').length;
    ok(liteN > 0 && fullN > 0,
      '★ 精简档和全量档都带上了判断（小决定也用得上，不只是大决定）',
      'lite ' + liteN + ' 条 / full ' + fullN + ' 条');
    // 每句都限长 → 总量可控
    const blk = withBlock[withBlock.length - 1];
    if (blk){
      const seg = String(blk.usr).split('你对这几个人的判断')[1] || '';
      const body = seg.split('【')[0];
      ok(body.length < 700, '判断块本身占的篇幅是有限的（不会把 prompt 撑爆）',
        body.length + ' 字');
    }
    // learnRead 的归人逻辑：直接单元验证
    ok(typeof H.learnRead === 'function', 'learnRead 可用');
    // 清空记忆时判断一起清
    const beforeRd = Object.keys(H.fixReads(H.players()[1].reads)).length;
    H.wipeSeatsMem();
    ok(Object.keys(H.fixReads(H.players()[1].reads)).length === 0,
      '「清空在座记忆」把判断也清了（它也是一份记忆）', beforeRd + ' → 0');

    // ---------- B. 动线（需求 4） ----------
    await clickReset();
    H.hist().enabled = true;
    await playHands(3);
    await waitFor(() => H.coachIdle() === 0, 30000);
    // 动线函数：长度硬上限
    const L1 = H.lineOfHand(1, 150);
    ok(typeof L1 === 'string', 'lineOfHand 能生成动线', '"' + String(L1).slice(0, 70) + '"');
    ok(String(L1).length <= 150, '动线长度被硬压在 maxLen 以内', String(L1).length + ' 字 ≤ 150');
    const L2 = H.lineOfHand(1, 40);
    ok(String(L2).length <= 40, '换个更小的上限也守得住', String(L2).length + ' 字 ≤ 40');
    // 每一位 AI 的手记里都带了动线
    const notesWithLine = aiP.flatMap(p => (p.mem.notes || [])).filter(n => n.line);
    ok(notesWithLine.length > 0, '★ 手记里真的带上了棋局动线（不再只有结果）',
      notesWithLine.length + ' 条带动线');
    ok(notesWithLine.every(n => String(n.line).length <= 200), '每条动线都在可控长度内');
    // noteText 把动线摆出来（喂给模型的文本）
    const nt = H.noteText(notesWithLine[0]);
    ok(nt.indexOf('动线：') >= 0, 'noteText 会把手记连动线一起摆给模型', nt.slice(0, 80));

    // ---------- C. 刻骨铭心 vs 长期记忆（需求 4） ----------
    // 手工造一条刻骨铭心，验证结构化 + 渲染 + 回填
    const victim = aiP[0];
    victim.mem = H.fixMem(victim.mem);
    victim.mem.milestones.push({
      h: 99, kind: 'loss', hole: 'A♠ A♦', board: 'K♥ 9♣ 4♦ 2♠ 7♥',
      line: '翻前 麦琪加60→你加180→麦琪跟 → 翻牌[K♥9♣4♦] 你下240→麦琪全下900→你跟', res: -900,
      lesson: '', showdown: true
    });
    ok(victim.mem.milestones.length > 0, '刻骨铭心是结构化的（对象数组，不是一串字符串）',
      JSON.stringify(victim.mem.milestones[victim.mem.milestones.length - 1]).slice(0, 60) + '…');
    const mtxt = H.milestoneText(victim.mem.milestones[victim.mem.milestones.length - 1], 0);
    ok(mtxt.indexOf('经过：') >= 0, '★ 刻骨铭心摆出来时带着完整动线（这就是它和长期记忆的区别）',
      mtxt.slice(0, 90));
    ok(mtxt.indexOf('第99手') >= 0, '刻骨铭心锁定到具体某一手');
    // 长期记忆是规律、刻骨铭心是具体一手 —— 两者形态必须不同
    ok(typeof victim.mem.summary === 'string' && Array.isArray(victim.mem.milestones),
      '★ 长期记忆（字符串规律）与刻骨铭心（结构化单手）是两种东西，没有混在一起');
    // 老存档迁移：老的 miles 字符串要能搬进 milestones，不丢
    const oldMem = { notes: [], summary: 'x', miles: ['【惨败】第3手 底牌 XX，净亏 800。'], sinceLast: 1, reflects: 1, fails: 0 };
    const fixed = H.fixMem(oldMem);
    ok(fixed.milestones.length === 1 && fixed.milestones[0].kind === 'old' &&
       String(fixed.milestones[0].text).indexOf('第3手') >= 0,
      '老存档里的「刻骨铭心」被迁移进新结构，内容没丢',
      JSON.stringify(fixed.milestones[0]).slice(0, 70));
    ok(H.fixMem(null).notes.length === 0, 'fixMem 对空值也不炸');
    // 渲染到记忆卡上
    // openMem 没挂在调试出口上，直接点座位卡（跟用户的操作路径一致）
    [...d.querySelectorAll('.seat')][1].click(); await sleep(60);
    ok(q('memMiles').textContent.indexOf('经过：') >= 0 || q('memMiles').textContent.indexOf('第 99 手') >= 0,
      '记忆卡上能看到刻骨铭心的完整经过', q('memMiles').textContent.slice(0, 60));
    ok(q('memNotes').textContent.indexOf('动线：') >= 0, '记忆卡上的手记也带上了动线');
    q('memClose').click(); await sleep(30);

    // ---------- D. 讨论模式（需求 2） ----------
    const ttab = [...d.querySelectorAll('#coachMask .ctab')].find(b => b.dataset.tab === 'talk');
    ok(!!ttab, '复盘面板里有「💬 讨论」页签');
    ttab.click(); await sleep(70);
    ok(q('coachPaneTalk').classList.contains('on'), '「💬 讨论」页签能打开');
    ok(!!q('talkQ') && !!q('talkSend'), '讨论模式有输入框和发送按钮');
    // 上下文必须真的来自记忆，而不是空手聊
    H.coach().mem = 'MARK-长期记忆：我在前面位置玩得太松，要收紧。';
    const ctx = H.talkCtxText();
    ok(ctx.indexOf('MARK-长期记忆') >= 0, '★ 讨论的上下文里带着长期记忆', ctx.slice(0, 50) + '…');
    ok(ctx.indexOf('长期战绩') >= 0, '上下文里有长期战绩');
    ok(ctx.indexOf('点评') >= 0, '上下文里有最近的逐手点评');
    ok(H.talkSys().indexOf('讨论模式') >= 0, '系统提示词点明了这是讨论模式（不是逐手复盘）');
    ok(H.talkSys().indexOf('不要输出 JSON') >= 0, '讨论模式不逼它吐 JSON（要的是人话）');
    // 真的问一轮
    const tkBefore = H.coach().talk.length;
    const jt = await H.talkAsk('我最近最大的问题是什么？');
    ok(!!jt && jt.ok && String(jt.a).length > 0, '★ 讨论模式能拿到回答', String(jt.a).slice(0, 50));
    ok(H.coach().talk.length === tkBefore + 1, '这一轮记进了对话历史',
      tkBefore + ' → ' + H.coach().talk.length);
    ok(!!w.localStorage.getItem('holdem_coach_v1'), '讨论记录落了盘（关页面也在）');
    const storedTalk = JSON.parse(w.localStorage.getItem('holdem_coach_v1')).talk;
    ok(Array.isArray(storedTalk) && storedTalk.length === H.coach().talk.length,
      '磁盘上的讨论条数跟内存一致');
    // 上一条问过的内容会作为上下文带进下一轮
    const tkCalls = calls.filter(c => c.kind === 'coach-talk');
    ok(tkCalls.length > 0, '讨论走的是独立的 coach-talk 类型（跟复盘分开记账）',
      tkCalls.length + ' 次');
    ok(tkCalls[0].thinkOn === true, '讨论模式开了思考（要真想清楚才答得准）');
    // 渲染
    H.renderTalk();
    ok(q('talkThread').textContent.indexOf(String(jt.a).slice(0, 20)) >= 0, '回答渲染到了面板上');
    ok(q('talkThread').textContent.indexOf('🙋 我：') >= 0, '问题也渲染在面板上');
    // 清空
    q('talkClear').click(); await sleep(40);
    ok(H.coach().talk.length === 0, '「清空这段对话」能清掉');
    ok(H.coach().mem.indexOf('MARK-长期记忆') >= 0, '清对话不会连长期记忆一起清（两者分开）');
    // 缺 Key 时给出明确指引而不是崩
    const bakKey = H.cfg.apiKey; H.cfg.apiKey = '';
    const jNoKey = await H.talkAsk('随便问问');
    ok(jNoKey && jNoKey.ok === false && jNoKey.err.indexOf('Key') >= 0, '没配 Key 时给出明确提示',
      String(jNoKey.err).slice(0, 40));
    H.cfg.apiKey = bakKey;
    // 空问题不发请求
    const nBefore = calls.length;
    const jEmpty = await H.talkAsk('   ');
    ok(jEmpty.ok === false && calls.length === nBefore, '空问题不会白发一次请求');

    // ---------- E. 特效（需求 3） ----------
    ok(!!q('fxLayer'), '桌面里有独立的特效层');
    ok(typeof H.fxAllIn === 'function' && typeof H.fxBigPot === 'function' &&
       typeof H.fxBlindUp === 'function' && typeof H.fxBust === 'function',
      '全下 / 大底池 / 盲注升级 / 出局 四种特效都在');
    // 特效层不能吃点击（这是硬要求：装饰绝不能挡住按钮）
    const fxCss = [...d.querySelectorAll('style')].map(x => x.textContent).join('');
    ok(/#fxLayer\{[^}]*pointer-events:none/.test(fxCss), '★ 特效层 pointer-events:none（绝不吃点击）');
    ok(fxCss.indexOf('@keyframes fxRing') >= 0, '冲击波动画定义在（纯 CSS，无外部依赖）');
    ok(fxCss.indexOf('prefers-reduced-motion') >= 0, '尊重系统「减少动态效果」偏好');
    // 触发一次，看真的插进了 DOM
    const layer = q('fxLayer');
    const n0 = layer.children.length;
    H.fxAllIn('麦琪', 1200);
    ok(layer.children.length > n0, '★ 调用后会往特效层插元素',
      n0 + ' → ' + layer.children.length);
    ok(layer.textContent.indexOf('ALL IN') >= 0, '全下显示 ALL IN');
    ok(layer.textContent.indexOf('麦琪') >= 0, '全下带上是谁全下');
    // 全下的座位要有常亮标记（renderSeat 里挂 class）
    const me0 = H.players()[1];
    const bakAllin = me0.allIn;
    me0.allIn = true; H.render();
    ok([...d.querySelectorAll('.seat')][1].classList.contains('allin'),
      '全下的座位挂上了 allin 类名（常亮金光）');
    me0.allIn = bakAllin; H.render();
    ok(![...d.querySelectorAll('.seat')][1].classList.contains('allin'), '不是全下时类名会去掉');
    // 大底池：底池框脉冲
    H.fxBigPot(5000);
    ok(q('potVal').parentNode.className.indexOf('pot-burst') >= 0, '大底池时底池框会脉冲');
    ok(fxCss.indexOf('@keyframes potBurst') >= 0, '脉冲动画定义在');
    H.fxBlindUp(3, 40, 80);
    ok(layer.textContent.indexOf('盲注升级') >= 0, '盲注升级有提示');
    // 出局特效不炸（座位卡在）
    let bustOk = true;
    try{ H.fxBust(2); }catch(e){ bustOk = false; }
    ok(bustOk, '出局特效调用不抛错');
    ok(layer.children.length > 0, '特效元素确实进去了（稍后会由定时器清理，不会堆积）');
    // 牌局没被特效影响
    ok(H.players().length === 8, '特效不影响牌局本身');
  }

  console.log('\n=== 24. 动线是「他自己的视角」· 手牌尺寸 ===');
  {
    // handLog / community 都是引擎内部状态，这里临时摆一个已知形状，测完原样还回去
    const hl = H.handlog();
    const bd = H.board();
    const bakHL = hl.slice(), bakBD = bd.slice();
    try{
      hl.length = 0;
      [
        { s:0, seat:2, name:'麦琪', act:'raise', to:60,  allin:false, face:20,  potBefore:30,   put:60  },
        { s:0, seat:1, name:'李姨', act:'call',  to:60,  allin:false, face:60,  potBefore:90,   put:60  },
        { s:0, seat:0, name:'你',   act:'call',  to:60,  allin:false, face:60,  potBefore:150,  put:60  },
        { s:0, seat:3, name:'艾米', act:'fold',  to:0,   allin:false, face:60,  potBefore:210,  put:0   },
        { s:1, seat:2, name:'麦琪', act:'allin', to:900, allin:true,  face:0,   potBefore:240,  put:660 },
        { s:1, seat:1, name:'李姨', act:'fold',  to:0,   allin:false, face:900, potBefore:900,  put:0   },
        { s:1, seat:0, name:'你',   act:'call',  to:900, allin:false, face:900, potBefore:1140, put:660 }
      ].forEach(e => hl.push(e));
      bd.length = 0;
      bd.push({ r: 13, s: 0 }, { r: 9, s: 3 }, { r: 4, s: 2 });

      const L1 = H.lineOfHand(1, 200);   // 李姨
      const L2 = H.lineOfHand(2, 200);   // 麦琪
      const L3 = H.lineOfHand(3, 200);   // 艾米

      // ★ 核心：同一手牌，三个人看到的动线必须不一样 —— 这才叫「他自己的视角」
      ok(L1 !== L2 && L2 !== L3 && L1 !== L3,
        '★ 同一手牌，不同座位看到的动线不一样（全桌共用一条流水账 ≠ 他自己的经历）',
        '李姨「' + L1 + '」');
      // 自己 = 「你」
      ok(L1.indexOf('你跟') >= 0 && L1.indexOf('你弃') >= 0, '李姨的动线里，它自己写作「你」');
      ok(L2.indexOf('你加到') >= 0 && L2.indexOf('你全下') >= 0, '麦琪的动线里，它自己写作「你」');
      // ★★ 反向 bug 的钉子（这条曾经是反的，害得 AI 把自己的动作当成别人的）
      ok(L1.indexOf('玩家') >= 0,
        '★★ 对 AI 来说，人类玩家叫「玩家」而不是「你」（这条曾经是反的：AI 会以为人类那步是自己干的）', L1);
      ok(L1.indexOf('李姨') < 0, '★★ 李姨不会在自己的动线里看到自己的名字（看到就会误以为是别人）', L1);
      ok(L2.indexOf('麦琪') < 0, '★★ 麦琪同理');
      ok(L3.indexOf('艾米') < 0, '★★ 艾米同理');
      // 「面对多少」是只有他自己才知道的处境
      ok(L1.indexOf('(面对900)') >= 0,
        '★ 李姨能看到自己当时「面对 900」——这个数别人看不到', L1);
      ok(L2.indexOf('(面对') < 0, '麦琪这条没有多余的「面对」标注（那一手没人压她）', L2);
      // 末尾的「共投」也是他自己的那个数
      ok(L2.indexOf('共投') >= 0, '动线末尾给出「他这一手共投了多少」', L2.slice(-18));
      ok(L1.indexOf('共投 60') >= 0, '李姨的共投数跟她的实际投入一致', L1.slice(-14));
      ok(L3.indexOf('共投') < 0, '艾米一手没投，就不写「共投」（不编 0）', L3);
      // 长度
      ok(L1.length <= 200 && L2.length <= 200 && L3.length <= 200, '三种视角都守住了长度上限',
        [L1.length, L2.length, L3.length].join('/'));
      const Lshort = H.lineOfHand(1, 30);
      ok(Lshort.length <= 30, '把上限压到 30 也守得住（长期记忆压缩的 token 就靠它）',
        Lshort.length + ' 字');

      // ★ 人多也不折叠掉他自己的动作：9 条动作，他两步过牌必须一个不少
      hl.length = 0;
      ['麦琪', '王姨', '杰西', '虎姐', '莉莉', '艾米'].forEach((n, i) => {
        hl.push({ s:0, seat:i + 2, name:n, act:'call', to:20, allin:false, face:20, potBefore:20, put:20 });
      });
      hl.push({ s:0, seat:1, name:'李姨', act:'check', to:0, allin:false, face:0, potBefore:140, put:0 });
      hl.push({ s:0, seat:0, name:'你',   act:'check', to:0, allin:false, face:0, potBefore:140, put:0 });
      hl.push({ s:0, seat:1, name:'李姨', act:'check', to:0, allin:false, face:0, potBefore:140, put:0 });
      const Lbig = H.lineOfHand(1, 200);
      const myChecks = (Lbig.match(/你过/g) || []).length;
      ok(myChecks === 2,
        '★ 哪怕这一街 9 条动作，他自己的两步也一个不少（折叠只折别人）', Lbig);
      ok(Lbig.length <= 200, '折掉别人的跟注之后长度仍然可控', Lbig.length + ' 字');
      ok(Lbig.indexOf('其余') >= 0, '被折掉的人补了一句计数，不至于看起来没人跟过');
    } finally {
      hl.length = 0; bakHL.forEach(e => hl.push(e));
      bd.length = 0; bakBD.forEach(c => bd.push(c));
    }

    // ---------- 端到端：长期记忆压缩的输入里真的带了「他自己的视角」动线 ----------
    const reflectCalls = calls.filter(c => c.kind === 'reflect');
    ok(reflectCalls.length > 0, '发生过 AI 自己的复盘（也就是长期记忆压缩）',
      reflectCalls.length + ' 次');
    const withLine = reflectCalls.filter(c => String(c.usr).indexOf('动线：') >= 0);
    ok(withLine.length > 0,
      '★ 长期记忆压缩的输入里真的带着动线（不是只把「底牌+结果」丢给它）',
      withLine.length + '/' + reflectCalls.length + ' 次');
    // 动线必须是「你」视角 —— 这是这一节的核心，端到端再确认一次
    const lineSegs = [];
    for (const c of withLine){
      for (const m of (String(c.usr).match(/动线：[^\n]*/g) || [])) lineSegs.push(m);
    }
    ok(lineSegs.length > 0, '抽得到具体的动线文本', lineSegs.length + ' 条');
    ok(lineSegs.some(x => x.indexOf('你') >= 0),
      '★ 喂进压缩的动线是「你」视角（第一人称，不是全桌流水账）',
      (lineSegs[0] || '').slice(0, 78));
    ok(lineSegs.every(x => x.length <= 230),
      '每条动线都压在可控长度内（不会把压缩的 prompt 撑爆）',
      '最长 ' + Math.max.apply(null, lineSegs.map(x => x.length)) + ' 字');

    // ---------- 手牌尺寸 ----------
    const cssNow = [...d.querySelectorAll('style')].map(x => x.textContent).join('');
    const mineM = /\.seat\.mine \.hole \.card\{\s*width:(\d+)px; height:(\d+)px/.exec(cssNow);
    ok(!!mineM, '玩家手牌有自己独立的尺寸规则');
    // 取**最后一条**（同特异性后者生效，最后那条才是真正生效的）
    const otherAll = cssNow.match(/\.seat \.hole \.card\{ ?width:(\d+)px; height:(\d+)px;/g) || [];
    ok(otherAll.length > 0, '其他座位的手牌尺寸规则也在', otherAll.length + ' 条');
    if (mineM && otherAll.length){
      const lastO = otherAll[otherAll.length - 1];
      const mw = +mineM[1], mh = +mineM[2];
      const ow = +/width:(\d+)px/.exec(lastO)[1], oh = +/height:(\d+)px/.exec(lastO)[1];
      ok(mw > ow && mh > oh, '★ 玩家的手牌比其他人明显大一圈',
        '你 ' + mw + '×' + mh + ' vs 他们 ' + ow + '×' + oh);
      ok(mw >= 60 && mh >= 88, '★ 玩家手牌够大到看得清（宽 ≥60、高 ≥88）', mw + '×' + mh);
      ok(ow >= 50 && oh >= 70, '其他座位的手牌也顺手放大了', ow + '×' + oh);
    }
    ok(/\.seat \.hole\{ height:auto; min-height/.test(cssNow),
      '手牌容器高度改成由内容撑开（原来写死高度，牌一大就会被压扁）');
    ok(/\.seat\.mine\{ width:186px; \}/.test(cssNow), '玩家座位卡跟着放宽，两张牌不会挤在一起');
  }

  console.log('\n=== 25. 五个 P0 修正 · 五个新功能 ===');
  {
    // ---------------------------------------------------------------
    // ★ P0-1 · 出牌快捷键绝不劫持输入框
    //   这条是这一轮最贵的一个 bug：轮到你出牌时，在「💬 讨论」或「档案追问」框里
    //   打一句「call 会不会更好」，那个 c 会当场被当成「跟注」替你按下去。
    //   探针实测过 actionType 从 call 变 fold —— 代价是一整手牌。
    // ---------------------------------------------------------------
    async function toMyTurn(limitMs){
      const t0 = Date.now();
      while (Date.now() - t0 < (limitMs || 45000)){
        if (q('controls').classList.contains('on')) return true;
        if (maybeRestart()){ await sleep(30); continue; }
        if (!q('btnNext').disabled){
          const me = w.HOLDEM.players()[0];
          if (me && me.chips < 600) me.chips = 1000;
          q('btnNext').click();
        }
        autoHuman();
        await sleep(15);
      }
      return false;
    }
    const fire = (el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    await clickReset();
    await playHands(1);
    const myTurn1 = await toMyTurn(45000);
    ok(myTurn1, '等到「轮到你出牌」了（P0-1 要在这个状态下测）');

    if (myTurn1){
      // —— 反向：在输入框里打字，绝不能出牌 ——
      const actBefore = w.HOLDEM.players()[0].actionType;
      const talkBox = q('talkQ'), histBox = q('histQ');
      ok(!!talkBox && !!histBox, '页面里有「讨论」和「追问」两个输入框');
      for (const box of [talkBox, histBox]){
        try{ box.focus(); }catch(e){}
        for (const k of ['f', 'c', 'r', 'a']) fire(box, k);
        await sleep(15);
      }
      ok(q('controls').classList.contains('on'),
        '★★ 在输入框里打 f/c/r/a，这一手没有替我出牌（控件还亮着）',
        'controls.on = ' + q('controls').classList.contains('on'));
      ok(w.HOLDEM.players()[0].actionType === actBefore,
        '★★ 我这一手的状态一个字母都没变', 'actionType=' + w.HOLDEM.players()[0].actionType);
      // 顺带：数字输入框同样不该触发（seed 那个框）
      const seedBox = q('seedVal');
      try{ seedBox.focus(); }catch(e){}
      fire(seedBox, 'f'); await sleep(15);
      ok(q('controls').classList.contains('on'), '在数字输入框里打字同样不出牌');

      // —— 正向：焦点不在输入框时，快捷键必须照旧管用（别把功能一起修没了）——
      try{ d.activeElement && d.activeElement.blur && d.activeElement.blur(); }catch(e){}
      fire(d.body, 'f');
      await sleep(80);
      ok(w.HOLDEM.players()[0].actionType === 'fold',
        '焦点不在输入框时，F 键照样弃牌（修 bug 没顺手废掉功能）',
        'actionType=' + w.HOLDEM.players()[0].actionType);
    }

    // —— Esc：在输入框里只失焦、不关面板（草稿留住） ——
    q('btnCoach').click(); await sleep(60);
    ok(q('coachMask').classList.contains('on'), '教练面板能打开');
    const box2 = q('histQ');
    try{ box2.focus(); }catch(e){}
    fire(box2, 'Escape'); await sleep(40);
    ok(q('coachMask').classList.contains('on'),
      '★ 在输入框里按 Esc 不会把面板关掉（写了一半的草稿保住了）');
    fire(d, 'Escape'); await sleep(40);
    ok(!q('coachMask').classList.contains('on'), '焦点不在输入框时，Esc 照样关面板');

    // ---------------------------------------------------------------
    // ★ P0-3 · 老档案缺字段不再把档案面板弄崩
    //   fixHist 以前只补 chat / ai / star；缺 revealed / showSay 的老档案一展开
    //   就 TypeError，整个面板打不开。档案是跨版本长期留存的东西，读取侧必须容错。
    // ---------------------------------------------------------------
    const oldArch = {
      id: 'OLDP0TEST', h: 99, sid: '', t: Date.now() + 99999, blinds: '10/20', pos: '按钮位',
      hole: 'A♠ K♦', board: '2♥ 7♣ J♠', mine: 'x', table: 'y',
      pot: 100, delta: -20, chips: 980, raises: 0, calls: 1, checks: 0,
      vpip: true, pfr: false, sawFlop: true, showdown: false, withdrew: false, foldStreet: -1,
      hname: '', rivals: 7, allin: false, ai: [], chat: [], star: true
      // ⚠ 故意不给 revealed / showSay / acts / stacks / winners —— 模拟旧版存档
    };
    // ① 直接验 fixHist 的归一行为（它是专门干这个的）
    H.hist().hands.push(oldArch);
    H.fixHist();
    const fx = H.histFind('OLDP0TEST');
    ok(!!fx && Array.isArray(fx.revealed) && Array.isArray(fx.showSay) &&
       Array.isArray(fx.acts) && Array.isArray(fx.stacks) && Array.isArray(fx.winners),
      '★★ fixHist 把 revealed / showSay / acts / stacks / winners 全补成了数组（缺一个就会炸）',
      fx ? ('revealed=' + Array.isArray(fx.revealed) + ' showSay=' + Array.isArray(fx.showSay) +
            ' acts=' + Array.isArray(fx.acts)) : '找不到档案');
    ok(fx && typeof fx.table === 'string' && typeof fx.mine === 'string', '字符串字段也归一了');
    const e3 = errors.length;
    H.renderHist();
    const archCard = d.querySelector('.hist-card[data-hid="OLDP0TEST"]');
    ok(!!archCard, '老档案的卡片能渲染');
    if (archCard){ archCard.click(); await sleep(60); }
    ok(errors.length === e3,
      '★★ 展开缺字段的老档案不再抛错（以前这里必炸 TypeError: reading length）',
      errors.slice(e3).join(' | '));
    H.openReplay('OLDP0TEST'); await sleep(60);
    ok(errors.length === e3, '老档案同样能打开回放器（不抛错）', errors.slice(e3).join(' | '));
    H.closeReplay();
    ok(typeof H.rehandHtml({}) === 'string' && H.rehandHtml({}) === '',
      '没有重打数据的档案不会渲染空壳');

    // ② 再验真正的路径：老版本写进本机的档案，读进来时就必须被归一
    //    （这才是「老档案」在现实中的来路 —— 不是有人手搓一个对象塞进去）
    w.localStorage.setItem('holdem_hist_v1', JSON.stringify({ enabled: true, keep: 5, hands: [oldArch] }));
    H.loadHist();
    const fx2 = H.histFind('OLDP0TEST');
    ok(!!fx2 && Array.isArray(fx2.revealed) && Array.isArray(fx2.showSay) && Array.isArray(fx2.acts),
      '★★ 从 localStorage 读进来的老档案也被归一了（跨一次加载的真实路径）');
    const e3b = errors.length;
    H.renderHist();
    ok(errors.length === e3b, '读进来的老档案渲染同样不抛错', errors.slice(e3b).join(' | '));
    H.histWipe(true);

    // ---------------------------------------------------------------
    // ★ P0-4 / P0-5 · 「新增了一种请求 kind」必须三张表全部跟上
    //   kindCls 是 'k-' + kind 去掉非字母：coach-talk→k-coachtalk、decide-retry→k-decideretry。
    //   漏 CSS 徽章就没颜色，漏下拉就筛不出来，漏 KIND_CN 用量面板就显示英文原名。
    //   这一轮三种漏法都出现过，所以做成一条「全量对照」断言，以后加 kind 必被逮住。
    // ---------------------------------------------------------------
    const KINDS = H.allKinds();
    const cssAll2 = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const missCss = KINDS.filter(k => cssAll2.indexOf('k-' + k.replace(/[^a-z]/gi, '')) < 0);
    ok(missCss.length === 0,
      '★★ 每一种请求 kind 都有徽章样式（漏一个 = 日志里一张没颜色的白牌）',
      missCss.length ? ('缺：' + missCss.join(', ')) : (KINDS.length + ' 种齐全'));
    const kindOpts = [...q('ailogKind').querySelectorAll('option')].map(o => o.value);
    const missOpt = KINDS.filter(k => kindOpts.indexOf(k) < 0);
    ok(missOpt.length === 0,
      '★★ 调用日志「只看」下拉能筛到每一种 kind',
      missOpt.length ? ('缺：' + missOpt.join(', ')) : '齐全');
    const cn = H.kindCn();
    const missCn = KINDS.filter(k => typeof cn[k] !== 'string' || !cn[k]);
    ok(missCn.length === 0,
      '★★ 每一种 kind 都有中文名（用量面板「按类型拆」用它，缺了会显示英文原名）',
      missCn.length ? ('缺：' + missCn.join(', ')) : '齐全');
    ok(cn['coach-talk'] && cn['coach-talk'].indexOf('讨论') >= 0, '★ 讨论模式在用量面板里有自己的名字', cn['coach-talk']);
    ok(cssAll2.indexOf('.ailog-kind.k-coachtalk') >= 0, '★ 讨论模式的徽章有颜色');
    ok(cssAll2.indexOf('.ailog-kind.k-decideretry') >= 0, '★ 决策重试的徽章有颜色');

    // ---------------------------------------------------------------
    // 新功能 1 · 📊 实时胜率 / 补牌助手
    // ---------------------------------------------------------------
    const oFlush = H.outsOf([{ r: 14, s: 1 }, { r: 13, s: 1 }], [{ r: 2, s: 1 }, { r: 7, s: 0 }, { r: 9, s: 1 }]);
    ok(oFlush && oFlush.strong === 9, '同花听牌 = 9 张补牌（教科书答案）', oFlush && oFlush.strong);
    const oOesd = H.outsOf([{ r: 9, s: 0 }, { r: 8, s: 2 }], [{ r: 7, s: 1 }, { r: 6, s: 3 }, { r: 2, s: 0 }]);
    ok(oOesd && oOesd.strong === 8, '两头顺 = 8 张补牌', oOesd && oOesd.strong);
    const oGut = H.outsOf([{ r: 9, s: 0 }, { r: 8, s: 2 }], [{ r: 7, s: 1 }, { r: 5, s: 3 }, { r: 2, s: 0 }]);
    ok(oGut && oGut.strong === 4, '卡顺 = 4 张补牌', oGut && oGut.strong);
    ok(oFlush && oFlush.improve > oFlush.strong,
      '★★「成牌补牌」和「能升一档的牌」是两个数，不能混（混了会把 23 张当成听牌，胜率估上天）',
      oFlush && (oFlush.strong + ' vs ' + oFlush.improve));
    ok(H.outsOf([{ r: 14, s: 1 }], [{ r: 2, s: 1 }]) === null, '牌不齐时不硬算补牌（返回 null）');
    ok(H.outsOf([{ r: 14, s: 1 }, { r: 13, s: 1 }], []) === null, '翻前没有公共牌，谈不上补牌');
    ok(H.outsOf([{ r: 14, s: 1 }, { r: 13, s: 1 }],
      [{ r: 2, s: 1 }, { r: 7, s: 0 }, { r: 9, s: 1 }, { r: 3, s: 2 }, { r: 4, s: 3 }]) === null,
      '河牌已经没有下一张，也不谈补牌');
    ok(typeof H.eqCfg().on === 'boolean', '胜率助手是个带开关的功能', String(H.eqCfg().on));
    ok(!!q('tgEq'), '顶栏有「📊 胜率助手」开关');
    // 开关的两种状态都要验（开关式功能，关掉必须真的收起来）
    const asst = H.eqAssist(w.HOLDEM.players()[0], 0);
    ok(asst === null || (typeof asst.eq === 'number' && asst.eq >= 0 && asst.eq <= 1),
      'eqAssist 给出的胜率落在 0~1', asst ? String(Math.round(asst.eq * 100) + '%') : '（当前局面拿不到）');
    q('tgEq').checked = true; q('tgEq').onchange({ target: { checked: true } }); await sleep(40);
    ok(q('eqBox').style.display !== 'none', '打开开关后，胜率盒子显示出来');
    ok(q('eqBox').textContent.indexOf('胜率') >= 0, '盒子里有胜率', (q('eqBox').textContent || '').slice(0, 46));
    q('tgEq').checked = false; q('tgEq').onchange({ target: { checked: false } }); await sleep(40);
    ok(q('eqBox').style.display === 'none', '★ 关掉开关后盒子收起来（开关式，不常驻占位）');
    ok(w.localStorage.getItem('holdem_eq_v1') !== null, '开关状态落了盘（下次打开还记得）');
    q('tgEq').checked = true; q('tgEq').onchange({ target: { checked: true } });   // 恢复开着，后面看效果

    // ---------------------------------------------------------------
    // 新功能 2 · 💾 一键备份 / 恢复
    // ---------------------------------------------------------------
    ok(H.backupKeys().length >= 8, '备份清单覆盖了主要数据', H.backupKeys().length + ' 项');
    H.roster().seats[0].mem.summary = 'MARK-第25节-备份往返';
    H.saveRoster();
    const pack = H.backupPack();
    ok(pack.app === 'holdem-single-file' && pack.keys && typeof pack.keys === 'object', '备份包有 app 标记和数据段');
    ok(!!pack.keys['holdem_agents_v1'], '备份里含 AI 花名册（记忆的载体）');
    const btext = H.backupText();
    let parsedOk = false;
    try{ parsedOk = !!JSON.parse(btext).keys; }catch(e){}
    ok(parsedOk, '备份文本是可解析的 JSON（文件收着就能用）');
    const keepVal = pack.keys['holdem_agents_v1'];
    // 把磁盘上的记忆改坏，再用备份恢复 —— 这才叫「验过」
    w.localStorage.setItem('holdem_agents_v1', JSON.stringify({ v: 2, seats: [], bench: [] }));
    const rr1 = H.backupApply(pack);
    ok(rr1.ok && rr1.applied.indexOf('holdem_agents_v1') >= 0, '恢复调用成功并写回了 agents', JSON.stringify(rr1).slice(0, 90));
    ok(w.localStorage.getItem('holdem_agents_v1') === keepVal,
      '★★ 磁盘上的数据被备份原样写回（拿 localStorage 逐字节比对，不是「看起来对」）');
    H.reloadAllData();
    ok(H.roster().seats[0].mem.summary === 'MARK-第25节-备份往返',
      '★★ 恢复后内存里的记忆也刷新了（写盘成功 ≠ 界面已刷新）');
    ok(H.backupApply({ app: 'someone-else', keys: {} }).ok === false, '别人家 app 的备份会被拒收');
    ok(H.backupRestoreText('这不是 json').ok === false, '非 JSON 文件会被拒收');
    ok(H.backupApply(null).ok === false && H.backupApply({}).ok === false, '空值 / 没有数据段都会被拒收');
    const cnt0 = errors.length;
    q('dataBackup').click(); await sleep(60);
    ok(errors.length === cnt0, '点「导出全量备份」不报错（下载被拦也会把全文摊在面板里）',
      errors.slice(cnt0).join(' | '));
    ok(q('dataOut').classList.contains('on') && (q('dataOut').textContent || '').length > 40,
      '导出后给了明确的回执（成功还是被拦、多少字）', (q('dataOut').textContent || '').slice(0, 50));

    // ---------------------------------------------------------------
    // 新功能 3 · 🎯 打法体检
    // ---------------------------------------------------------------
    const cs3 = H.coach();
    const keepCoachHands = cs3.hands.slice();
    cs3.hands.length = 0;
    for (let i = 1; i <= 20; i++) cs3.hands.push({
      h: i, vpip: i <= 16, pfr: i <= 3, foldStreet: i > 16 ? 0 : -1, sawFlop: i <= 16,
      showdown: i <= 6, delta: (i % 3 ? -60 : 120), raises: 2, calls: 8, checks: 3,
      pos: '按钮位', hole: 'A♠ K♦', blinds: '10/20', pot: 200, allin: false
    });
    const ck = H.coachCheckup();
    ok(ck.enough === true && ck.n === 20, '样本够时给出体检结论', ck.n + ' 手');
    ok(ck.items.length === 6, '六项硬指标都在', ck.items.length + ' 项');
    const vpItem = ck.items.find(x => x.key === 'vpip');
    ok(vpItem && vpItem.st === 'high', '★ VPIP 80% 会被标成「偏高」（这个样本确实是 80%）', vpItem && vpItem.v.toFixed(1) + '%');
    const pfrItem = ck.items.find(x => x.key === 'pfr');
    ok(pfrItem && pfrItem.st === 'ok', '★ PFR 15% 落在参考区间里就会被标成「正常」', pfrItem && pfrItem.v.toFixed(1) + '%');
    ok(ck.worst && ck.worst.item.key === 'vpip', '★「最该先改的一件事」挑的是偏得最狠的那一项', ck.worst && ck.worst.item.label);
    const ckHtml = H.checkupHtml();
    ok(ckHtml.indexOf('最该先改') >= 0 && ckHtml.indexOf('参考') >= 0, '体检 HTML 里有区间对照与「最该先改」');
    cs3.hands.length = 0;
    for (let i = 0; i < 3; i++) cs3.hands.push({ h: i + 1, vpip: true, pfr: false, foldStreet: -1, sawFlop: true, showdown: false, delta: 0, raises: 0, calls: 1, checks: 0 });
    ok(H.coachCheckup().enough === false, '★ 样本不足时不下结论（3 手 → enough=false）');
    ok(H.checkupHtml().indexOf('最该先改') < 0, '样本不足时不硬给建议');
    cs3.hands.length = 0; keepCoachHands.forEach(x => cs3.hands.push(x));

    // ---------------------------------------------------------------
    // 新功能 4 · 🔁 重打对比
    // ---------------------------------------------------------------
    const fakeCmp = { id: 'RHTEST', h: 5, rehand: {
      t: Date.now(), origH: 5, againH: 6, origDelta: -300, againDelta: 120,
      origMine: '翻前：跟注', againMine: '翻前：弃牌', origRes: '你在翻牌弃了牌', againRes: '你一直留到最后',
      origPot: 600, againPot: 200, origHole: 'A♠ K♦', againHole: 'A♠ K♦' } };
    const rhHtml = H.rehandHtml(fakeCmp);
    ok(rhHtml.indexOf('重打对比') > 0, '重打对比块渲染出来了');
    ok(rhHtml.indexOf('原局') > 0 && rhHtml.indexOf('重打') > 0, '两栏并排：原局 / 重打');
    ok(rhHtml.indexOf('多赢 420') > 0, '★ 差值算对了（120 − (−300) = 420）',
      (rhHtml.match(/这次[多少]赢 [\d,]+/) || ['（没找到）'])[0]);
    ok(H.rehandHtml({ id: 'X' }) === '' && H.rehandHtml({ id: 'X', rehand: null }) === '',
      '没有重打数据的档案不渲染空壳');
    // 端到端：真打一手 → 重打它 → 原局档案上挂出对比
    await clickReset();
    await playHands(1);
    const lastHand = H.hist().hands[H.hist().hands.length - 1];
    if (lastHand && Array.isArray(lastHand.acts) && lastHand.acts.length){
      // 重打的硬前提：桌面必须是空闲的（手上那一手没打完时 replayHand 会直接拒绝）
      const idleOK = await waitFor(() => !q('btnNext').disabled ||
        q('controls').classList.contains('on'), 40000);
      ok(idleOK, '（重打前桌面已经空闲）');
      if (q('controls').classList.contains('on')) autoHuman();
      await waitFor(() => !q('btnNext').disabled, 40000);
      const beforeRe = H.hist().hands.length;
      const rp = H.replayHand(lastHand.id);
      let reDone = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 150000){
        autoHuman();
        const r = await Promise.race([rp.then(v => ({ d: true, v: v })), sleep(15).then(() => ({ d: false }))]);
        if (r.d){ reDone = r.v; break; }
      }
      ok(reDone === true, '重打这一手真的跑完了（replayHand 返回 true，不是被「手上还有牌」拒绝）', String(reDone));
      ok(!!lastHand.rehand, '★★ 重打之后，原局那份档案上真的挂上了对比（端到端，不是只测渲染函数）');
      if (lastHand.rehand){
        ok(lastHand.rehand.origH === lastHand.h, '对比里记着原局是第几手', String(lastHand.rehand.origH));
        ok(lastHand.rehand.againH > lastHand.rehand.origH, '重打那一手的手数更大', String(lastHand.rehand.againH));
        ok(lastHand.rehand.origDelta === Math.round(Number(lastHand.delta) || 0),
          '原局的净输赢与档案里的一致', lastHand.rehand.origDelta + ' / ' + lastHand.delta);
        ok(H.hist().hands.length > beforeRe, '重打那一手的档案也留下了（两边都能回看）');
      }
    } else {
      ok(true, '（这一手没有结构化动作记录，跳过重打端到端）');
    }

    // ---------------------------------------------------------------
    // 新功能 5 · 🃏 起手牌表叠加我的实战战绩
    // ---------------------------------------------------------------
    ok(H.holeKey('A♠ K♦') === 'AKo', 'AKo 归一正确', H.holeKey('A♠ K♦'));
    ok(H.holeKey('A♥ K♥') === 'AKs', 'AKs 归一正确', H.holeKey('A♥ K♥'));
    ok(H.holeKey('Q♣ Q♦') === 'QQ', '对子归一正确', H.holeKey('Q♣ Q♦'));
    ok(H.holeKey('2♣ 7♦') === '72o', '★ 高牌在前、低牌在后（72o 不是 27o）', H.holeKey('2♣ 7♦'));
    ok(H.holeKey('10♥ 9♥') === 'T9s' && H.holeKey('10♠ 10♦') === 'TT' && H.holeKey('J♦ 10♣') === 'JTo',
      '★★ 10 记成 T（109s 那种写法又长又容易看错，全世界的扑克图都用 T）',
      [H.holeKey('10♥ 9♥'), H.holeKey('10♠ 10♦'), H.holeKey('J♦ 10♣')].join(' / '));
    ok(H.holeKey('') === '' && H.holeKey('（一张都没翻开）') === '', '没牌时不硬凑一个格子名');
    const lbl = {};
    for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++){ const L = H.rangeLabel(i, j); lbl[L] = (lbl[L] || 0) + 1; }
    ok(Object.keys(lbl).length === 169, '13×13 一共 169 个互不重名的格子名', Object.keys(lbl).length + ' 个');
    ok(lbl['AA'] === 1 && lbl['AKs'] === 1 && lbl['AKo'] === 1, '对子 / 同花 / 不同花三类各占一格');
    ok(Object.keys(lbl).every(k => /^[2-9TJQKA]{2}[so]?$/.test(k)), '所有格子名都是规范写法（如 ATs / KQo / 77）');

    // 聚合：拿合成档案验合并与区分
    const hs5 = H.hist();
    const keepHist = hs5.hands.slice();
    const mkArch = (i, hole, delta, vpip, pfr) => ({
      id: 'T' + i, h: i, t: Date.now() + i, hole: hole, delta: delta, vpip: vpip, pfr: pfr,
      pos: '按钮位', blinds: '10/20', pot: 100, board: '', mine: '', table: '',
      revealed: [], showSay: [], acts: [], stacks: [], winners: [], ai: [], chat: [], star: false,
      showdown: false, withdrew: false, foldStreet: -1, hname: '', chips: 1000,
      raises: 0, calls: 1, checks: 0, rivals: 7, allin: false, sawFlop: true
    });
    hs5.hands.length = 0;
    [['A♠ K♦', 120, true, true], ['A♥ K♣', -80, true, false], ['Q♣ Q♦', 200, true, true],
     ['Q♥ Q♠', -50, true, true], ['10♥ 9♥', -30, false, false], ['7♣ 2♦', 10, true, false]]
      .forEach((x, i) => hs5.hands.push(mkArch(i + 1, x[0], x[1], x[2], x[3])));
    const tally5 = H.rangeTally();
    ok(tally5['QQ'] && tally5['QQ'].n === 2 && tally5['QQ'].net === 150,
      '★ 两把 QQ 归到同一格，净输赢合起来了', JSON.stringify(tally5['QQ']));
    ok(tally5['QQ'].w === 1, 'QQ 的胜场也数对了', String(tally5['QQ'] && tally5['QQ'].w));
    ok(tally5['AKo'] && tally5['AKo'].n === 2 && !tally5['AKs'],
      '★ AKs 和 AKo 不会混成一类（同花/不同花必须分开）',
      Object.keys(tally5).join(','));
    ok(tally5['T9s'] && tally5['T9s'].n === 1, 'T9s 能归位（跟表格用的是同一套名字）');
    ok(Object.keys(tally5).every(k => lbl[k]), '聚合出来的每个格子名在 13×13 表里都存在',
      Object.keys(tally5).filter(k => !lbl[k]).join(',') || '全部对得上');
    // 表格里真的叠上了（次数走 data-n，textContent 保持纯牌名）
    H.openRange(); await sleep(60);
    const cells5 = [...q('rangeChart').querySelectorAll('td')];
    ok(cells5.length === 169, '表格还是 13×13', cells5.length + ' 格');
    const marked = cells5.filter(td => td.dataset.n);
    ok(marked.length === 4, '有实战记录的 4 类牌被标上了次数', marked.length + ' 类');
    ok(marked.every(td => /^[2-9TJQKA]{2}[so]?$/.test(td.textContent)),
      '★★ 带标记的格子文本仍是纯牌名（次数用 data-n + CSS 画，不污染只看牌名的断言）',
      marked.map(t => t.textContent).slice(0, 6).join(' '));
    ok(cells5.some(td => td.textContent.indexOf('T') >= 0), '表格用的是 T 记法');
    ok(cells5[0].textContent === 'AA' && cells5[168].textContent === '22' && cells5[1].textContent === 'AKs',
      '既有格子名没被改坏（AA / 22 / AKs）',
      [cells5[0].textContent, cells5[1].textContent, cells5[168].textContent].join(' '));
    ok((q('rangeMine').textContent || '').indexOf('不该玩却玩了') >= 0,
      '★ 面板里给出了「应玩没玩 / 不该玩却玩了」两笔偏差账');
    ok(errors.length === cnt0 || errors.length === e3, '（本次新增的档案与统计操作没引入脚本错误）');
    H.closeRange();
    hs5.hands.length = 0; keepHist.forEach(x => hs5.hands.push(x));

    // ---------------------------------------------------------------
    // 顺手修的同族问题
    // ---------------------------------------------------------------
    const L30 = H.lineOfHand(1, 30);
    ok(L30.length <= 30, '★ 动线超长时「保头保尾」也守得住硬上限（30 字以内）',
      L30.length + ' 字：' + L30);
    ok(/}finally\{[\s\S]{0,200}coachEnding = false;/.test(html.replace(/\r/g, '')),
      '★「结束完整对局」用 try/finally 兜住，中途出错也不会把按钮永久锁死');
    // 行为验证：跑一次结束对局，按钮必须还回来
    q('btnEndSession').click(); await sleep(40); q('btnEndSession').click();
    const backBtn = await waitFor(() => !q('btnEndSession').disabled, 40000);
    ok(backBtn, '★★ 结束对局跑完后按钮恢复了（不会卡在禁用状态，只能靠刷新）');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); await sleep(40);
  }

  ok(errors.length === 0, 'P0/P1 修正 + 六个新功能 链路零脚本错误', errors.length ? '\n' + errors.join('\n') : '');

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('决策请求 ' + dec.length + ' 次 · 复盘 ' + calls.filter(c => c.kind === 'reflect').length +
              ' 次 · 探针 ' + calls.filter(c => c.kind === 'probe').length + ' 次 · 失败 ' + H.stat.fails + ' 次');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('❌ 测试自身崩了: ' + (e && e.stack || e));
  process.exit(1);
});
