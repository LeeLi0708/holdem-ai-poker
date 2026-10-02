/* =========================================================================
   Token 与花费实测
   -------------------------------------------------------------------------
   用真实分词器（cl100k_base，与 DeepSeek 的 BPE 同源，中文误差约 ±10%）
   数出每一次请求的实际 token 量，并按 DeepSeek 官方价目折算花费。

   缓存命中怎么模拟（按 DeepSeek 官方规则）：
     上下文缓存是「前缀匹配、以 64 token 为块」。本项目每次请求都是 [system, user]，
     system 里前半段（人设 / 规矩 / 档位表 / 输出契约）恒定，后半段（长期记忆、
     最近手记）会随手数变。所以真正能命中的是「与上一次完全相同的那段前缀」，
     向下取整到 64 token 的整块。
     user（本局局面快照）每次都不同，必然全部未命中。
   ========================================================================= */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { encodingForModel } = require('js-tiktoken');

const html = fs.readFileSync(path.join(__dirname, '..', '德州扑克.html'), 'utf8');
const enc = encodingForModel('gpt-4o');          // cl100k_base
const tok = s => enc.encode(String(s === undefined || s === null ? '' : s)).length;

/* ---------------- 价目（元 / 百万 token，空闲时段；高峰 ×2） ---------------- */
const PRICE = {
  'deepseek-v4-flash': { hit: 0.05, miss: 1.5, out: 4.5 },
  'deepseek-v4-pro':   { hit: 0.15, miss: 4.5, out: 13.5 }
};

/* ---------------- mock 接口 ---------------- */
const records = [];                 // 每一次请求的明细
const lastSys = new Map();          // 「谁+类型」→ 上一次的 system token 序列（用于算最长公共前缀）
let decideSeq = 0;
const BLOCK = 64;                   // DeepSeek 的缓存以 64 token 为一块，不足一块不命中
const thinkingSent = { n: 0, total: 0 };

const READ_MARK = 'MARK-读牌-私有';
const THINK_MARK = 'MARK-心里话-私有';
const SAY_MARK = 'MARK-场上话-公开';

function usageReply(content, usage){
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve({
      choices: [{ message: { content: content } }],
      usage: usage
    }),
    text: () => Promise.resolve(content)
  });
}

function classify(msgs){
  const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
  const users = msgs.filter(m => m.role === 'user');
  const first = (users[0] || {}).content || '';
  if (sys.indexOf('连通性探针') >= 0) return { kind: 'probe', sys, usr: first };
  if (first.indexOf('合并成一段新的长期记忆') >= 0) return { kind: 'reflect', sys, usr: first };
  return { kind: 'decide', sys, usr: first };
}

function mockFetch(url, opts){
  const body = JSON.parse(opts.body);
  const info = classify(body.messages);
  const m = info.sys.match(/你叫([^\s，,。]+)[，,]/);
  const who = m ? m[1] : '?';

  /* --- 用真实分词器数输入，并按「64 token 块的前缀匹配」算缓存命中 --- */
  const key = who + '|' + info.kind;
  const sysArr = enc.encode(info.sys);
  const prevArr = lastSys.get(key) || [];
  let common = 0;
  const minLen = Math.min(sysArr.length, prevArr.length);
  while (common < minLen && sysArr[common] === prevArr[common]) common++;
  lastSys.set(key, sysArr);
  const hit  = Math.floor(common / BLOCK) * BLOCK;    // 只有整块才可能命中
  const sysTok = sysArr.length;
  const usrTok = tok(info.usr);
  const miss = usrTok + (sysTok - hit);
  const prompt = hit + miss;

  if (body.thinking) thinkingSent.n++;
  thinkingSent.total++;

  /* --- 造一个长度贴近真实输出的回答 --- */
  let answer;
  if (info.kind === 'probe') answer = '{"ok":true}';
  else if (info.kind === 'reflect'){
    answer = JSON.stringify({
      memory: who + '这五手收紧了不少。桌上普遍松，我拿边缘牌跟大注吃过亏，之后只在位置好、牌够硬时才进池，别被连续小注骗进来。',
      milestones: ['第 12 手全下被清过，之后不拿边缘牌接大注']
    });
  } else {
    decideSeq++;
    const needCall = info.usr.match(/要跟 (\d+) 才能继续/);
    // ALL_CALL=1 → 没人弃牌，7 个人一路打到河牌，这是「一手牌请求数」的上限场景
    const action = process.env.ALL_CALL === '1'
      ? (needCall ? 'call' : 'check')
      : (needCall ? ['call', 'fold', 'call', 'raise'][decideSeq % 4] : ['check', 'raise', 'check'][decideSeq % 3]);
    answer = JSON.stringify({
      action: action,
      size: action === 'raise' ? 'three_quarter' : null,
      amount: 99999999,                       // 故意带上，验证程序完全不理会
      read: who + ' 读牌：' + READ_MARK,
      think: THINK_MARK + '-' + who,
      say: SAY_MARK
    });
  }
  const outTok = tok(answer);

  const usage = {
    prompt_tokens: prompt,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    completion_tokens: outTok,
    total_tokens: prompt + outTok
  };
  records.push({
    kind: info.kind, who, sysTok, usrTok, hit, miss, outTok,
    sysLen: info.sys.length, usrLen: info.usr.length, rawLen: answer.length,
    cached: hit > 0
  });
  return usageReply(answer, usage);
}

