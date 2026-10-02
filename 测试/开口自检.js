/* =========================================================================
   第二十六轮自检 —— 🗣 AI 开口（「为什么没有人讲话了」的修复）
   -------------------------------------------------------------------------
   病根（2026-10-02 用户反馈，从导出日志里挖出来的）：

     ① 日志 3 条 decide 全是 say:[]，而同一份输出里 read / think 都有内容。
        对照极其鲜明 —— 凡是被提示词「明确允许留空」的字段一律取了空值：
          read   无「可留空」说明 → 3/3 有内容
          think  无「可留空」说明 → 3/3 有内容
          say    明说「不想开口就给空数组 []」→ 3/3 空
          voice  明说「绝大多数时候填 0」     → 3/3 = 0
          tone   明说「绝大多数时候留空」     → 3/3 = ""
        加上第二十五轮顺手写下的「多数台词一个都不用」—— 歧义太大，等于又劝退一次。

     ② lite 档（翻牌前无人加注 / 翻牌圈无人下注，每手牌几乎必走）
        看不到【桌上说出口的话】。于是「没人说 → 看不到话 → 更不说」自我强化。

   本自检守的就是这两件事，全部走**真实链路**（logAct → handSay → stateText），
   不自己手搓字符串去比 —— 那种测法测不出「指向错了」。
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

/* ---------- 可控播放的 AudioContext 假件 ---------- */
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

// 造一条「某人开口说了几句」的真实记录 —— 走 logAct，不手搓 handSay
const SPEAKER = { id: 3, name: '麦琪', emoji: '🔥', isHuman: false, brainUsed: true,
                  actionType: 'raise', aiRead: '', aiThink: '', aiSays: [], aiSay: '', aiSayVoice: false };

