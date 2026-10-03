/* =========================================================================
   第二十八轮自检 —— 🏆 赢了也要能说话

   用户反馈（2026-10-02）：
       「赢牌的时候也可以讲话」

   病根：全桌只有**一条** AI 调用入口 —— aiDecideLLM（轮到你出手）。
        settle() 从头到尾一次 AI 都不问：谁赢、赢多少、什么牌型，
        全是程序算完直接 log 一行。于是「赢了钱的人一声不吭」。

   本自检守三件事，全部走**真实链路**，不自己手搓字符串去比：
     ① 门槛对：只有「在用大脑的 AI 座位」才发；关掉开关 / 赢家是真人 / 大脑没就绪 → 一次都不发；
     ② 话真的说出口了：战报多一行、场上话记一条、配音收得到（两头都抓 ——
        送合成的带标记，给人眼的剥干净）；
     ③ 真的长在结算上：直接调 settle()，折牌独赢与摊牌两条分支都要能说。
   ========================================================================= */
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

/* ---------- 可控播放的 AudioContext 假件（沿用开口自检那一套） ---------- */
function makeCtlAudio() {
  const made = { playing: [] };
  const param = () => ({
    value: 1, setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }
  });
  const C = function () {
    this.state = 'running';
    this.currentTime = 0; this.sampleRate = 48000;
    this.destination = { connect() { }, disconnect() { } };
    this.resume = function () { };
    this.createGain = () => ({ gain: param(), connect() { return this; }, disconnect() { } });
    this.decodeAudioData = async () => ({ duration: 6 });
    this.createBufferSource = () => {
      const s = {
        buffer: null, onended: null,
        connect() { return this; }, disconnect() { },
        start() { made.playing.push(s); },
        stop() { if (s.onended) { const f = s.onended; setTimeout(() => { try { f(); } catch (e) { } }, 0); } }
      };
      return s;
    };
  };
  const ended = () => {
    for (let i = made.playing.length - 1; i >= 0; i--) {
      const s = made.playing[i];
      if (s && s.onended) { const f = s.onended; s.onended = null; f(); return true; }
    }
    return false;
  };
  return { C, made, ended, reset: () => { made.playing.length = 0; } };
}

let AUDIO = null;

function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => { });
  let seed = 20261002 >>> 0;
  const audio = makeCtlAudio();
  AUDIO = audio;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      window.AudioContext = audio.C;
      window.AbortController = globalThis.AbortController;
      window.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
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
  return { dom, w: dom.window, d: dom.window.document, errors, audio };
}

/* ---------- 把请求分开记录：LLM（按提示词认种类）与配音 ---------- */
const WIN_REPLY = { say: ['这手我收了。[laughter]'], voice: 1, tone: 'glad' };

function wire(A) {
  const llm = [], tts = [];
  A.w.fetch = async (url, opt) => {
    let body = {};
    try { body = JSON.parse(opt.body); } catch (e) { }
    const msgs = body.messages;
    if (Array.isArray(msgs)) {                       // 走的是大模型
      const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
      const usr = msgs.filter(m => m.role === 'user').map(m => m.content).join('\n');
      const kind = (sys.indexOf('你赢下了刚才这一手') >= 0) ? 'win'
                 : (sys.indexOf('"action"') >= 0) ? 'decide' : 'other';
      llm.push({ kind, sys, usr, body });
      const text = kind === 'win'
        ? JSON.stringify(WIN_REPLY)
        : JSON.stringify({ action: 'call', read: 'R', think: 'T', say: 'D-SAY' });
      return { ok: true, status: 200, json: async () => ({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      }) };
    }
    tts.push(body);                                  // 走的是配音服务
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  return { llm, tts };
}

// 配音假件的 start() 不会自己收尾，闸门会一直挂着 —— 一边等一边替它按「播完了」
async function pumpUntil(pr, ms) {
  let done = false;
  pr.then(() => { done = true; }, () => { done = true; });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < (ms || 9000)) {
    if (AUDIO && AUDIO.made.playing.length) AUDIO.ended();
    await sleep(15);
  }
  return pr;
}

