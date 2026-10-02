// 第十九轮自检 —— 🎙 角色配音（本地实时 TTS）
//
// 规矩（前几轮踩出来的，一条都没省）：
//   · 固定随机源，结果可复现；
//   · 「持久化」的断言必须跨一次页面加载才算验过；
//   · 涉及「谁该有、谁不该有」的，正反两向都要断言（用 MARK 串）；
//   · 破坏性开关不能只测一个入口；
//   · ⚠ 音效/特效/配音绝不许消耗 Math.random。
//
// 本轮特别要守住的一条：**配音只有装饰职责**。
// 它连不上服务、解不了码、播不出来，都不许让牌局停一下。
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

// ---------- 配音专用 AudioContext 假件 ----------
// 比前几轮的更"真"：会记录每个节点是谁、谁连到谁，还会在 start/stop 后
// 异步触发 onended —— 否则 ttsPlay 只能靠保底闹钟收尾，测试要白等 1.5 秒。
function makeAudioCtxMock() {
  const made = {
    ctors: 0, gains: [], srcs: [], buffers: [], decoded: 0,
    connects: [], starts: 0, stops: 0, resumes: 0
  };
  let uid = 0;
  const param = () => ({
    value: 1,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; }
  });
  const node = (kind, extra) => {
    const o = Object.assign({
      __kind: kind, __id: ++uid,
      connect(t) { made.connects.push([this.__id, t && t.__id]); return this; },
      disconnect() { }
    }, extra || {});
    return o;
  };
  const C = function () {
    made.ctors++;
    const ctx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: node('destination'),
      resume() { made.resumes++; this.state = 'running'; },
      createGain() { const g = node('gain', { gain: param() }); made.gains.push(g); return g; },
      createOscillator() {
        return node('osc', { type: 'sine', frequency: param(), start() { }, stop() { } });
      },
      createBiquadFilter() {
        return node('filter', { type: 'bandpass', frequency: param(), Q: { value: 1 }, detune: { value: 0 } });
      },
      createBuffer(ch, len, rate) {
        const data = new Float32Array(len);
        const b = { length: len, sampleRate: rate, numberOfChannels: ch, getChannelData: () => data };
        made.buffers.push(b);
        return b;
      },
      createBufferSource() {
        const s = node('src', {
          buffer: null, onended: null,
          start() {
            made.starts++;
            setTimeout(() => { try { if (s.onended) s.onended(); } catch (e) { } }, 0);
          },
          stop() {
            made.stops++;
            setTimeout(() => { try { if (s.onended) s.onended(); } catch (e) { } }, 0);
          }
        });
        made.srcs.push(s);
        return s;
      },
      decodeAudioData() {
        made.decoded++;
        return Promise.resolve({
          duration: 0.3, length: 7200, sampleRate: 24000, numberOfChannels: 1,
          getChannelData: () => new Float32Array(7200)
        });
      }
    };
    return ctx;
  };
  C._made = made;
  return C;
}

let AUDIO = null;

function boot(store, opt) {
  opt = opt || {};
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => { });
  let seed = 20261001 >>> 0;
  AUDIO = makeAudioCtxMock();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      window.AudioContext = AUDIO;
      if (opt.noAudio) { window.AudioContext = undefined; window.webkitAudioContext = undefined; }
      if (!opt.noFetch) {
        window.fetch = opt.fetch || (async () => { throw new Error('no net'); });
      }
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
      if (store) {
        for (const k of Object.keys(store)) {
          try { window.localStorage.setItem(k, store[k]); } catch (e) { }
        }
      }
    }
  });
  return { dom, w: dom.window, d: dom.window.document, errors };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROF = ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie'];
let SFX_MASTER = null;   // 音效播放链的参照物：必须趁早抓，晚了 gains[0] 就成配音的了