/* ---------------- 加载页面 ---------------- */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => { });

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
  q('aiKey').value = 'sk-test-token-measure';
  q('aiModel').value = 'deepseek-v4-flash';
  q('aiSeats').value = '7';
  q('aiReflect').value = '5';
  q('aiSave').click();
  q('aiClose').click();
  // 顶栏的「🧠 AI 大脑」总开关必须打开，否则整个大脑链路是关的
  const tg = q('tgBrain');
  tg.checked = true;
  tg.dispatchEvent(new w.Event('change'));
  await sleep(120);
  if (!q('tgBrain').checked) console.log('⚠️ 大脑总开关没打开，后面会全是本地速算');
  q('btnAILog').click();
  q('ailogClear').click();     // 清掉开局的零碎记录，统计从干净状态起步
  q('ailogClose').click();
  await sleep(30);

  const HANDS = 20;
  // 驱动：人类一律弃牌，每手给足筹码，避免他出局触发重开局打断统计
  let done = 0;
  const hardStop = Date.now() + 300000;
  while (done < HANDS && Date.now() < hardStop){
    let idle = false;
    const w1 = Date.now();
    while (Date.now() - w1 < 30000){
      if (!q('btnNext').disabled){ idle = true; break; }
      if (!q('btnFold').disabled) q('btnFold').click();
      await sleep(6);
    }
    if (!idle) continue;
    const me = H.players()[0];
    if (me && me.chips < 800) me.chips = 1000;
    q('btnNext').click();
    done++;
    const w2 = Date.now();
    while (Date.now() - w2 < 60000){
      if (!q('btnFold').disabled) q('btnFold').click();
      if (!q('btnNext').disabled) break;
      await sleep(6);
    }
  }

  /* ---------------- 统计 ---------------- */
  const dec = records.filter(r => r.kind === 'decide');
  const ref = records.filter(r => r.kind === 'reflect');
  const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  const avg = (arr, k) => arr.length ? sum(arr, k) / arr.length : 0;

  const hands = done || 1;
  console.log('\n================ Token 与花费实测 ================');
  console.log('跑了 ' + hands + ' 手，共 ' + records.length + ' 次请求' +
    (errors.length ? '  ⚠️ 脚本报错 ' + errors.length + ' 条' : '  ✅ 零脚本错误'));
  console.log('分词器：cl100k_base（与 DeepSeek 同源的 BPE，中文误差约 ±10%）\n');

  console.log('—— 单次「决策」请求 ——');
  console.log('  系统提示词（人设+规矩+档位表+输出契约） : ' + avg(dec, 'sysTok').toFixed(0) + ' token  (' + avg(dec, 'sysLen').toFixed(0) + ' 字)');
  console.log('  局面快照（每步都不同）                 : ' + avg(dec, 'usrTok').toFixed(0) + ' token  (' + avg(dec, 'usrLen').toFixed(0) + ' 字)');
  console.log('  ├ 缓存命中  : ' + avg(dec, 'hit').toFixed(0) + ' token');
  console.log('  └ 缓存未命中: ' + avg(dec, 'miss').toFixed(0) + ' token');
  console.log('  模型输出                               : ' + avg(dec, 'outTok').toFixed(0) + ' token');
  console.log('  命中率                                 : ' + (sum(dec, 'hit') / (sum(dec, 'hit') + sum(dec, 'miss')) * 100).toFixed(1) + '%');

  console.log('\n—— 单次「复盘」请求 ——');
  if (ref.length) {
    console.log('  输入 ' + avg(ref, 'hit').toFixed(0) + ' 命中 + ' + avg(ref, 'miss').toFixed(0) + ' 未命中 · 输出 ' + avg(ref, 'outTok').toFixed(0) + ' token');
  } else {
    console.log('  （这次没触发复盘）');
  }

  console.log('\n—— 每一手牌 ——');
  const perHandDec = dec.length / hands;
  const perHandRef = ref.length / hands;
  console.log('  决策请求 ' + perHandDec.toFixed(1) + ' 次 · 复盘请求 ' + perHandRef.toFixed(2) + ' 次（每 5 手一次，摊到每手）');
  const inHit = sum(dec, 'hit') / hands + sum(ref, 'hit') / hands;
  const inMiss = sum(dec, 'miss') / hands + sum(ref, 'miss') / hands;
  const outTok = sum(dec, 'outTok') / hands + sum(ref, 'outTok') / hands;
  console.log('  输入命中  : ' + inHit.toFixed(0) + ' token');
  console.log('  输入未命中: ' + inMiss.toFixed(0) + ' token');
  console.log('  输出      : ' + outTok.toFixed(0) + ' token');
  console.log('  合计      : ' + (inHit + inMiss + outTok).toFixed(0) + ' token');

  function cost(hit, miss, out, model){
    const p = PRICE[model];
    return (hit * p.hit + miss * p.miss + out * p.out) / 1e6;
  }
  console.log('\n—— 花费（deepseek-v4-flash）——');
  const flashOff = cost(inHit, inMiss, outTok, 'deepseek-v4-flash');
  const flashPeak = flashOff * 2;
  console.log('  每手         空闲时段 ¥' + flashOff.toFixed(4) + '  ·  高峰时段 ¥' + flashPeak.toFixed(4));
  console.log('  10 手        空闲 ¥' + (flashOff * 10).toFixed(3) + '  ·  高峰 ¥' + (flashPeak * 10).toFixed(3));
  console.log('  100 手       空闲 ¥' + (flashOff * 100).toFixed(2) + '  ·  高峰 ¥' + (flashPeak * 100).toFixed(2));
  console.log('  1000 手      空闲 ¥' + (flashOff * 1000).toFixed(2) + '  ·  高峰 ¥' + (flashPeak * 1000).toFixed(2));

  const H2 = records.length;
  console.log('\n—— 对照：deepseek-v4-pro ——');
  const proOff = cost(inHit, inMiss, outTok, 'deepseek-v4-pro');
  console.log('  每手         空闲 ¥' + proOff.toFixed(4) + '  ·  高峰 ¥' + (proOff * 2).toFixed(4));
  console.log('  100 手       空闲 ¥' + (proOff * 100).toFixed(2) + '  ·  高峰 ¥' + (proOff * 200).toFixed(2));

  console.log('\n—— 页面真实计量是否接上了 ——');
  const st = H.aistat();
  console.log('  AISTAT: 请求 ' + st.calls + ' 次 · 入 ' + st.tokIn + ' · 命中 ' + st.tokHit +
              ' · 出 ' + st.tokOut + ' · 估算花费 ¥' + st.spent.toFixed(6));
  q('btnAILog').click();
  console.log('  日志面板合计行: ' + q('ailogSub').textContent);
  console.log('  单条 token 标签数量: ' + d.querySelectorAll('#ailogList .ailog-tok').length);

  console.log('\n—— 请求体核对 ——');
  console.log('  带 thinking=disabled 的请求: ' + thinkingSent.n + ' / ' + thinkingSent.total +
    (thinkingSent.n === thinkingSent.total ? '  ✅ 思考模式全程关闭' : '  ❌ 有请求漏了'));
  console.log('  观察到的 system 变体数: ' + lastSys.size + '（7 个 AI + 复盘，各自独立缓存）');
})();