// 让大脑「在线」，但一个字节都不会真的出去（fetch 全被 wire 拦了）
function brainOn(H) {
  H.cfg.enabled = true;
  H.cfg.apiKey = 'sk-test-r28';
  H.cfg.baseURL = 'https://api.deepseek.com';
  H.cfg.seats = 7;
}

// 摆成「某人独赢（其余全弃）」—— 走 settle 的折牌分支
function setupFoldWin(H, winnerId) {
  const P = H.players();
  for (const p of P) {
    p.folded = true; p.totalBet = 0; p.allIn = false; p.chips = 1000;
    p.reveal = false; p.winner = false;
  }
  P[0].totalBet = 10;                        // 人类丢的盲注（凑出「有底池」）
  P[winnerId].folded = false;
  P[winnerId].totalBet = 30;
  H.board().length = 0;
  return P[winnerId];
}

// 摆成「两人走到摊牌」—— 走 settle 的摊牌分支；返回牌更大的那个
function setupShowdown(H, aId, bId) {
  const P = H.players();
  for (const p of P) {
    p.folded = true; p.totalBet = 0; p.allIn = false; p.chips = 1000;
    p.reveal = false; p.winner = false; p.bet = 0;
  }
  P[aId].folded = false; P[bId].folded = false;
  P[aId].totalBet = 50; P[bId].totalBet = 50;
  const bd = H.board();
  bd.length = 0;
  bd.push({ r: 14, s: 0 }, { r: 13, s: 1 }, { r: 7, s: 2 }, { r: 3, s: 3 }, { r: 2, s: 0 });
  P[aId].hole = [{ r: 14, s: 1 }, { r: 14, s: 2 }];   // 三条 A —— 赢
  P[bId].hole = [{ r: 13, s: 0 }, { r: 12, s: 0 }];   // 一对 K
  return P[aId];
}

const logHas = (A, s) => [...A.d.querySelectorAll('#log .li')].some(x => x.textContent.indexOf(s) >= 0);

