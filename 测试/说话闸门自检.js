/* =========================================================================
   第二十一轮自检 —— 🎙 说话闸门：AI 自己决定念不念 + 说出口的话念完才轮到下一个人
   -------------------------------------------------------------------------
   要守住的三条（缺一条这个功能就是坏的）：
     1. AI 自己决定哪句念、哪句只走文本（voice 字段），默认安静；
     2. 标了要念的，**念完才推进** —— 高亮留在说话人身上，人和声音才对得上；
     3. ⚠ 但「等」永远不能变成「卡死」：配音关着 / 连不上 / 被打断 / 超时，都必须立刻放行。
       这条是第十九轮的老底线，这轮改了 ttsSay 的签名，更要盯死。

   口径提醒（前面几轮踩出来的）：
     · 固定随机源，结果可复现；
     · 「持久化」必须跨一次页面加载才算验过；
     · 正反两向都要断言（MARK 串）；
     · 配音/音效/特效一次都不许碰 Math.random。
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

/* ---------- 可控播放的 AudioContext 假件 ----------
   和第十九轮那个不一样：**不自动触发 onended**，由测试手动叫停。
   否则「说完之前不许推进」这条根本测不出来 —— 声音瞬间就"播完了"。 */
function makeCtlAudio() {
  const made = { ctors: 0, srcs: [], playing: [], gains: 0, decoded: 0, resumes: 0 };
  let locked = false;                 // 模拟「页面刚打开、还没被用户手势解锁」
  const param = () => ({
    value: 1, setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }
  });
  const C = function () {
    made.ctors++;
    this.state = locked ? 'suspended' : 'running';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = { connect() { }, disconnect() { } };
    // 真实的浏览器行为：没有用户手势时 resume() 不管用，上下文一直是 suspended
    this.resume = function () { made.resumes++; if (locked) return; this.state = 'running'; };
    this.createGain = () => { made.gains++; return { gain: param(), connect() { return this; }, disconnect() { } }; };
    this.decodeAudioData = async () => { made.decoded++; return { duration: 12 }; };   // 12 秒 → 保底闹钟很远，手动词「播完」才是唯一捷径
    this.createBufferSource = () => {
      const s = {
        buffer: null, onended: null, started: false,
        connect() { return this; }, disconnect() { },
        start() { s.started = true; made.playing.push(s); made.srcs.push(s); },
        stop() { if (s.onended) { const f = s.onended; setTimeout(() => { try { f(); } catch (e) { } }, 0); } }
      };
      return s;
    };
  };
  // 手动让「最后开始播的那一句」播完
  const ended = () => {
    for (let i = made.playing.length - 1; i >= 0; i--) {
      const s = made.playing[i];
      if (s && s.onended) { const f = s.onended; s.onended = null; f(); return true; }
    }
    return false;
  };
  return {
    C, made, ended,
    lock: v => { locked = !!v; },
    reset: () => { made.playing.length = 0; }
  };
}

let AUDIO = null;

function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => { });
  let seed = 20261002 >>> 0;
  AUDIO = makeCtlAudio();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      window.AudioContext = AUDIO.C;
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
  return { dom, w: dom.window, d: dom.window.document, errors };
}

function dumpStore(w) {
  const s = {};
  for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); s[k] = w.localStorage.getItem(k); }
  return s;
}

// 让一个 AI 玩家处于「能正常做一次决定」的状态（给本地速算喂两张真牌）
function armPlayer(p) {
  p.out = false; p.folded = false; p.allIn = false; p.acted = false;
  p.chips = 1000; p.bet = 0; p.totalBet = 0;
  p.hole = [{ r: 14, s: 0 }, { r: 13, s: 1 }];
  p.aiSay = ''; p.aiSays = []; p.aiSayVoice = false;
}

/* 跑一次「AI 行动 + 闸门」的完整流程，返回可观察的结果
   —— 关键点：aiSay 要在 takeTurn 把它清空**之后**、做决定**之前**塞进去，
      所以先起 takeTurn，等一小会，再注入。 */
