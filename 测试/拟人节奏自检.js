/* =========================================================================
   第二十二轮自检 —— 🗣 拟人节奏：出手前想一想 + 一次多说几句 + 可配置
   -------------------------------------------------------------------------
   要守住的三条：
     1. AI 决定好了**不立刻出手**，像人一样停一下（大决定久、免费过牌短、快慢因人而异）；
     2. 一次能说**几句**场上话，逐句上战报、逐句念；关掉就只说一句；
     3. 全部可配置（面板 + 存档 + 旧存档回落），关掉即回到「秒出牌 + 只说一句」。

   口径提醒（前几轮踩出来的）：
     · 固定随机源，结果可复现；
     · 「持久化」必须跨一次页面加载才算验过；
     · 正反两向都要断言；
     · ⚠ 拟人节奏**一次都不许碰 Math.random** —— 它有自己的一条 LCG（paceRand）。
       碰了就会消耗页面测试的固定序列，洗牌与下游 AI 的随机数全跟着漂。
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

/* ---------- 可控播放的 AudioContext 假件（不自动 ended，由测试叫停） ---------- */
function makeCtlAudio() {
  const made = { ctors: 0, playing: [], decoded: 0 };
  const param = () => ({
    value: 1, setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; }, linearRampToValueAtTime() { return this; }
  });
  const C = function () {
    made.ctors++;
    this.state = 'running';
    this.currentTime = 0; this.sampleRate = 48000;
    this.destination = { connect() { }, disconnect() { } };
    this.resume = function () { };
    this.createGain = () => ({ gain: param(), connect() { return this; }, disconnect() { } });
    this.decodeAudioData = async () => { made.decoded++; return { duration: 12 }; };
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
let mathHits = 0;

function boot(store, countMath) {
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
      window.Math.random = () => {
        if (countMath) mathHits++;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
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

// 让一个 AI 玩家处于「能做一次决定」的状态
function armPlayer(p) {
  p.out = false; p.folded = false; p.allIn = false; p.acted = false;
  p.chips = 1000; p.bet = 0; p.totalBet = 0;
  p.hole = [{ r: 14, s: 0 }, { r: 13, s: 1 }];
  p.aiSay = ''; p.aiSays = []; p.aiSayVoice = false; p.actionType = '';
}

(async () => {

  // ============================================================ 1
  section('1. 配置：默认开、面板能改、存得住、旧存档回落');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg();
    ok('页面起得来，没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    ok('导出里有拟人节奏接口', !!(H && H.gameCfg && H.paceStat && H.humanPause && H.parseSays && H.paceMsOf), 'ok');
    ok('★ 三个配置默认都开 / 基准 900ms（新行为默认生效）',
      C.think === true && C.multi === true && C.thinkMs === 900,
      'think=' + C.think + ' thinkMs=' + C.thinkMs + ' multi=' + C.multi);

    const IDS = ['cfgThink', 'cfgThinkMs', 'cfgMulti'];
    const miss = IDS.filter(id => !A.d.getElementById(id));
    ok('面板上三个控件都在', miss.length === 0, miss.join(',') || 'ok');
    // ⚠ 面板控件是在「打开设置」那一刻才回填的（openAISet → writeGameCfgForm），
    //   刚加载完页面它们是 HTML 的初始值，不反映状态 —— 所以要先打开面板再看。
    A.d.getElementById('btnAISet').click();
    await sleep(10);
    ok('★ 打开面板后，控件值跟状态一致',
      A.d.getElementById('cfgThink').checked === true &&
      A.d.getElementById('cfgMulti').checked === true &&
      Number(A.d.getElementById('cfgThinkMs').value) === 900);

    // 改一下表单 → 走「保存并应用」那条真实路径
    A.d.getElementById('cfgThink').checked = false;
    A.d.getElementById('cfgMulti').checked = false;
    A.d.getElementById('cfgThinkMs').value = '1500';
    A.d.getElementById('aiSave').onclick();
    ok('★ 保存后配置真的变了', C.think === false && C.multi === false && C.thinkMs === 1500,
      'think=' + C.think + ' thinkMs=' + C.thinkMs + ' multi=' + C.multi);
    ok('并且写进了存档', (() => {
      const j = JSON.parse(A.w.localStorage.getItem('holdem_game_cfg_v1'));
      return j && j.think === false && j.multi === false && j.thinkMs === 1500;
    })());

    const store = dumpStore(A.w);
    A.w.close();

    // ★ 跨一次页面加载
    const B = boot(store);
    await sleep(340);
    const HB = B.w.HOLDEM, CB = HB.gameCfg();
    ok('★★ 跨页面：三个配置都被恢复（关着的还是关着的）',
      CB.think === false && CB.multi === false && CB.thinkMs === 1500,
      'think=' + CB.think + ' thinkMs=' + CB.thinkMs + ' multi=' + CB.multi);
    B.d.getElementById('btnAISet').click();
    await sleep(10);
    ok('★★ 跨页面：打开面板后控件就是上次存的（未勾选 / 1500）',
      B.d.getElementById('cfgThink').checked === false &&
      B.d.getElementById('cfgMulti').checked === false &&
      Number(B.d.getElementById('cfgThinkMs').value) === 1500);
    B.w.close();

    // 旧存档（完全没有这三个字段）→ 回落默认
    const C2 = boot({ holdem_game_cfg_v1: '{"sb":25,"bb":50}' });
    await sleep(340);
    const HC = C2.w.HOLDEM, CC = HC.gameCfg();
    ok('★★ 旧存档（没这三个字段）→ 回落成默认，不会变成 undefined',
      CC.think === true && CC.multi === true && CC.thinkMs === 900,
      'think=' + CC.think + ' thinkMs=' + CC.thinkMs + ' multi=' + CC.multi);
    ok('旧存档的盲注照样读得回来', CC.sb === 25 && CC.bb === 50, CC.sb + '/' + CC.bb);

    // ⚠ 「0 是合法值」：thinkMs=0 不能被 || 兜成 900
    const C3 = boot({ holdem_game_cfg_v1: '{"thinkMs":0}' });
    await sleep(340);
    ok('★★ 存档里 thinkMs=0 就保持 0（不被 || 兜成默认值）', C3.w.HOLDEM.gameCfg().thinkMs === 0,
      'thinkMs=' + C3.w.HOLDEM.gameCfg().thinkMs);
    C3.w.close();

    // 越界值要被夹住
    const C4 = boot({ holdem_game_cfg_v1: '{"thinkMs":999999}' });
    await sleep(340);
    ok('存档里超大的 thinkMs 被夹到 6000 以内', C4.w.HOLDEM.gameCfg().thinkMs === 6000,
      'thinkMs=' + C4.w.HOLDEM.gameCfg().thinkMs);
    C4.w.close();
    C2.w.close();
  }

  // ============================================================ 2
  section('2. 一次说几句：把模型给的 say 收干净');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, ps = H.parseSays;

    ok('给一句字符串 → 就是一句', JSON.stringify(ps('就这？', 3)) === '["就这？"]', JSON.stringify(ps('就这？', 3)));
    ok('★ 给数组 → 原样收下', JSON.stringify(ps(['一', '二', '三'], 3)) === '["一","二","三"]', JSON.stringify(ps(['一', '二', '三'], 3)));
    ok('★ 给带换行的长串 → 拆成几句', JSON.stringify(ps('第一句\n第二句', 3)) === '["第一句","第二句"]', JSON.stringify(ps('第一句\n第二句', 3)));
    ok('全角竖线也当分隔符', ps('甲｜乙', 3).length === 2);
    ok('★ 空数组 / 没给 → 这一手不开口', ps([], 3).length === 0 && ps(undefined, 3).length === 0 && ps('', 3).length === 0);
    ok('★ 混在里面的空句被剔掉', JSON.stringify(ps(['', '  ', '有话'], 3)) === '["有话"]', JSON.stringify(ps(['', '  ', '有话'], 3)));
    ok('★ 上限是真的（给 5 句只留 3 句）', ps(['1', '2', '3', '4', '5'], 3).length === 3);
    ok('★ 单句模式（上限 1）只留第一句', JSON.stringify(ps(['甲', '乙'], 1)) === '["甲"]', JSON.stringify(ps(['甲', '乙'], 1)));
    ok('超长的一句被截到 36 字以内', ps(['啊'.repeat(90)], 3)[0].length === 36, ps(['啊'.repeat(90)], 3)[0].length + ' 字');

    A.w.close();
  }

  // ============================================================ 3
  section('3. 停多久：动作轻重 × 个人快慢');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg();
    const mk = k => { const p = { key: k }; return p; };

    C.think = false;
    ok('★ 关掉「出手前想一想」→ 一律不停（0 ms）',
      H.paceMsOf(mk('liyi'), { type: 'raise' }, 0) === 0);

    C.think = true; C.thinkMs = 0;
    ok('★ 基准填 0 → 也不停（0 是合法值，不是「没填」）',
      H.paceMsOf(mk('liyi'), { type: 'raise' }, 0) === 0);

    C.thinkMs = 1000;
    // 固定随机源：每次调用都会推进 paceRand，所以比较要用同一位置的两个样本 ——
    // 这里靠「大样本统计」而不是单次比较（单次会被随机浮动盖过）。
    const avg = (key, type, n, toCall) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += H.paceMsOf(mk(key), { type }, toCall || 0);
      return s / n;
    };
    const avgRaise = avg('jiexi', 'raise', 60);
    const avgCheck = avg('jiexi', 'check', 60);
    ok('★ 大决定（加注）比免费过牌停得久', avgRaise > avgCheck * 1.8,
      '加注 ' + Math.round(avgRaise) + ' ms vs 过牌 ' + Math.round(avgCheck) + ' ms');

    const avgLi = avg('liyi', 'call', 60);
    const avgMai = avg('maiqi', 'call', 60);
    ok('★ 李姨（慢）比麦琪（急）停得久', avgLi > avgMai * 1.5,
      '李姨 ' + Math.round(avgLi) + ' ms vs 麦琪 ' + Math.round(avgMai) + ' ms');

    const avgFoldFree = avg('jiexi', 'fold', 60, 0);
    const avgFoldPaid = avg('jiexi', 'fold', 60, 500);
    ok('★ 被压着弃牌比免费弃牌更犹豫', avgFoldPaid > avgFoldFree * 1.1,
      '被压 ' + Math.round(avgFoldPaid) + ' vs 免费 ' + Math.round(avgFoldFree));

    // 上界：基准拉满也不能超过 6 秒
    C.thinkMs = 6000;
    let mx = 0;
    for (let i = 0; i < 80; i++) mx = Math.max(mx, H.paceMsOf(mk('liyi'), { type: 'allin' }, 999));
    ok('★ 再慢也封顶 6 秒（不能停到天荒地老）', mx <= 6000, '最大 ' + mx + ' ms');

    A.w.close();
  }

  // ============================================================ 4
  section('4. 真的会等：humanPause 是「等」，不是「跳过」');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg(), P = H.paceStat();

    C.think = false;
    let p0 = P.pauses;
    const t0 = Date.now();
    await H.humanPause({ key: 'liyi' }, { type: 'call' }, 0);
    ok('★ 关掉时 humanPause 一步都不停', Date.now() - t0 < 25 && P.pauses === p0,
      (Date.now() - t0) + 'ms');

    C.think = true; C.thinkMs = 200;
    const want = H.paceMsOf({ key: 'aimi' }, { type: 'call' }, 0);   // 先算一次拿到「将要停多久」
    // 上面那次调用推进了 paceRand，实际 humanPause 会算出另一个值 —— 所以只断言「真的等了」，
    // 且等待时长落在合理区间（0.55~1.55 倍 ± 边界）。
    p0 = P.pauses;
    const t1 = Date.now();
    const ms = await H.humanPause({ key: 'aimi' }, { type: 'call' }, 0);
    const real = Date.now() - t1;
    ok('★★ 真的等了（不是立刻返回）', real >= ms - 30 && ms > 0,
      '声明 ' + ms + ' ms，实测 ' + real + ' ms（参照 ' + want + '）');
    ok('★ 等待时长在基准的合理区间内', ms >= 200 * 0.55 - 1 && ms <= 200 * 1.55 + 1, ms + ' ms');
    ok('并且记了一笔（自检看得出「停过」）', P.pauses === p0 + 1 && P.last === ms, 'pauses=' + P.pauses);

    A.w.close();
  }

  // ============================================================ 5
  section('5. 多说几句：逐句上战报、逐句念');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg(), T = H.tts();
    const hits = [];
    A.w.fetch = async (u, o) => { hits.push(JSON.parse(o.body).text); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
    H.ttsSetOn(true);
    await sleep(20);

    const mk = (says, voice) => ({
      id: 2, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true,
      actionType: 'call', lastAction: '跟注 40', aiRead: '', aiThink: '',
      aiSays: says, aiSay: '', aiSayVoice: voice
    });
    const settle = async () => { AUDIO.ended(); await sleep(30); H.ttsStop(); await sleep(30); AUDIO.reset(); T.busy = false; };

    // 5a 开关开着：多句全部落地
    C.multi = true;
    T.aiPick = true;
    await settle();
    hits.length = 0;
    const n0 = H.say().length;
    const P = H.paceStat(); const s0 = P.says;
    H.logAct(mk(['第一句', '第二句', '第三句'], true));
    // ⚠ 这个假件不会自己结束播放：不放行的话 TTS.busy 不释放，队列就卡住。
    //   第 27 轮起三句合成**一整段** —— 只需放行一次。
    await sleep(70); AUDIO.ended(); await sleep(90);
    await sleep(80);
    ok('★★ 三句全部进了公开话记录', H.say().length === n0 + 3, '新增 ' + (H.say().length - n0) + ' 条');
    ok('★★ 三句都真的发去合成了（合在一整段里，只发一次）', hits.length === 1,
      hits.length + ' 次：' + hits.join('|').slice(0, 80));
    ok('★★ 而且那一次请求里三句一句不少',
      hits.length === 1 && hits[0].indexOf('第一句') >= 0 &&
      hits[0].indexOf('第二句') >= 0 && hits[0].indexOf('第三句') >= 0,
      JSON.stringify(hits[0] || ''));
    ok('并且计数记了一笔', P.says === s0 + 3, 'says +' + (P.says - s0));

    // 5b 整段念完才算「说完」：多句合一段，只有一道闸门，播完它才放行
    await settle();
    T.waitSay = true;
    H.setSayGate(null);
    let opened = false;
    // 重新走一次，抓闸门
    const p2 = mk(['甲句', '乙句'], true);
    H.logAct(p2);
    await sleep(30);
    const g = H.sayGate();
    ok('★ 多句合一段后，闸门照样被挂上（不是 null）', !!g);
    if (g) g.then(() => { opened = true; });
    await sleep(160);
    ok('★★ 还没念完时，闸门一直关着（干等 160ms 也不放行）', opened === false);
    ok('★★ 三句合在一段里，队列里没有第二段在排队（只排了一次）',
      T.queue.length === 0, T.queue.length + ' 个待播');
    AUDIO.ended(); await sleep(120);          // 整段播完
    ok('★★ 整段念完，闸门才解开', opened === true);
    await settle();

    // 5c 关掉多句：只留一句。走真实链路（模型输出 → takeMind → logAction），
    //    再额外验证「就算绕过入口硬塞一长串，消费端也只说第一句」。
    C.multi = false;
    await settle();
    const pc = H.players()[1];
    H.takeMind(pc, { read: '', think: '', say: ['只剩一句', '这句不该出现'], voice: 1 });
    ok('★ 关掉后 takeMind 就只收一句', pc.aiSays.length === 1, pc.aiSays.length + ' 句');
    const n1 = H.say().length;
    H.logAct(pc);
    await sleep(80);
    ok('★★ 战报里也只多了一句（反向）', H.say().length === n1 + 1, '新增 ' + (H.say().length - n1) + ' 条');
    ok('★ 而且留下的就是第一句', H.say()[H.say().length - 1].say === '只剩一句');

    // 消费端兜底：绕过 takeMind 硬塞两句，关掉时照样只能出一句
    await settle();
    const n1b = H.say().length;
    H.logAct(mk(['兜底甲', '兜底乙'], true));
    await sleep(60);
    ok('★★ 就算绕过入口硬塞两句，消费端也只说第一句（兜底）', H.say().length === n1b + 1,
      '新增 ' + (H.say().length - n1b) + ' 条');
    C.multi = true;

    // 5d 配音关着：战报照样三句，一声不吭
    await settle();
    H.ttsSetOn(false);
    hits.length = 0;
    const n2 = H.say().length;
    H.logAct(mk(['甲', '乙', '丙'], true));
    await sleep(60);
    ok('★ 配音关着时，三句照样上战报', H.say().length === n2 + 3);
    ok('★ 但一次合成请求都不发（反向）', hits.length === 0, hits.length + ' 次');
    ok('并且没有残留闸门', H.sayGate() === null);
    H.ttsSetOn(true);

    // 5e 兼容老路径：只给 aiSay 字符串的老代码/老档案
    await settle();
    const p3 = mk([], true); p3.aiSay = '老格式的一句话';
    const n3 = H.say().length;
    H.logAct(p3);
    await sleep(60);
    ok('★ 只给 aiSay（老路径）也照样能上战报', H.say().length === n3 + 1 && H.say()[H.say().length - 1].say === '老格式的一句话');

    await settle();
    ok('整段流程没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  // ============================================================ 6
  section('6. 队列挤爆时丢掉的老任务也要解闸（本轮修的真 bug）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, T = H.tts();
    H.ttsSetOn(true);
    await sleep(20);

    // 把泵卡住：busy=true 时 ttsPump 直接 return，队列只进不出
    T.queue.length = 0; T.busy = true;
    const P = H.paceStat();
    const d0 = P.dropped;
    const gates = [];
    for (let i = 0; i < 8; i++) gates.push(H.ttsSay(1, 'MARK-挤爆-' + i));
    const dropped = P.dropped - d0;
    // 不写死具体条数（那是实现细节），只守「队列没无限涨」+「丢了多少就解多少」。
    ok('★ 队列没无限涨（裁到上限以内）', T.queue.length <= 6 && T.queue.length >= 1, T.queue.length + ' 条');
    ok('★ 确实丢掉了一些老任务，并记了数', dropped > 0, 'dropped +' + dropped);

    let opened = 0;
    for (const g of gates) if (g) g.then(() => { opened++; });
    await sleep(60);
    ok('★★ 被丢掉的闸门全部解开了（否则那边会死等到 12 秒超时）', opened === dropped,
      opened + ' 个已解闸 / 丢了 ' + dropped + ' 个');
    ok('★ 留在队列里的还是关着的（没被误放）', opened < gates.length, opened + '/' + gates.length);

    H.ttsStop();
    await sleep(40);
    ok('打断后 8 个闸门全部放行，一个不剩', opened === 8, opened + ' 个');

    A.w.close();
  }

  // ============================================================ 7
  section('7. 拟人节奏一次都不许碰 Math.random');
  {
    const A = boot(null, true);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg(), P = H.paceStat();
    H.ttsSetOn(true);
    await sleep(20);

    mathHits = 0;
    // 把拟人节奏的每个入口都过一遍
    C.think = true; C.thinkMs = 1;
    for (let i = 0; i < 20; i++) H.paceMsOf({ key: 'liyi' }, { type: 'raise' }, 100);
    await H.humanPause({ key: 'maiqi' }, { type: 'call' }, 0);
    H.parseSays(['甲', '乙'], 3);
    H.takeMind(H.players()[1], { say: ['一', '二'], voice: 1 });
    H.logAct({ id: 2, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true, actionType: 'call', aiRead: '', aiThink: '', aiSays: ['甲', '乙'], aiSay: '', aiSayVoice: true });
    await sleep(60);
    H.ttsStop();
    ok('★★ 拟人节奏这条链（停顿 + 多句 + 排队）一次 Math.random 都没碰', mathHits === 0, mathHits + ' 次');

    A.w.close();
  }

  // ============================================================ 8
  section('8. 牌局接线：停完才出牌，且不影响别的');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, C = H.gameCfg(), P = H.paceStat();
    const ps = H.players();
    const target = ps.find(p => !p.isHuman);

    // 8a 关掉：牌局照跑，一次都不停
    C.think = false;
    armPlayer(target);
    let p0 = P.pauses;
    const t0 = Date.now();
    let done1 = false;
    H.takeTurn(target, ps.indexOf(target)).then(() => { done1 = true; });
    const w0 = Date.now();
    while (Date.now() - w0 < 6000) { if (done1) break; await sleep(20); }
    ok('★ 关掉拟人后，takeTurn 全程一次都没停', P.pauses === p0, 'pauses +' + (P.pauses - p0));
    ok('★ 而且确实走完了（不是卡住）', done1 === true);

    // 8b 打开：先确认「停顿发生在出牌之前」
    C.think = true; C.thinkMs = 400;
    armPlayer(target);
    p0 = P.pauses;
    const beforeAction = target.actionType;
    let done2 = false, sawThinking = false, sawActionDuringPause = null;
    H.takeTurn(target, ps.indexOf(target)).then(() => { done2 = true; });
    const w1 = Date.now();
    while (Date.now() - w1 < 8000) {
      if (P.pauses > p0 && !sawThinking) {
        sawThinking = true;
        sawActionDuringPause = target.actionType;
      }
      if (done2) break;
      await sleep(10);
    }
    ok('★★ 这一次确实进入了停顿', P.pauses > p0, 'pauses +' + (P.pauses - p0));
    ok('★★ 停顿期间还没出牌（actionType 没被提前写）', sawThinking === true && sawActionDuringPause === '',
      '停顿中 actionType=' + JSON.stringify(sawActionDuringPause));
    ok('★ 停顿结束后牌局继续走完', done2 === true);
    ok('★ 而且真的出了牌（有行动类型了）', !!target.actionType, target.actionType);

    C.think = true; C.thinkMs = 900;
    ok('整段牌局流程没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log('  第二十二轮自检（拟人节奏）：' + pass + ' 项通过，' + fail + ' 项失败');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检炸了:', e); process.exit(1); });