(async () => {

  // ============================================================ 1
  section('1. 提示词：把「不开口」的出口收掉');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];
    const sys = H.sysText(P);

    ok('页面起得来，没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    ok('导出里有开口相关接口', !!(H && H.sysText && H.stateText && H.sayText && H.logAct && H.tier), 'ok');

    ok('★★ 提示词里不再有「不想开口就给空数组」这个默认出口',
      sys.indexOf('不想开口就给空数组') < 0);
    ok('★★ 提示词里不再有「多数台词一个都不用」（歧义句已删）',
      sys.indexOf('多数台词一个都不用') < 0);
    ok('★★ 换成了正面引导「这是一张活桌子」', sys.indexOf('这是一张活桌子') >= 0);
    ok('★ 但「空数组」三个字仍然保留 —— 不是一味鼓励话痨，少数场合照样可以不说',
      sys.indexOf('空数组') >= 0);
    ok('★ 上限仍然写着「最多 3 句」（没被顺手改掉）', sys.indexOf('最多 3 句') >= 0);
    ok('★ 第二十五轮的副语言标记说明还在（没被这次改动碰坏）',
      sys.indexOf('[laughter]') >= 0 && sys.indexOf('[sigh]') >= 0 && sys.indexOf('[breath]') >= 0);
    ok('★ 口气（tone）的说明还在（第二十四轮的东西没丢；slow 于第二十九轮下架）',
      sys.indexOf('hot 恼火') >= 0 && sys.indexOf('glad 得意') >= 0 && sys.indexOf('slow') < 0);

    A.w.close();
  }

  // ============================================================ 2
  section('2. 没人开口时：不留「没人说话」的暗示');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];

    ok('开局公开话记录是空的（前提成立，后面的断言才有意义）',
      H.say().length === 0, H.say().length + ' 条');

    const t = H.sayText(P);
    ok('★★ 没人说过话时 sayText 返回空串', t === '', JSON.stringify(t));
    ok('★★ 不再是「（这一手还没人开口。）」那行字', t.indexOf('还没人开口') < 0);

    const uLite = H.stateText(P, 10, 1100, 20, 'lite');
    ok('★★ lite 档：没人开口时，整段「桌上说出口的话」不出现',
      uLite.indexOf('桌上说出口的话') < 0);
    ok('★ 也不会冒出「还没人开口」这种消极暗示', uLite.indexOf('还没人开口') < 0);
    ok('★ lite 档该有的东西还在（【这一轮】）', uLite.indexOf('【这一轮】') >= 0);

    A.w.close();
  }

  // ============================================================ 3
  section('3. ★★★ 有人开口后：lite 档必须看得到（本轮修的核心）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];                       // 李姨（日志里那个）
    const SAY1 = '这手牌我陪你玩到底。';
    const SAY2 = '别磨蹭了，跟还是不跟？';

    // 走真实链路：logAct → handSay.push
    H.logAct(Object.assign({}, SPEAKER, { aiSays: [SAY1, SAY2] }));
    await sleep(80);

    ok('★ 那两句确实进了公开话记录（真实链路）',
      H.say().filter(x => x.say === SAY1 || x.say === SAY2).length === 2,
      H.say().length + ' 条');

    // ---- 正向：旁观者看得到
    const uLite = H.stateText(P, 10, 1100, 20, 'lite');
    ok('★★★ lite 档现在能看到「【桌上说出口的话】」这一段',
      uLite.indexOf('【桌上说出口的话】') >= 0);
    ok('★★★ 而且看得到具体说了什么', uLite.indexOf(SAY1) >= 0 && uLite.indexOf(SAY2) >= 0);
    ok('★ 带上了说话人的名字', uLite.indexOf('麦琪：') >= 0);
    ok('★ lite 档别的硬信息没被这段挤掉（【这一轮】还在）', uLite.indexOf('【这一轮】') >= 0);

    // ---- 反向：说话的人自己看不到自己这句
    const me = H.players().find(x => x.id === SPEAKER.id) || { id: SPEAKER.id };
    const tMine = H.sayText(me);
    ok('★★ 反向：说话的人自己看不到自己那句（别人只听得见别人的）',
      tMine.indexOf(SAY1) < 0, JSON.stringify(String(tMine).slice(0, 40)));

    // ---- full 档不能因为修 lite 而弄丢
    const uFull = H.stateText(P, 10, 1100, 20, 'full');
    ok('★★ full 档照样有这一段（没有为了修 lite 把 full 弄坏）',
      uFull.indexOf('【桌上说出口的话】') >= 0 && uFull.indexOf(SAY1) >= 0);

    // ---- 上限：只摆最近 6 句（别把 lite 档撑肥）
    for (let i = 0; i < 5; i++) H.logAct(Object.assign({}, SPEAKER, { aiSays: ['补第' + i + '句'] }));
    await sleep(120);
    const tNow = H.sayText(P);
    ok('★ 最多只摆最近 6 句（不会无限长）', (tNow || '').split('\n').length <= 6,
      (tNow || '').split('\n').length + ' 行');

    ok('整段没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  // ============================================================ 4
  section('4. ★★★ 复现用户那一刻：翻牌前 lite 档，也必须看得到别人说的话');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];                       // 李姨：日志里那个位置
    const LINE = '我先看看牌再说。';

    ok('★ 分层档位默认开着（否则「翻牌前走 lite」这回事根本不存在）',
      /layered:\s*true/.test(html), 'AICFG.layered');

    // 牌桌上已经有人开过口
    H.logAct(Object.assign({}, SPEAKER, { aiSays: [LINE] }));
    await sleep(60);

    // 复现日志里的局面：翻牌前、只有大盲（要跟 10）、没人加注
    const t0 = H.tier(P, 10);
    console.log('   ℹ 翻牌前（要跟 10）真实判定档位 = ' + t0);

    // ⚠ 关键：用**真实判定的档位**渲染，不自己指定 ——
    //   这样测的就是「用户那一刻实际会发生什么」。
    const u0 = H.stateText(P, 10, 1100, 20, t0);
    ok('★★★ 不管判成哪一档，usr 里都看得到桌上那句话（病根就在这）',
      u0.indexOf(LINE) >= 0, '档位=' + t0);
    ok('★★ 而且带上了「【桌上说出口的话】」这个小标题',
      u0.indexOf('【桌上说出口的话】') >= 0, '档位=' + t0);

    // 两码事要分清：**看得到别人的话** 和 **自己有没有话说**，是两条独立的链。
    // 这一段只负责前者；后者由提示词（第 1 节）负责。
    const u1 = H.stateText(P, 10, 1100, 20, 'lite');
    const u2 = H.stateText(P, 10, 1100, 20, 'full');
    ok('★★ 显式要 lite / full，两边都带这一段（不再有档位歧视）',
      u1.indexOf(LINE) >= 0 && u2.indexOf(LINE) >= 0);

    A.w.close();
  }

  // ============================================================ 5
  section('5. ★★★ 一次说三句 = 只发一次合成，但战报照旧三行（第二十七轮核心）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;

    // 记录每一次合成请求 —— 走真实链路，只看真正发出去的是什么
    const reqs = [];
    A.w.fetch = async (url, opt) => {
      try { reqs.push(JSON.parse(opt.body)); } catch (e) { reqs.push({ text: '<解析失败>' }); }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    H.ttsSetOn(true);
    await sleep(20);

    // ⚠ 假件的 start() 不会自己结尾，闸门会一直挂着、队列也就卡住。
    //   每次合成后手动让它播完 —— 否则第二次 logAct 的请求根本发不出去（假绿）。
    const flush = async () => { await sleep(60); AUDIO.ended(); await sleep(40); };

    const SAY = ['这手牌我不跟。', '你手气是真好。', '算了，我认了。'];
    H.logAct(Object.assign({}, SPEAKER, { aiSays: SAY, aiSayVoice: true }));
    await flush();

    const sent = reqs.filter(r => r && typeof r.text === 'string' && r.text);
    ok('★ 三句场上话只发了**一次**合成请求', sent.length === 1, sent.length + ' 次');
    ok('★★ 送合成的是一整段（三句连成一句、一口气念）',
      sent.length === 1 && sent[0].text === SAY.join(''), JSON.stringify(sent[0] && sent[0].text));
    ok('★★ 但战报/场上话仍是**三行**（显示层没被合并）',
      H.say().filter(x => SAY.indexOf(x.say) >= 0).length === 3,
      H.say().filter(x => SAY.indexOf(x.say) >= 0).length + ' 行');
    ok('★ 闸门是单个（不再是一把 Promise.all）',
      !!H.sayGate() && typeof H.sayGate().then === 'function');

    // 拼句规则：前一句末尾没标点，自动补句号 —— 免得两句粘成一个词
    ok('★ 前一句没句末标点 → 自动补句号',
      H.joinSays(['我加', '注']) === '我加。注', JSON.stringify(H.joinSays(['我加', '注'])));
    ok('★ 已有标点的不重复补', H.joinSays(['我加。', '注']) === '我加。注');
    ok('★ 空串/空值一律跳过', H.joinSays(['', null, '好。', '   ']) === '好。');

    // 缓存：同样三句再来一次，不该再发请求（键是整段文本）
    const before = reqs.length;
    H.logAct(Object.assign({}, SPEAKER, { aiSays: SAY, aiSayVoice: true }));
    await flush();
    ok('★ 同样三句再来一次 → 命中缓存，不再请求',
      reqs.length === before, (reqs.length - before) + ' 次新请求');

    // 不念的（voice=0）：一句都不发，闸门清空
    const before2 = reqs.length;
    H.logAct(Object.assign({}, SPEAKER, { aiSays: ['我不想说话。'], aiSayVoice: false }));
    await sleep(80);
    ok('★★ 没标要念 → 一次请求都不发，且闸门不留残',
      reqs.length === before2 && H.sayGate() === null,
      (reqs.length - before2) + ' 次请求 / gate=' + H.sayGate());

    // 口气开：整段里仍带着音效标记（合并没把标记弄丢）
    reqs.length = 0;
    H.setAct(true);
    H.logAct(Object.assign({}, SPEAKER, { aiSays: ['哈[laughter]哈。', '你也会怕？'], aiSayVoice: true }));
    await flush();
    const t1 = (reqs[0] || {}).text || '';
    ok('★★ 口气开：合并成整段后，标记仍在正确位置（送合成）',
      t1.indexOf('[laughter]') >= 0, JSON.stringify(t1));
    ok('★ 合并后的整段顺序正确', t1.indexOf('哈哈') < t1.indexOf('你也会怕'), JSON.stringify(t1));
    ok('★ 战报里那行是剥干净的（标记不给人看）',
      H.say().some(x => x.say === '哈哈。'), JSON.stringify(H.say().slice(-2).map(x => x.say)));

    // 口气关：连标记一起不演
    reqs.length = 0;
    H.setAct(false);
    H.logAct(Object.assign({}, SPEAKER, { aiSays: ['哈[laughter]哈。', '你也会怕？'], aiSayVoice: true }));
    await flush();
    const t2 = (reqs[0] || {}).text || '';
    ok('★★ 口气关：合并后的整段里标记一并剥掉（口径没变）',
      t2.indexOf('[laughter]') < 0, JSON.stringify(t2));

    ok('整段没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    A.w.close();
  }

  console.log('\n' + '='.repeat(52));
  console.log('  第二十六轮自检（AI 开口）：' + pass + ' 项通过，' + fail + ' 项失败');
  console.log('='.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检炸了:', e); process.exit(1); });