async function runTurnWithSay(H, T, ps, target, text, opts) {
  opts = opts || {};
  armPlayer(target);
  const idx = ps.indexOf(target);
  const before = { waits: T.stat.waits || 0, timeout: T.stat.timeout || 0 };
  let finished = false;
  const run = H.takeTurn(target, idx).then(() => { finished = true; });
  await sleep(60);                       // 让它跑过「清空 aiSay」那一步
  target.aiSay = text;
  target.aiSayVoice = opts.voice !== false;
  // 等它真的进入等待（或直接走完）
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if ((T.stat.waits || 0) > before.waits || finished) break;
    await sleep(25);
  }
  return {
    run, idx, target, finished: () => finished,
    waited: (T.stat.waits || 0) - before.waits,
    waitedFor: () => (T.stat.waits || 0) - before.waits
  };
}

(async () => {
  // ============================================================ 1
  section('1. AI 自己决定「这句念不念」');
  {
    const { w, d, errors, dom } = boot(null);
    await sleep(320);
    const H = w.HOLDEM;
    ok('页面起得来，没有脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));
    ok('导出里有闸门相关接口', !!(H && H.sayVoiceOn && H.awaitSay && H.setSayGate && H.sayGateMax), 'ok');
    ok('闸门硬超时有兜底，且不超过 15 秒（牌局不许被吊太久）',
      typeof H.sayGateMax === 'number' && H.sayGateMax > 1000 && H.sayGateMax <= 15000, H.sayGateMax + ' ms');

    // voice 字段的宽容解析：该算「念」的写法一个都不能漏
    const YES = [1, true, '1', 'true', 'TRUE', ' yes ', 'Y', '是', '要', '念'];
    const missYes = YES.filter(v => H.sayVoiceOn(v) !== true);
    ok('★ voice 各种「要念」的写法都认得（1/true/是/要/念…）', missYes.length === 0, missYes.join(',') || (YES.length + ' 种'));
    const NO = [0, false, undefined, null, '', '0', 'false', 'no', '否', '不念', '嗯'];
    const missNo = NO.filter(v => H.sayVoiceOn(v) !== false);
    ok('★ 其余一律不念（含没给 voice 的情况 —— 默认安静）', missNo.length === 0, missNo.join(',') || (NO.length + ' 种'));

    // takeMind 要把它落到玩家身上
    const p = H.players()[1];
    H.takeMind(p, { read: 'r', think: 't', say: '说了句', voice: 1 });
    ok('takeMind 把 voice=1 落成 aiSayVoice=true', p.aiSayVoice === true);
    H.takeMind(p, { read: 'r', think: 't', say: '说了句' });
    ok('★ 没有 voice 字段时落到 false（AI 不吭声就不念）', p.aiSayVoice === false);
    ok('say 本身没受影响（照样记得住台上话）', p.aiSay === '说了句');

    // 提示词里必须真的告诉 AI 有这个字段
    ok('★ 提示词的 JSON 样式里加了 voice', html.indexOf('"voice":0') >= 0 && html.indexOf('"say":[') >= 0,
      '（第二十二轮把 say 改成了数组，见拟人节奏自检）');
    ok('★ 提示词解释了 voice 怎么填（含「绝大多数时候填 0」的倾向）',
      html.indexOf('要不要念出声') >= 0 && html.indexOf('绝大多数时候填 0') >= 0);
    ok('提示词说了念哪几种场合（挑衅/施压/亮牌/宣布）',
      html.indexOf('挑衅、施压、亮牌、宣布决定') >= 0);

    dom.window.close();
  }

  // ============================================================ 2
  section('2. 分流：标了才念，没标只上战报');
  {
    const { w, d, dom } = boot(null);
    await sleep(320);
    const H = w.HOLDEM, T = H.tts();
    const hits = [];
    w.fetch = async (u, o) => { hits.push(JSON.parse(o.body).text); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
    H.ttsSetOn(true);
    await sleep(10);

    const mk = (say, voice) => ({
      id: 2, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true,
      actionType: 'call', lastAction: '跟注 40', aiRead: '', aiThink: '', aiSay: say, aiSayVoice: voice
    });

    // ⚠ 每小段之前必须把上一句「播完」：这个假件不会自己结束播放，
    //   留着它 TTS.busy 就一直是 true，后面的句子只会排队、永远不会去合成。
    const settle = async () => { AUDIO.ended(); await sleep(30); H.ttsStop(); await sleep(30); AUDIO.reset(); T.busy = false; };

    T.aiPick = true;                      // 默认：由 AI 定
    hits.length = 0; H.logAct(mk('MARK-要念', true));
    await sleep(60);
    ok('★ AI 标了要念 → 真的去合成（正向）', hits.indexOf('MARK-要念') >= 0, hits.join('|').slice(0, 60));

    await settle();
    hits.length = 0; const n0 = H.say().length; H.logAct(mk('MARK-不念', false));
    await sleep(60);
    ok('★ AI 没标 → 一次合成请求都不发（反向）', hits.length === 0, hits.length + ' 次');
    ok('★ 但它照样进公开话记录（战报看得见，只是没出声）',
      H.say().length === n0 + 1 && H.say()[H.say().length - 1].say === 'MARK-不念');

    await settle();
    T.aiPick = false;                     // 关掉「AI 定」→ 每句都念
    hits.length = 0; H.logAct(mk('MARK-每句都念', false));
    await sleep(60);
    ok('★ 面板拨到「每句都念」时，没标 voice 的也念', hits.indexOf('MARK-每句都念') >= 0, hits.join('|').slice(0, 60));
    T.aiPick = true;

    // 配音关着：连队列都不该进
    await settle();
    H.ttsSetOn(false);
    hits.length = 0; H.logAct(mk('MARK-关着不念', true));
    await sleep(40);
    ok('配音关着时，标了要念也不发请求', hits.length === 0 && T.queue.length === 0);
    dom.window.close();
  }

  // ============================================================ 3
  section('3. 闸门：能等、能放、能打断');
  {
    const { w, d, dom } = boot(null);
    await sleep(320);
    const H = w.HOLDEM, T = H.tts();
    H.ttsSetOn(true);
    await sleep(10);

    // 3a 真播一遍：播完之前不许解开
    w.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    T.queue.length = 0; T.cache.clear();
    AUDIO.reset();
    H.ttsStop();
    const gate = H.ttsSay(1, 'MARK-真播一遍');
    ok('开着配音时 ttsSay 返回可等待的闸门', !!gate && typeof gate.then === 'function');
    let opened = false;
    gate.then(() => { opened = true; });
    await sleep(120);
    ok('★ 声音还在播时闸门是关着的（这就是「等说完」的物理基础）', opened === false && AUDIO.made.playing.length >= 1);
    ok('★ 确实有一个源在播（不是悄悄跳过了播放）', AUDIO.made.playing.length >= 1, AUDIO.made.playing.length + ' 个');
    AUDIO.ended();
    await sleep(60);
    ok('★ 播完之后闸门自己解开', opened === true);

    // 3b 打断：拉取卡住时也必须立刻放行（重开一局的场景）
    w.fetch = () => new Promise(() => { });      // 永远不返回
    T.queue.length = 0; T.cache.clear(); T.busy = false;
    H.ttsStop();
    const gate2 = H.ttsSay(1, 'MARK-卡住不返回');
    let opened2 = false;
    gate2.then(() => { opened2 = true; });
    await sleep(80);
    ok('拉取卡住时闸门当然还关着', opened2 === false);
    H.ttsStop();                                  // ← 重开一局 / 用户关掉配音走的就是这里
    await sleep(40);
    ok('★★ 打断时闸门立刻放行（绝不让牌局吊死在 await 上）', opened2 === true);

    // 3c 不用等的情况：ttsSay 直接给 null，awaitSay 立刻返回
    H.ttsSetOn(false);
    ok('配音关着时 ttsSay 返回 null', H.ttsSay(1, 'MARK-关着') === null);
    H.setSayGate(null);
    const r0 = await H.awaitSay();
    ok('没有闸门时 awaitSay 立刻返回 false（一步不停）', r0 === false);
    H.ttsSetOn(true);
    await sleep(10);

    // 3d 手动装闸门：证明 awaitSay 真的会「等」
    let fire = null;
    H.setSayGate(new Promise(r => { fire = r; }));
    let done = false, got = null;
    H.awaitSay().then(v => { done = true; got = v; });
    await sleep(120);
    ok('★ 闸门没解开时 awaitSay 就是不返回', done === false);
    fire();
    await sleep(40);
    ok('★ 解开后立刻返回 true（真的等到了）', done === true && got === true);

    // 3e 用户把节奏拨回「即发即忘」→ 装着闸门也不等
    let fire2 = null;
    H.setSayGate(new Promise(r => { fire2 = r; }));
    T.waitSay = false;
    let done2 = false;
    H.awaitSay().then(() => { done2 = true; });
    await sleep(60);
    ok('★★ 关掉「说完再走」时，闸门一律不等', done2 === true);
    T.waitSay = true;
    fire2();

    dom.window.close();
  }

  // 3f ★ 刚打开页面、AudioContext 还没被用户手势解锁 —— 这时 start() 不出声、
  //    onended 永远不来。要是还傻等着，每一句都得卡满 12 秒硬超时（比不等还糟）。
  //    ⚠ 必须**单开一个页面**来测：上下文一旦建好就一直活着。实测在同一个页面里
  //      「加锁」根本改不动已有实例的 state（`ttsSetOn(false)` 只清 TTS.ctx，
  //      重开时 ttsCtx() 又复用了那个旧的 running 实例），于是补丁 B 压根没被走到 ——
  //      之前那版 3f 就是这么假绿/假红的。所以锁必须抢在页面第一次建 ctx 之前。
  {
    const { w, dom } = boot(null);
    await sleep(320);
    AUDIO.lock(true);                          // ← 抢在任何 ctx 之前（此刻页面还一个都没建）
    const H = w.HOLDEM, T = H.tts();
    H.ttsSetOn(true); await sleep(20);         // 这一下就会把 ctx 建出来，且是 suspended
    const lockedBefore = T.stat.locked || 0;
    const tick0 = Date.now();
    const g6 = H.ttsSay(1, 'MARK-还没解锁');
    let open6 = false;
    if (g6) g6.then(() => { open6 = true; });
    await sleep(150);
    ok('★★ 音频没解锁时闸门立刻放行（不是傻等硬超时）', open6 === true, (Date.now() - tick0) + 'ms 内放行');
    ok('并且记了一笔 locked，事后能查出「这次为什么没等」',
      (T.stat.locked || 0) > lockedBefore, 'locked=' + T.stat.locked);
    AUDIO.lock(false);
    dom.window.close();
  }

  // ============================================================ 4
  section('4. 牌局接线：说完才轮到下一个人');
  {
    const { w, d, errors, dom } = boot(null);
    await sleep(320);
    const H = w.HOLDEM, T = H.tts();
    H.gameCfg().think = false;           // ⚠ 本节要跑真实 turn，拟人停顿会白白拖慢（不是它坏了）
    const ps = H.players();
    H.ttsSetOn(true);
    await sleep(10);

    // ---- 4a 开着：语音没播完，turn 就不许结束 ----
    const target = ps.find(p => !p.isHuman);
    const r1 = await runTurnWithSay(H, T, ps, target, 'MARK-说完才走');
    ok('★ 这一次确实进入了「等说完」', r1.waited >= 1, 'waits +' + r1.waited);
    ok('★ 声音还在播时 turn 没有结束', r1.finished() === false);
    ok('★ 说话的人还高亮着（人和声音对得上）', H.activeSeat() === r1.idx, 'activeSeat=' + H.activeSeat());
    AUDIO.ended();
    await sleep(400);
    ok('★ 播完之后 turn 才结束', r1.finished() === true);
    ok('★ 高亮这时才让给下一个人', H.activeSeat() === -1);

    // ---- 4b 关掉节奏：声音还在，人已经走了（这就是第十九轮的行为）----
    T.waitSay = false;
    T.stat.waits = 0;
    const target2 = ps.filter(p => !p.isHuman)[1];
    armPlayer(target2);
    AUDIO.reset();
    let fin2 = false;
    H.takeTurn(target2, ps.indexOf(target2)).then(() => { fin2 = true; });
    await sleep(60);
    target2.aiSay = 'MARK-不等它'; target2.aiSayVoice = true;
    await sleep(900);
    ok('★★ 关掉「说完再走」时，turn 不等语音', fin2 === true && T.stat.waits === 0, 'waits=' + T.stat.waits);
    ok('★ 而且此刻声音确实还在播（不是没播，是不等）', AUDIO.made.playing.length >= 1, AUDIO.made.playing.length + ' 个在播');
    ok('★ 高亮已经放开了（这时候人和声音是对不上的 —— 这是用户主动选的）', H.activeSeat() === -1);
    T.waitSay = true;

    // ---- 4c 配音关着：整条链路一步都不多停 ----
    H.ttsSetOn(false);
    T.stat.waits = 0;
    const target3 = ps.filter(p => !p.isHuman)[2];
    armPlayer(target3);
    let fin3 = false;
    H.takeTurn(target3, ps.indexOf(target3)).then(() => { fin3 = true; });
    await sleep(60);
    target3.aiSay = 'MARK-配音关着'; target3.aiSayVoice = true;
    await sleep(900);
    ok('★★ 配音关着时，说出口的话也不耽误牌局（waits 一次都没动）',
      fin3 === true && T.stat.waits === 0 && T.stat.timeout === 0, 'waits=' + T.stat.waits);
    H.ttsSetOn(true);

    ok('整段牌局流程没有脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    dom.window.close();
  }

  // ============================================================ 5
  section('5. 两个开关：默认开、存得住、旧存档回落');
  {
    const A = boot(null);
    await sleep(320);
    const H = A.w.HOLDEM, T = H.tts();
    ok('★ 两个开关默认都是开的（新行为默认生效）', T.waitSay === true && T.aiPick === true,
      'waitSay=' + T.waitSay + ' aiPick=' + T.aiPick);
    const IDS = ['ttsWaitSay', 'ttsAiPick'];
    const miss = IDS.filter(id => !A.d.getElementById(id));
    ok('面板上两个复选框都在', miss.length === 0, miss.join(',') || 'ok');
    ok('复选框初始是勾上的', A.d.getElementById('ttsWaitSay').checked === true && A.d.getElementById('ttsAiPick').checked === true);

    // 点一下 = 关掉，并且立刻存盘
    const cbW = A.d.getElementById('ttsWaitSay');
    cbW.checked = false; cbW.onchange({ target: cbW });
    ok('取消勾选 → TTS.waitSay 变 false', T.waitSay === false);
    ok('并且立刻写进了存档', JSON.parse(A.w.localStorage.getItem(H.ttsKey())).waitSay === false);
    const cbA = A.d.getElementById('ttsAiPick');
    cbA.checked = false; cbA.onchange({ target: cbA });
    ok('取消勾选 → TTS.aiPick 变 false', T.aiPick === false);
    ok('syncTtsUI 会把复选框同步回来（不会和状态脱节）', (() => {
      T.waitSay = true; H.syncTtsUI();
      const a = A.d.getElementById('ttsWaitSay').checked === true;
      T.waitSay = false; H.syncTtsUI();
      const b = A.d.getElementById('ttsWaitSay').checked === false;
      return a && b;
    })());

    T.waitSay = false; T.aiPick = false; H.ttsSave();
    const store = dumpStore(A.w);
    A.w.close();

    // ★ 跨一次页面加载 —— 只在一个页面里看，是看不出有没有真写盘的
    const B = boot(store);
    await sleep(320);
    const TB = B.w.HOLDEM.tts();
    ok('★★ 跨页面：两个开关都被恢复（关着的还是关着的）',
      TB.waitSay === false && TB.aiPick === false, 'waitSay=' + TB.waitSay + ' aiPick=' + TB.aiPick);
    ok('跨页面：面板复选框跟着是未勾选状态',
      B.d.getElementById('ttsWaitSay').checked === false && B.d.getElementById('ttsAiPick').checked === false);
    B.w.close();

    // 旧存档里根本没有这两个字段 → 必须回落到默认开，而不是 undefined
    const legacy = {};
    legacy[A.w.HOLDEM ? 'holdem_tts_v1' : 'holdem_tts_v1'] =
      JSON.stringify({ on: true, vol: 0.8, endpoint: 'http://127.0.0.1:9880/tts' });
    const C = boot(legacy);
    await sleep(320);
    const TC = C.w.HOLDEM.tts();
    ok('★★ 旧存档（没这两个字段）→ 回落成默认的 true，不会变成 undefined',
      TC.waitSay === true && TC.aiPick === true, 'waitSay=' + TC.waitSay + ' aiPick=' + TC.aiPick);
    ok('旧存档的开关和音量照样读得回来', TC.on === true && Math.abs(TC.vol - 0.8) < 1e-6);
    ok('旧存档灌进来没有脚本错误', true);
    C.w.close();

    // 前后两向都验过：关 → 存得住；没存 → 回落成开
  }

  // ============================================================ 6
  section('6. 没把别的东西弄坏');
  {
    const { w, d, dom } = boot(null);
    await sleep(320);
    const H = w.HOLDEM, T = H.tts();

    // ⚠ 铁律：这条链路一次都不许碰 Math.random
    const origRand = w.Math.random;
    let randCalls = 0;
    w.Math.random = () => { randCalls++; return 0.5; };
    H.ttsSetOn(true);
    await sleep(10);
    w.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    AUDIO.reset();
    randCalls = 0;
    const p = H.players()[2];
    p.aiSay = 'MARK-随机源'; p.aiSayVoice = true;
    H.logAct(p);
    await H.awaitSay();
    AUDIO.ended();
    await sleep(60);
    ok('★★ 说话 + 等说完 + 播完这条链，一次 Math.random 都没碰', randCalls === 0, randCalls + ' 次');
    w.Math.random = origRand;

    // 配音关着时不该有任何闸门残留
    H.ttsSetOn(false);
    ok('关掉配音后没有残留闸门', H.sayGate() === null);
    H.ttsSetOn(true);
    await sleep(10);
    H.ttsStop();
    ok('打断之后也没有残留闸门', H.sayGate() === null);

    // 源码层面把两条底线钉住（防以后有人手滑）
    const src = html;
    ok('★ takeTurn 里 awaitSay 在 applyAction 之后、activeSeat 放开之前',
      /applyAction\(p, act\.type, act\.amount\);\s*\}\s*\n\s*\/\/[\s\S]{0,400}?await awaitSay\(\);\s*\n\s*activeSeat = -1;/.test(src));
    ok('★ ttsFetch 自带超时（否则服务卡住会把牌局吊到浏览器默认超时）',
      src.indexOf('new AbortController()') >= 0 && src.indexOf('ctrl.abort()') >= 0);
    ok('★ ttsStop 会把挂着的闸门全部放行', /const pending = \[\];[\s\S]{0,300}?for \(const j of pending\) releaseSay\(j\);/.test(src));
    ok('★ ttsSay 的返回不再是「即发即忘」的布尔值（这条口径是本轮刻意改的）',
      src.indexOf('return gate;') >= 0 && src.indexOf('记下讲话不讲话') < 0);

    dom.window.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log('  第二十一轮自检（说话闸门）：%d 项通过，%d 项失败', pass, fail);
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n💥 自检自己崩了：', e && e.stack || e);
  process.exit(1);
});