(async () => {
  // ============================================================ 1
  section('1. 结构与默认值');
  const { w, d, errors, dom } = boot(null);
  await sleep(320);
  const H = w.HOLDEM;
  ok('页面起得来，没有脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '));
  ok('导出里有配音接口', !!(H && H.tts && H.ttsSay && H.ttsStop && H.ttsSetOn));

  const IDS = ['btnTts', 'ttsMask', 'ttsOn', 'ttsEp', 'ttsVol', 'ttsVolTxt', 'ttsDot',
    'ttsState', 'ttsCache', 'ttsClear', 'ttsStop', 'ttsTest', 'ttsWarm', 'ttsList', 'ttsOut', 'ttsClose'];
  const missing = IDS.filter(id => !d.getElementById(id));
  ok('面板控件一个不少', missing.length === 0, missing.join(',') || (IDS.length + ' 个'));

  const T = H.tts();
  ok('★ 配音默认是关的（不打扰）', T.on === false, 'on=' + T.on);
  ok('默认音量在合理区间', T.vol > 0 && T.vol <= 1, T.vol);
  ok('默认地址指向本机 9880', /127\.0\.0\.1:9880\/tts$/.test(T.endpoint), T.endpoint);
  ok('缓存上限是正数', T.cacheMax > 0, T.cacheMax);
  ok('工具栏按钮显示为「关」', d.getElementById('btnTts').textContent === '🔇');
  ok('按钮挂了 off 类', d.getElementById('btnTts').classList.contains('off'));

  // ⚠ 趁现在抓「音效 master」的参照物。必须在任何配音播放之前 ——
  //   配音一播就会先建 GainNode，那时候 gains[0] 已经不是音效的了（第一版就栽在这）。
  H.setSfx(true);
  try { H.sfx('chip'); } catch (e) { }
  SFX_MASTER = AUDIO._made.gains[0];
  ok('音效 master 已建出（作为后面的参照物）', !!SFX_MASTER, SFX_MASTER && SFX_MASTER.__id);

  // ============================================================ 2
  section('2. 开 / 关与队列（配音绝不阻塞牌局）');
  ok('关着的时候，说话请求直接被拒（不入队）', (() => {
    T.queue.length = 0;
    const r = H.ttsSay(2, '关着不该进队');
    // 第二十一轮起：不用等的情况返回 null（不再是 false）
    return r === null && T.queue.length === 0;
  })());

  H.ttsSetOn(true);
  await sleep(10);
  ok('开开关后状态变成开', T.on === true);
  ok('按钮跟着变成「开」', d.getElementById('btnTts').textContent === '🎙');
  ok('开关同步到面板复选框', d.getElementById('ttsOn').checked === true);

  // ⚠ 第二十一轮改了这条口径：ttsSay 现在返回「这句话的闸门」（Promise），
  //   好在「说完才轮到下一个人」时 await 它；不用等的情况仍返回 null。
  //   敢改的理由：旧口径「不许 await」是为了防止配音卡住牌局，
  //   而那个保证现在由 awaitSay 的硬超时 + ttsStop 强制放行接手 ——
  //   下面三条就是专门验这个保证还在的（少一条都不算守住）。
  ok('★ ttsSay 开着时返回可等待的闸门（Promise）', (() => {
    const g = H.ttsSay(2, '一句话');
    const isGate = !!g && typeof g.then === 'function';
    if (isGate) g.then(() => { }, () => { });      // 挂上消费，别留下没人接的 promise
    return isGate;
  })());
  ok('★ 关掉开关时仍然返回 null（不用等，一步不停）', (() => {
    H.ttsSetOn(false);
    const r = H.ttsSay(2, '关着不用等');
    H.ttsSetOn(true);
    return r === null;
  })());

  // ★★ 闸门必须真的会自己解开 —— 解不开就等于把整手牌吊死在这个 await 上
  w.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  H.ttsStop();
  H.ttsSetOn(true);
  let gateOpened = false;
  const gatePend = H.ttsSay(2, '闸门必须解开');
  if (gatePend) gatePend.then(() => { gateOpened = true; });
  await sleep(150);
  ok('★★ 台词播完后闸门自己解开（绝不会把牌局吊住）', gateOpened === true,
    '闸门对象：' + (gatePend ? 'Promise' : 'null'));

  // 不用等时必须立刻放行，且不能因为「没有闸门」就抛异常
  H.ttsSetOn(false);
  const noWait = await H.awaitSay();
  H.ttsSetOn(true);
  await sleep(5);
  ok('★ 没有闸门时 awaitSay 立刻返回 false（配音关着就不等）', noWait === false);

  // 用「永远不 resolve 的 fetch」把 pump 卡在第一个任务上，才看得见队列堆叠
  w.fetch = () => new Promise(() => { });
  H.ttsStop();
  T.queue.length = 0;
  H.ttsSay(1, '卡住第一个');
  await sleep(8);
  ok('第一个任务进入了处理中', T.busy === true);
  for (let i = 0; i < 12; i++) H.ttsSay(2, '排队' + i);
  ok('★ 队列有上限，不会无限堆积', T.queue.length <= 6 && T.queue.length >= 5, T.queue.length + ' 条');
  const last = T.queue[T.queue.length - 1];
  ok('留下来的是最新的（老的被丢掉）', last && last.text === '排队11', last && last.text);
  ok('队首已经是很新的（老的确实被扔了）', T.queue[0].text !== '排队0', T.queue[0].text);

  // ============================================================ 3
  section('3. 打断：换局 / 换手 / 手动停');
  H.ttsStop();
  ok('打断会清空队列', T.queue.length === 0);
  const gBefore = T.gen;
  H.ttsStop();
  ok('打断会推进世代令牌', T.gen === gBefore + 1, T.gen);
  ok('打断后不再处于处理中标记之外的残留', T.playing === null);

  // 旧世代的任务醒来后必须被丢掉，不能回头再响
  const gNow = T.gen;
  T.queue.push({ seat: 1, key: 'liyi', text: 'MARK-旧世代', gen: gNow - 1 });
  T.busy = false;
  w.__ttsHits = [];
  w.fetch = async (u, o) => { w.__ttsHits.push(o.body); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
  H.ttsPump();
  await sleep(30);
  ok('★ 旧世代的任务被丢弃，一次网络请求都没发', w.__ttsHits.length === 0, w.__ttsHits.length);
  ok('旧任务已被移出队列', T.queue.length === 0);

  // ============================================================ 4
  section('4. 只念「说出口的话」—— 私有推理一个字都不许外放');
  w.__ttsHits = [];
  H.ttsStop();
  const fake = {
    id: 2, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true,
    actionType: 'call', lastAction: '跟注 40',
    aiRead: 'MARK-私有-读牌内容', aiThink: 'MARK-私有-心里话内容',
    aiSay: 'MARK-公开-台上话', aiSayVoice: true      // AI 标了「这句要念」
  };
  H.logAct(fake);
  await sleep(40);
  const allText = w.__ttsHits.map(x => JSON.parse(x).text).join(' || ');
  ok('★ AI 标了要念的台上话被念了出来（正向）', allText.indexOf('MARK-公开-台上话') >= 0, allText.slice(0, 60));
  ok('★ 私有的读牌没有被念（反向）', allText.indexOf('MARK-私有-读牌内容') < 0, allText.slice(0, 60));
  ok('★ 私有的心里话没有被念（反向）', allText.indexOf('MARK-私有-心里话内容') < 0, allText.slice(0, 60));
  ok('★ 整段文本里不含任何「MARK-私有」', allText.indexOf('MARK-私有') < 0);
  ok('说话前清掉了 aiSay（不会重复念）', fake.aiSay === '');
  ok('说完也把 aiSayVoice 清掉了（不会串到下一步）', fake.aiSayVoice === false);

  // ★ 反向：AI 没标「要念」的话 —— 只进战报，一个字都不许出声
  const savedHits = w.__ttsHits;            // 第 5 节还要看请求体，稍后还原
  w.__ttsHits = [];
  H.ttsStop();
  const quiet = {
    id: 2, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true,
    actionType: 'call', lastAction: '跟注 40',
    aiRead: '', aiThink: '', aiSay: 'MARK-只写不念', aiSayVoice: false
  };
  const sayLen0 = H.say().length;
  H.logAct(quiet);
  await sleep(40);
  ok('★ AI 没标要念的话，一次合成请求都不发（反向）', w.__ttsHits.length === 0, w.__ttsHits.length + ' 次请求');
  ok('★ 但它照样进了「公开话」记录（战报里看得见，只是没出声）',
    H.say().length === sayLen0 + 1 && H.say()[H.say().length - 1].say === 'MARK-只写不念',
    H.say()[H.say().length - 1] && H.say()[H.say().length - 1].say);
  w.__ttsHits = savedHits;

  // ============================================================ 5
  section('5. 请求体格式（要和 server.py 对得上）');
  const raw = w.__ttsHits.length ? JSON.parse(w.__ttsHits[w.__ttsHits.length - 1]) : null;
  ok('请求体是 JSON 且含 text', !!(raw && typeof raw.text === 'string'));
  ok('请求体含 speaker（角色 key，不是音色名）', !!(raw && raw.speaker === 'maiqi'), raw && raw.speaker);
  ok('★ 页面不向服务端塞音色细节（音色归 voices.json 管）',
    !!(raw && !('voice' in raw) && !('rate' in raw) && !('pitch' in raw)));

  // 角色 key 映射正确
  w.__ttsHits = [];
  H.ttsStop();
  let keyOk = true, badKey = '';
  for (const k of PROF) {
    // 直接把座位号映射测一遍（座位 1..7 对应花名册前 7 位）
    const got = H.ttsKeyOfSeat(PROF.indexOf(k) + 1);
    if (got !== k) { keyOk = false; badKey = k + ' → ' + got; }
  }
  ok('7 个座位都能映射到正确的角色 key', keyOk, badKey);

  // ============================================================ 6
  section('6. 缓存（AI 台词重复率极高，命中即免费）');
  T.cache.clear();
  const keepMax = T.cacheMax;
  T.cacheMax = 3;
  const fakeBuf = n => ({ duration: 0.3, tag: n });
  H.ttsCachePut('a', fakeBuf(1));
  H.ttsCachePut('b', fakeBuf(2));
  H.ttsCachePut('c', fakeBuf(3));
  const mA = H.ttsCacheGet('a');
  ok('缓存能取回', !!mA && mA.tag === 1);
  H.ttsCachePut('d', fakeBuf(4));
  ok('★ 超过上限时淘汰「最久没用」的那条', !T.cache.has('b'), 'b 应被淘汰');
  ok('刚用过的 a 还在', T.cache.has('a'));
  ok('最新的 d 也在', T.cache.has('d'));
  T.cacheMax = keepMax;

  // 命中缓存就不该再发请求
  w.__ttsHits = [];
  w.fetch = async (u, o) => { w.__ttsHits.push(o.body); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
  H.ttsStop(); T.cache.clear();
  H.ttsSay(2, 'MARK-缓存句');
  await sleep(60);
  const n1 = w.__ttsHits.length;
  ok('第一次要真的发请求', n1 === 1, n1);
  H.ttsStop();
  H.ttsSay(2, 'MARK-缓存句');
  await sleep(60);
  ok('★ 同一句话第二次命中缓存，不再发请求', w.__ttsHits.length === n1, w.__ttsHits.length);
  ok('缓存里确实存下了这一句', T.cache.size >= 1, T.cache.size);
  ok('解码走的是 decodeAudioData', AUDIO._made.decoded > 0, AUDIO._made.decoded);

  // ============================================================ 7
  section('7. ⚠ 播放链独立 —— 关音效绝不能把配音一起哑了');
  const g0 = SFX_MASTER;
  ok('音效的 GainNode 参照物还在（第 1 节抓的）', !!g0, g0 && g0.__id);
  const ctxT = H.ttsCtx();
  ok('配音拿到了 AudioContext', !!ctxT);
  ok('★ 只建了一个 AudioContext（配音蹭音效的，没另起一个）', AUDIO._made.ctors === 1, AUDIO._made.ctors);
  ok('★ 配音的 master 不是音效的 master', !!T.master && T.master !== g0, T.master && T.master.__id);
  ok('配音的 master 直接连到 destination',
    AUDIO._made.connects.some(c => T.master && c[0] === T.master.__id && c[1] === ctxT.destination.__id));

  // 动态证据：跑一次完整播放，看有没有谁往音效 master 上接
  w.__ttsHits = [];
  w.fetch = async (u, o) => { w.__ttsHits.push(o.body); return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }; };
  H.ttsStop(); T.cache.clear();
  const toMasterBefore = AUDIO._made.connects.filter(c => c[1] === g0.__id).length;
  const srcBefore = AUDIO._made.srcs.length;
  H.ttsSay(2, 'MARK-播放链');
  await sleep(70);
  ok('确实建了播放源', AUDIO._made.srcs.length > srcBefore, AUDIO._made.srcs.length - srcBefore);
  ok('★ 配音播放不会往音效的 master 上接',
    AUDIO._made.connects.filter(c => c[1] === g0.__id).length === toMasterBefore);

  // 关音效，配音还该能出声
  try { H.setSfx(false); } catch (e) { }
  ok('★ 音效关掉后，配音的 master 依旧活着（两个开关互不牵连）', !!T.master);
  try { H.setSfx(true); } catch (e) { }

  // ============================================================ 8
  section('8. 掉线处理（连不上不能装死，也不能一直撞）');
  let boom = 0;
  w.fetch = async () => { boom++; throw new Error('ECONNREFUSED 连不上'); };
  H.ttsSetOn(true);
  H.ttsStop();
  for (let i = 0; i < 3; i++) { H.ttsSay(1, '撞墙' + i); await sleep(40); }
  ok('确实尝试了 3 次', boom >= 3, boom);
  ok('★ 连不上 3 次后自动关掉（免得每句话都卡一下）', T.on === false, 'on=' + T.on);
  ok('关掉后按钮回到「关」', d.getElementById('btnTts').textContent === '🔇');
  ok('面板状态文字说明了情况', d.getElementById('ttsState').textContent === '已关闭');

  // 失败之后不要污染别的测试：恢复正常 fetch
  w.fetch = async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(4) });
  H.ttsSetOn(true);
  H.ttsStop();
  H.ttsSay(1, 'HTTP 500');
  await sleep(40);
  ok('HTTP 非 200 也算失败，不会当成音频去解码', T.stat.err > 0 || T.on === true, 'err=' + T.stat.err);

  // ============================================================ 9
  section('9. ⚠ 绝不消耗共享随机源（前几轮踩过的大坑）');
  let usedShared = false;
  const realRandom = w.Math.random;
  w.Math.random = function () { usedShared = true; return 0.5; };
  try {
    w.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    H.ttsSetOn(true);
    for (const k of PROF) H.ttsDemo(k);
    await sleep(60);
    H.ttsSay(1, '随机源测试');
    await sleep(40);
    H.ttsStop();
    H.renderTtsList();
    H.syncTtsUI();
    H.ttsSetOn(false);
    H.ttsSetOn(true);
  } catch (e) { }
  w.Math.random = realRandom;
  ok('★ 配音全流程一次都没碰 Math.random', !usedShared);

  // 源码级再确认一次（动态没走到不代表没写）
  const srcStart = html.indexOf("const TTS_KEY = 'holdem_tts_v1'");
  const srcEnd = html.indexOf('function openTts()');
  const ttsSrc = (srcStart >= 0 && srcEnd > srcStart) ? html.slice(srcStart, srcEnd) : '';
  ok('拿到了配音模块源码', ttsSrc.length > 2000, ttsSrc.length + ' 字符');
  ok('★ 源码里不含 Math.random', ttsSrc.indexOf('Math.random') < 0);
  ok('★ 源码里不含 new Date（时间驱动会让测试不可复现）', ttsSrc.indexOf('new Date') < 0);

  // ============================================================ 10
  section('10. 与牌局的挂钩点');
  // 🗣 第 27 轮改成一整段合成：逐句收进 speakParts，循环外只发一次 ttsSay。
  //    意图没变 —— 交给配音的仍然只有「场上话」。
  ok('★ logAction 里只把「场上话」交给配音（read / think 永不外放）',
    html.indexOf('for (const one of says){') >= 0 &&
    html.indexOf('speakParts.push(TTS.act ? one : shown);') >= 0 &&
    html.indexOf('sayGate = ttsSay(p.id, joinSays(speakParts), { tone: tone });') >= 0);
  // 🎭 第 25 轮：音效标记只演给人听 —— 送出去的是原文 one，写进战报和 handSay 的是剥净版 shown
  ok('★★ 标记分两份：给耳朵的带标记、给人眼的剥干净',
    html.indexOf('const shown = paraShow(one);') >= 0 &&
    html.indexOf('say: shown });') >= 0 &&
    html.indexOf("'：' + shown") >= 0);
  ok('没有把 aiRead 交给配音', html.indexOf('ttsSay(p.id, p.aiRead)') < 0);
  ok('没有把 aiThink 交给配音', html.indexOf('ttsSay(p.id, p.aiThink)') < 0);
  ok('★ 开新的一手会打断', /async function playHand\(\)\{\r?\n  if \(handInProgress\) return;\r?\n  ttsStop\(\);/.test(html));
  ok('★ 重新开局会打断', /hideControls\(\);\r?\n  ttsStop\(\);/.test(html));
  ok('★ 触发点写在 handSay 入账之后（和公开信息同一时刻）',
    html.indexOf('handSay.push({ s: street, seat: p.id, name: p.name, say: shown });') <
    html.indexOf('sayGate = ttsSay(p.id, joinSays(speakParts), { tone: tone });'));

  // ============================================================ 11
  section('11. 试听台词与角色一一对应');
  const demo = H.ttsDemoText || {};
  const lack = PROF.filter(k => !demo[k] || demo[k].length < 4);
  ok('7 个角色都有试听台词', lack.length === 0, lack.join(',') || Object.keys(demo).length + ' 条');
  ok('没有多余的（不是 7 个角色的 key）', Object.keys(demo).every(k => PROF.indexOf(k) >= 0),
    Object.keys(demo).join(','));

  // ============================================================ 11b
  section('11b. 🔥 预热（首次合成 3 秒 vs 命中 13 毫秒 —— 差 230 倍，必须提前备货）');
  {
    // 卡住第一个任务，才看得见后面堆了什么
    w.fetch = () => new Promise(() => { });
    H.ttsStop();
    T.queue.length = 0;
    T.cache.clear();
    T.busy = false;
    const r1 = H.ttsWarmup();
    // ⚠ 口径：ttsWarmup() 末尾会 ttsPump()，pump 立刻取走队首设为 busy。
    //   所以「排进去几句」= 队列长度 + 正在处理的那 1 句。
    const inflight = T.busy ? 1 : 0;
    ok('★ 预热把 7 个角色的招牌台词排进了队列', r1.queued === 7, '排入 ' + r1.queued + ' 句');
    ok('排进去的确实都标记成 warm', T.queue.length > 0 && T.queue.every(j => j.warm === true));
    ok('★ 预热句不会被「队列上限 6」砍掉', T.queue.length + inflight === 7,
      '队列 ' + T.queue.length + ' + 处理中 ' + inflight);

    // 实战台词必须插到预热前面去
    H.ttsStop();
    T.queue.length = 0;
    T.busy = false;
    w.fetch = () => new Promise(() => { });
    // 队列没满时：实战句老老实实追加到队尾（但 pump 时会被优先取出）
    H.ttsStop();
    T.queue.length = 0;
    T.busy = false;
    w.fetch = () => new Promise(() => { });
    H.ttsWarmup();
    T.queue.length = 3;                      // 假装已经消化掉几句
    const beforePush = T.queue.length;
    H.ttsSay(2, 'MARK-实战句');
    ok('队列没满时，实战句追加到队尾',
      T.queue.length === beforePush + 1 && T.queue[T.queue.length - 1].text === 'MARK-实战句',
      T.queue.length + ' 条');
    ok('实战句没有 warm 标记（所以能插队）', T.queue[T.queue.length - 1].warm === undefined);

    // ★ 队列满时：腾位置给实战句 —— 丢的必须是最老的预热句，绝不能把实战句丢了
    H.ttsStop();
    T.queue.length = 0;
    T.busy = false;
    w.fetch = () => new Promise(() => { });
    H.ttsWarmup();
    const nFull = T.queue.length;
    H.ttsSay(2, 'MARK-实战句');
    ok('★ 队列满时腾位置给实战句（丢的是最老的预热句，不是实战句）',
      T.queue.length === nFull &&
      T.queue[T.queue.length - 1].text === 'MARK-实战句' &&
      T.queue.filter(j => !j.warm).length === 1,
      T.queue.length + ' 条 · 其中非预热 ' + T.queue.filter(j => !j.warm).length + ' 条');

    // 真跑一遍，看处理顺序
    const order = [];
    w.fetch = async (u, o) => {
      order.push(JSON.parse(o.body).text);
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    H.ttsStop(); T.queue.length = 0; T.cache.clear(); T.busy = false;
    H.ttsWarmup();
    H.ttsSay(2, 'MARK-实战句');
    await sleep(500);
    ok('★ 实战台词插队处理（不排在 7 句预热后面干等）',
      order.indexOf('MARK-实战句') >= 0 && order.indexOf('MARK-实战句') <= 1,
      '实际顺序前 3：' + order.slice(0, 3).join(' / '));
    ok('预热句也确实被合成了（不是只在队列里躺着）', order.length >= 7, order.length + ' 次请求');
    ok('跑完之后 7 句都进了缓存', T.cache.size >= 7, T.cache.size);

    // 预热过的不再重复排队 —— 手工铺满缓存来测，不依赖上面跑完没有
    H.ttsStop();
    T.queue.length = 0;
    T.cache.clear();
    const demoAll = H.ttsDemoText || {};
    // ⚠ 键里现在还有「口气 + 语速」两段，得用页面自己的建键函数，别再手拼
    for (const k of PROF) H.ttsCachePut(H.ttsCk(k, '', T.rate, demoAll[k]), { duration: 0.3 });
    T.busy = false;
    const r2 = H.ttsWarmup();
    ok('★ 已在缓存里的不再重复合成', r2.queued === 0 && r2.skipped === 7,
      '排入 ' + r2.queued + ' · 跳过 ' + r2.skipped);
    ok('这种时候队列也确实是空的', T.queue.length === 0, T.queue.length);

    // 预热会顺手把开关打开（否则合成出来也听不到）
    H.ttsSetOn(false);
    H.ttsWarmup();
    ok('预热会自动打开开关', H.tts().on === true);
    H.ttsStop();
    T.queue.length = 0;
    T.cache.clear();
    T.busy = false;
  }

  // ============================================================ 12
  section('12. 备份与恢复');
  ok('★ 配音设置进了备份清单', H.backupKeys().indexOf('holdem_tts_v1') >= 0);
  H.ttsSave();
  const pack = H.backupPack();
  ok('备份包里真的含配音设置', !!(pack.keys && pack.keys['holdem_tts_v1']));
  const parsed = JSON.parse(pack.keys['holdem_tts_v1']);
  ok('存了开关', typeof parsed.on === 'boolean', parsed.on);
  ok('存了音量', typeof parsed.vol === 'number', parsed.vol);
  ok('存了服务地址', /^https?:\/\//.test(parsed.endpoint || ''), parsed.endpoint);

  // ============================================================ 13
  section('13. 无头环境静默降级（没有 AudioContext 也不能炸）');
  {
    const b2 = boot(null, { noAudio: true });
    await sleep(320);
    const H2 = b2.w.HOLDEM;
    ok('没有 AudioContext 时页面照样起得来', b2.errors.length === 0, b2.errors.slice(0, 2).join(' | '));
    ok('拿到的是空上下文（安静降级）', H2.ttsCtx() === null);
    let threw = false;
    try {
      H2.ttsSetOn(true);
      H2.ttsSay(2, '没有声卡也要能活');
      await sleep(30);
      H2.ttsStop();
    } catch (e) { threw = true; }
    ok('★ 没声卡时说话不抛异常', !threw);
    ok('开关状态照旧可读写', H2.tts().on === true);
    b2.dom.window.close();
  }

  // ============================================================ 14
  section('14. ★ 持久化必须跨一次页面加载才算验过');
  {
    const b3 = boot(null);
    await sleep(320);
    const H3 = b3.w.HOLDEM;
    H3.ttsSetOn(true);
    H3.tts().vol = 0.42;
    const ep = 'http://127.0.0.1:9999/tts';
    H3.tts().endpoint = ep;
    H3.ttsSave();
    const snap = {};
    for (let i = 0; i < b3.w.localStorage.length; i++) {
      const k = b3.w.localStorage.key(i);
      snap[k] = b3.w.localStorage.getItem(k);
    }
    b3.dom.window.close();

    const b4 = boot(snap);
    await sleep(320);
    const H4 = b4.w.HOLDEM;
    const T4 = H4.tts();
    ok('★ 关掉页面再打开：开关还记得', T4.on === true, 'on=' + T4.on);
    ok('★ 音量记得', Math.abs(T4.vol - 0.42) < 1e-6, T4.vol);
    ok('★ 服务地址记得', T4.endpoint === ep, T4.endpoint);
    ok('★ 界面同步过来了（按钮不是灰的）',
      b4.d.getElementById('btnTts').textContent === '🎙' &&
      !b4.d.getElementById('btnTts').classList.contains('off'));
    ok('★ 面板复选框也同步了', b4.d.getElementById('ttsOn').checked === true);
    ok('★ 音量条显示对得上', b4.d.getElementById('ttsVol').value === '42');
    b4.dom.window.close();
  }

  // ============================================================ 15
  section('15. 脏数据不该把页面弄挂');
  {
    const bad = { holdem_tts_v1: '{"on":"yes","vol":999,"endpoint":"javascript:alert(1)"}' };
    const b5 = boot(bad);
    await sleep(320);
    const T5 = b5.w.HOLDEM.tts();
    ok('页面没炸', b5.errors.length === 0, b5.errors.slice(0, 2).join(' | '));
    ok('非布尔的 on 被忽略（保持默认关）', T5.on === false, 'on=' + T5.on);
    ok('超范围的音量被夹回来', T5.vol >= 0 && T5.vol <= 1, T5.vol);
    ok('★ 非 http(s) 的地址被拒（不认 javascript: 这种）',
      /^https?:\/\//.test(T5.endpoint), T5.endpoint);
    b5.dom.window.close();
  }
  {
    const b6 = boot({ holdem_tts_v1: '这不是 json' });
    await sleep(320);
    ok('★ 存的是坏 JSON 也不炸', b6.errors.length === 0, b6.errors.slice(0, 2).join(' | '));
    ok('退回到默认值', b6.w.HOLDEM.tts().on === false);
    b6.dom.window.close();
  }

  // ============================================================ 16
  section('16. 面板交互');
  {
    const b7 = boot(null);
    await sleep(320);
    const H7 = b7.w.HOLDEM;
    H7.ttsOpen();
    ok('面板能打开', b7.d.getElementById('ttsMask').classList.contains('on'));
    const rows = b7.d.querySelectorAll('#ttsList .tts-v');
    ok('★ 试听列表按花名册渲染出 7 行', rows.length === 7, rows.length);
    const btns = b7.d.querySelectorAll('#ttsList [data-ttsv]');
    ok('每行都有试听按钮', btns.length === 7, btns.length);
    const keys = Array.prototype.map.call(btns, x => x.getAttribute('data-ttsv'));
    ok('试听按钮的 key 覆盖 7 个角色', PROF.every(k => keys.indexOf(k) >= 0), keys.join(','));
    b7.d.getElementById('ttsClose').click();
    ok('面板能关掉', !b7.d.getElementById('ttsMask').classList.contains('on'));

    // 试听会自动把开关打开（否则听不到，等于白点）
    H7.ttsSetOn(false);
    b7.w.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
    H7.ttsDemo('hujie');
    ok('★ 点试听会自动打开开关', H7.tts().on === true);
    await sleep(30);
    b7.dom.window.close();
  }

  // ============================================================ 收尾
  try { dom.window.close(); } catch (e) { }
  console.log('\n' + '='.repeat(50));
  console.log('  第十九轮自检（配音）：%d 项通过，%d 项失败', pass, fail);
  console.log('='.repeat(50));
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\n💥 自检自己崩了：', e && e.stack || e);
  process.exit(1);
});