(async () => {

  // ============================================================ 1
  section('1. 门槛：谁才配「赢了说一句」');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    ok('页面起得来，没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    ok('导出里有赢牌发言接口',
      !!(H && H.winTalkOn && H.winAsk && H.winSpeak && H.winSys && H.winFacts && H.settleHand && H.flushSays), 'ok');

    const me = H.players()[0], ai = H.players()[1];
    ok('默认是开的（新行为默认生效）', H.gamecfg().winSay === true);
    ok('大脑没就绪 → 不发（不能白花一次请求）', H.winTalkOn(ai) === false);
    brainOn(H);
    ok('★ 大脑就绪 + AI 座位 → 发', H.winTalkOn(ai) === true);
    ok('★★ 真人玩家不发（他自己会说，不用替他开口）', H.winTalkOn(me) === false);

    H.gamecfg().winSay = false;
    ok('★ 开关关掉 → 不发', H.winTalkOn(ai) === false);
    H.gamecfg().winSay = true;

    // ⚠ brainOn 的席位下限是 1（Math.max(1, …)），所以「关到 0」照样有一个在线座位 ——
    //   要验「不在在线席位里」得挑一个 id 超出 seats 的座位。
    H.cfg.seats = 1;
    ok('★ 这个人不在用大脑的席位里 → 不发', H.winTalkOn(H.players()[2]) === false);
    ok('★ 而在线的那个座位照样发（不是把整条路关死了）', H.winTalkOn(H.players()[1]) === true);
    H.cfg.seats = 7;

    ai.folded = true;
    ok('弃牌的人不会赢，也不会发言', H.winTalkOn(ai) === false);
    ai.folded = false;

    A.w.close();
  }

  // ============================================================ 2
  section('2. 提示词：只说话，不问动作 / 不要复盘');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const ai = H.players()[1];
    const sys = H.winSys(ai);

    ok('★ 带着这个人的人格（同一副嘴）', sys.indexOf('你叫') >= 0 && sys.indexOf('你叫' + ai.name) >= 0);
    ok('★ 带着他的长期记忆（说话方式要跟经历一致）', sys.indexOf('长期总结') >= 0);
    ok('★★ 明确写着「你赢了」这一刻的处境', sys.indexOf('刚刚结束 · 你赢了') >= 0);
    ok('★★ 输出契约只有三个字段（不是 decide 那份五字段契约）',
      sys.indexOf('"say"') >= 0 && sys.indexOf('"voice"') >= 0 && sys.indexOf('"tone"') >= 0);
    ok('★★ 不问动作：契约里没有 "action"', sys.indexOf('"action"') < 0);
    ok('★★ 不问读牌 / 心里话：契约里没有 read / think',
      sys.indexOf('"read"') < 0 && sys.indexOf('"think"') < 0);
    ok('★ 明确禁止复盘和报数字', sys.indexOf('别复盘') >= 0 && sys.indexOf('别报数字') >= 0);
    ok('★ 挡住「一赢就吹」（不然每手一个腔调，假）', sys.indexOf('一赢就吹') >= 0);
    ok('★ 口气的四个可选值照旧给全（slow 于第二十九轮下架）',
      sys.indexOf('hot 恼火') >= 0 && sys.indexOf('glad 得意') >= 0 &&
      sys.indexOf('down 丧气') >= 0 && sys.indexOf('quick 急促') >= 0 &&
      sys.indexOf('slow') < 0);
    ok('★ 副语言标记的说明没丢（第二十五轮的东西）',
      sys.indexOf('[laughter]') >= 0 && sys.indexOf('[sigh]') >= 0 && sys.indexOf('[breath]') >= 0);
    ok('★ 破折号禁用令照旧在（第二十五轮挖出的坑）', sys.indexOf('别用破折号') >= 0);

    const w = H.players()[1];
    const u = H.winFacts(w, {
      amt: 1234, hand: '三条', hole: 'A♥ A♦', board: 'A♠ K♦ 7♣ 3♥ 2♠',
      revealed: true, others: '绯罗刹、魅羽·J'
    });
    ok('★ 事实里写了赢了多少（数字由程序给，不让它算）', u.indexOf('你赢了 1,234') >= 0);
    ok('★ 写了牌型', u.indexOf('三条') >= 0);
    ok('★ 写了底牌与公共牌', u.indexOf('A♥ A♦') >= 0 && u.indexOf('A♠ K♦') >= 0);
    ok('★ 摊牌 / 没摊牌说清楚（决定它该不该提自己的牌）', u.indexOf('亮给全桌看了') >= 0);
    const u2 = H.winFacts(w, { amt: 100, hand: '', hole: 'K♠ Q♠', board: '', revealed: false, others: '' });
    ok('★ 没摊牌时明说「他们不知道你手里是什么」', u2.indexOf('他们不知道你手里是什么') >= 0);
    ok('★ 没牌型 / 没公共牌时不会留空标签', u2.indexOf('牌型是【】') < 0 && u2.indexOf('公共牌：。') < 0);

    A.w.close();
  }

  // ============================================================ 3
  section('3. 说出来 = 同一条出口（战报 / 场上话 / 配音）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const R = wire(A);
    const ai = H.players()[1];
    H.ttsSetOn(true);
    await sleep(20);

    const before = H.say().length;
    await pumpUntil(H.winSpeak(ai, { say: ['这手我收了。', '谢了。'], voice: 1, tone: 'glad' }, ''));

    ok('★★ 战报里多了「💬 名字：…」的行',
      logHas(A, '💬 ' + ai.name + '：这手我收了。'), '');
    ok('★★ 场上话记录也记了（别人下次看得到）',
      H.say().length === before + 2 &&
      H.say().slice(-2).every(x => x.name === ai.name && x.say),
      (H.say().length - before) + ' 条');
    ok('★★ 要念的那句真的送去了配音（两头都抓）',
      R.tts.length === 1 && R.tts[0].text === '这手我收了。谢了。',
      JSON.stringify(R.tts.map(x => x.text)));
    ok('★ 口气跟着 AI 给的走', R.tts.length === 1 && R.tts[0].tone === 'glad',
      R.tts[0] && R.tts[0].tone);
    ok('★ 送合成的是整段（沿用第二十七轮的口径，不是一句一次）', R.tts.length === 1);

    // 音效标记：给耳朵的带、给人眼的剥 —— 这条口径必须一路继承下来
    R.tts.length = 0;
    const b2 = H.say().length;
    await pumpUntil(H.winSpeak(ai, { say: ['哈[laughter]哈。'], voice: 1, tone: '' }, ''));
    ok('★★ 标记分两份：配音收到带标记的原文', R.tts.length === 1 && R.tts[0].text === '哈[laughter]哈。',
      JSON.stringify(R.tts.map(x => x.text)));
    ok('★★ 给人眼看的是剥干净的', H.say().slice(b2).some(x => x.say === '哈哈。'),
      JSON.stringify(H.say().slice(b2).map(x => x.say)));

    // 不标要念（voice=0）：上战报，但一个字都不送去配音
    R.tts.length = 0;
    await H.winSpeak(ai, { say: ['随便说说。'], voice: 0, tone: '' }, '');
    await sleep(60);
    ok('★ 没标要念 → 配音一次请求都不发', R.tts.length === 0, R.tts.length + ' 次');
    ok('★ 但战报照样看得见', logHas(A, '💬 ' + ai.name + '：随便说说。'));

    // AI 没给口气时的兜底
    R.tts.length = 0;
    await pumpUntil(H.winSpeak(ai, { say: ['赢了。'], voice: 1, tone: '' }, 'glad'));
    ok('★ AI 没给口气 → 用兜底（大赢给 glad）', R.tts.length === 1 && R.tts[0].tone === 'glad',
      R.tts[0] && R.tts[0].tone);
    R.tts.length = 0;
    await pumpUntil(H.winSpeak(ai, { say: ['赢了。'], voice: 1, tone: 'down' }, 'glad'));
    ok('★ AI 自己给了口气 → AI 优先，不被兜底盖掉', R.tts.length === 1 && R.tts[0].tone === 'down',
      R.tts[0] && R.tts[0].tone);

    ok('整段没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  // ============================================================ 4
  section('4. ★★★ 真实结算 · 独赢（其余全弃）：赢家真的开口了');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const R = wire(A);
    brainOn(H);
    H.ttsSetOn(true);
    await sleep(20);

    const w = setupFoldWin(H, 1);
    const pot = 40;
    H.board().length = 0;
    await pumpUntil(H.settleHand());

    const win = R.llm.filter(c => c.kind === 'win');
    ok('★★★ 结算时真的发了一次「赢牌发言」请求（kind=win）', win.length === 1, win.length + ' 次');
    ok('★★ 带的是赢家自己的提示词（不是别人的）',
      win.length === 1 && win[0].sys.indexOf('你叫' + w.name) >= 0, w.name);
    ok('★★ 事实里写了这一手赢了多少钱', win.length === 1 && win[0].usr.indexOf('赢了 ' + pot) >= 0,
      win.length ? JSON.stringify(win[0].usr.split('\n')[1]) : '');
    ok('★ 明说「没人跟到最后、你没亮牌」',
      win.length === 1 && win[0].usr.indexOf('没有亮牌') >= 0);
    ok('★★ 请求里只有说出去的那句话，一个字都不少（走的是真实链路上的请求体）',
      JSON.stringify(R.tts.map(x => x.text)) === JSON.stringify(['这手我收了。[laughter]']),
      JSON.stringify(R.tts.map(x => x.text)));
    ok('★★ 战报里真的出现了赢家的话（剥干净的版本）',
      logHas(A, '💬 ' + w.name + '：这手我收了。'));
    ok('★★ 场上话记录里有这一句', H.say().some(x => x.seat === w.id && x.say === '这手我收了。'));
    ok('★ 战报里没有把标记露给人看', !logHas(A, '[laughter]'));
    ok('★ 赢的钱真的到账了（不能只顾着说话忘了发钱）', w.chips === 1000 + pot,
      w.chips + ' 筹码');
    ok('★ 调用日志里能翻到这条 win（复盘要看得见）',
      H.ailog().some(r => r.kind === 'win'), H.ailog().length + ' 条日志');
    ok('★ 结算流程走完了（没被发言卡住）',
      A.d.getElementById('btnNext').disabled === false || !!A.d.getElementById('resultBar').classList.contains('on'));

    ok('整段没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  // ============================================================ 5
  section('5. ★★★ 真实结算 · 摊牌：收得最多的那位开口，牌型写对');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const R = wire(A);
    brainOn(H);
    H.ttsSetOn(true);
    await sleep(20);

    const w = setupShowdown(H, 1, 2);
    await pumpUntil(H.settleHand(), 12000);

    const win = R.llm.filter(c => c.kind === 'win');
    ok('★★★ 摊牌结算也会发「赢牌发言」请求', win.length === 1, win.length + ' 次');
    ok('★★ 发言的是牌更大的那位', win.length === 1 && win[0].sys.indexOf('你叫' + w.name) >= 0, w.name);
    ok('★★ 牌型算对了（三条 A 赢一对 K）', win.length === 1 && win[0].usr.indexOf('三条') >= 0,
      win.length ? (win[0].usr.match(/牌型是【([^】]*)】/) || [])[1] : '');
    ok('★★ 公共牌写进了事实（它要能提「牌面」才像真的赢家）',
      win.length === 1 && win[0].usr.indexOf('A♠ K♥ 7♦ 3♣ 2♠') >= 0);
    ok('★★ 明确告诉它「已经亮给全桌看了」',
      win.length === 1 && win[0].usr.indexOf('亮给全桌看了') >= 0);
    ok('★★ 战报里出现了赢家的话', logHas(A, '💬 ' + w.name + '：这手我收了。'));
    ok('★ 输家的名字也在事实里（它可能想招呼一句）',
      win.length === 1 && win[0].usr.indexOf(H.players()[2].name) >= 0);

    ok('整段没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  // ============================================================ 6
  section('6. 反向：不该发的时候一次都不发');
  {
    // 6a 开关关掉（大脑在线，唯一挡住它的就是那个开关 —— 否则测的是别的东西）
    let A = boot(null);
    await sleep(340);
    let H = A.w.HOLDEM, R = wire(A);
    brainOn(H);
    H.gamecfg().winSay = false;
    setupFoldWin(H, 1);
    await H.settleHand();
    ok('★★ 开关关着 → win 请求 0 次（但牌局照常打完）',
      R.llm.filter(c => c.kind === 'win').length === 0);
    ok('★ 而且一句多余的话都没上战报（没有「赢了…」的发言行）',
      [...A.d.querySelectorAll('#log .li')].filter(x => x.textContent.indexOf('💬') >= 0).length === 0);
    A.w.close();

    // 6b 赢家是真人
    A = boot(null);
    await sleep(340);
    H = A.w.HOLDEM; R = wire(A);
    brainOn(H);
    const me = setupFoldWin(H, 0);
    await H.settleHand();
    ok('★★ 赢家是真人玩家 → 一次都不发（我们不替他说话）',
      R.llm.filter(c => c.kind === 'win').length === 0);
    ok('★ 真人照样真的赢了钱', me.chips > 1000, me.chips + ' 筹码');
    A.w.close();

    // 6c 大脑没就绪
    A = boot(null);
    await sleep(340);
    H = A.w.HOLDEM; R = wire(A);
    setupFoldWin(H, 1);
    await H.settleHand();
    ok('★★ 大脑没连上 → 一次都不发，也不炸', R.llm.length === 0 && A.errors.length === 0,
      R.llm.length + ' 次请求 / ' + A.errors.length + ' 个错误');
    A.w.close();

    // 6d 模型回了个看不懂的东西 → 静默跳过，不能把牌局拖死
    A = boot(null);
    await sleep(340);
    H = A.w.HOLDEM;
    brainOn(H);
    A.w.fetch = async (url, opt) => {
      let body = {}; try { body = JSON.parse(opt.body); } catch (e) { }
      if (Array.isArray(body.messages)) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    setupFoldWin(H, 1);
    let threw = null;
    try { await pumpUntil(H.settleHand(), 4000); } catch (e) { threw = String(e && e.message || e); }
    ok('★★ 模型报错 → 静默跳过，不抛出去（牌局不能被一句话拖死）',
      threw === null, threw || '');
    ok('★ 结算还是走完了', !!A.d.getElementById('resultBar'));
    A.w.close();
  }

  // ============================================================ 7
  section('7. 设置项：跨一次页面加载还在');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    A.d.getElementById('btnAISet').click();
    await sleep(10);
    ok('★ 面板上有「赢了也说一句」这个开关', !!A.d.getElementById('cfgWinSay'));
    ok('★ 打开面板时回填的是当前状态（默认勾上）',
      A.d.getElementById('cfgWinSay').checked === true);

    A.d.getElementById('cfgWinSay').checked = false;
    A.d.getElementById('aiSave').onclick();
    ok('★ 保存后配置真的变了', H.gamecfg().winSay === false);
    ok('★ 并且写进了存档', (() => {
      const j = JSON.parse(A.w.localStorage.getItem('holdem_game_cfg_v1'));
      return j && j.winSay === false;
    })());

    const store = {};
    for (let i = 0; i < A.w.localStorage.length; i++) {
      const k = A.w.localStorage.key(i);
      store[k] = A.w.localStorage.getItem(k);
    }
    A.w.close();

    const B = boot(store);                 // ★ 跨一次页面加载才算验过
    await sleep(340);
    ok('★★ 跨页面：关着的还是关着的', B.w.HOLDEM.gamecfg().winSay === false);
    B.d.getElementById('btnAISet').click();
    await sleep(10);
    ok('★★ 跨页面：打开面板后控件就是上次存的（未勾选）',
      B.d.getElementById('cfgWinSay').checked === false);
    B.w.close();

    const C = boot({ holdem_game_cfg_v1: '{"sb":25,"bb":50}' });
    await sleep(340);
    ok('★★ 旧存档（根本没这个字段）→ 回落成默认开，不会变成 undefined',
      C.w.HOLDEM.gamecfg().winSay === true);
    C.w.close();
  }

  // ============================================================ 8
  section('8. 这条链一次都不许碰 Math.random（配音链的老铁律）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    wire(A);
    brainOn(H);
    H.ttsSetOn(true);
    await sleep(20);

    const real = A.w.Math.random;
    let hits = 0;
    A.w.Math.random = function () { hits++; return real.apply(this, arguments); };

    const ai = H.players()[1];
    await pumpUntil(H.winSpeak(ai, WIN_REPLY, 'glad'));
    await H.winFacts(ai, { amt: 500, hand: '两对', hole: 'A♠ A♦', board: 'K♠ Q♦ J♣ 3♥ 2♠', revealed: true, others: '绯罗刹' });
    // 连「问」这一步也过一遍（不真的发请求：先把它挡掉）
    A.w.fetch = async () => { throw new Error('不该真的发出去'); };
    await H.winAsk(ai, { amt: 500, hand: '两对', hole: 'A♠ A♦', board: '', revealed: false, others: '' });

    A.w.Math.random = real;
    ok('★★ 赢牌发言这条链（问 + 说 + 送配音）一次 Math.random 都没碰', hits === 0, hits + ' 次');

    A.w.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log('  第二十八轮自检（赢牌发言）：' + pass + ' 项通过，' + fail + ' 项失败');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检炸了:', e); process.exit(1); });
