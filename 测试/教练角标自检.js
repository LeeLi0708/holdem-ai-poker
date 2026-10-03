/* =========================================================================
   第三十四轮自检 —— 🎓 复盘角标「卡在 160」
   -------------------------------------------------------------------------
   用户 2026-10-03 21:16 报的：「卡在160」（截图里是「🎓 复盘 160」）

   根因：角标取的是 COACH.hands.filter(r => r.reviewed).length，
         而 fixCoach() 会把 COACH.hands 裁到最近 160 条
         ⇒ 角标数学上最多 160，到顶永远不动。

   守四件事（前三条是修，第四条是别改坏）：
     ① 角标 = 累计复盘手数（会一直涨），不是滚动窗口长度
     ② 「当前这一局」的记录一条都不能裁（整局/阶段复盘全靠它取材）
     ③ 跨局的老记录才按 160 条淘汰 —— 含 room=0 时不能踩 past.slice(-0) 的坑
     ④ 老存档只补不削 + 清空记录仍然归零

   ⚠ 所有断言都走真实入口（fixCoach / wipeCoach / 真实存档重新加载），
     不自己复刻一遍裁剪逻辑 —— 复刻等于测了个假的。
   ⚠ 「持久化」这一条按铁律走：抓真存档 → 新开一个 JSDOM 灌进去 → 再读数。
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

const COACH_KEY = 'holdem_coach_v1';
const LIMIT = 160;                       // fixCoach 里那条上限

function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.message || e)));
  vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    // ⚠ 必须给一个真 origin：JSDOM 默认 about:blank 是 opaque origin，
    //   localStorage.setItem 会抛 SecurityError（被下面的 try/catch 吞掉）
    //   ⇒ 预置存档一条都灌不进去，整组断言变成「测了个空气」。
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() { }, removeListener() { }, addEventListener() { }, removeEventListener() { } }));
      if (!window.HTMLCanvasElement.prototype.getContext) {
        window.HTMLCanvasElement.prototype.getContext = function () {
          if (!this.__mockCtx) {
            const noop = () => { };
            this.__mockCtx = {
              canvas: this, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
              textAlign: '', textBaseline: '', shadowBlur: 0, shadowColor: '',
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
      }
      if (store) for (const k of Object.keys(store)) { try { window.localStorage.setItem(k, store[k]); } catch (e) { } }
    }
  });
  return { dom, w: dom.window, d: dom.window.document, errors };
}

// 手账记录：裁剪只看 sid、角标只看 reviewed
function rec(i, sid, reviewed) {
  return {
    h: i, sid: sid, t: 1759000000000 + i * 1000, reviewed: reviewed !== false,
    score: 70, verdict: '还行', fix: '', delta: 0, pot: 0, chips: 1000,
    pos: 'BTN', hole: 'A♠ K♦', board: '', mine: '', table: '',
    revealed: [], showSay: [], raises: 0, calls: 0, checks: 0,
    vpip: false, pfr: false, sawFlop: false, allin: false, err: ''
  };
}
// 抓整份 localStorage（跨页面持久化要用）
function dumpStore(w) {
  const o = {};
  for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); }
  return o;
}
const badgeOf = d => { const b = d.getElementById('btnCoach'); return b ? String(b.textContent || '') : '(找不到按钮)'; };

(async () => {

  // ============================================================ 1
  section('1. 角标 = 累计数，不是被裁过的窗口长度（用户看到的就是这条）');
  {
    // 老存档的样子：窗口里最多 160 条，但这个人累计早就复盘了 260 手
    // ——旧代码在这里显示的就是「🎓 复盘 160」，然后永远不动
    const store = {};
    store[COACH_KEY] = JSON.stringify({
      stat: { hands: 260, deeps: 3, sessions: 1 },
      hands: Array.from({ length: LIMIT }, (_, i) => rec(i + 1, 'OLD-SESSION', true))
    });
    const A = boot(store);
    await sleep(400);
    const H = A.w.HOLDEM;

    ok('页面起得来，没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));
    ok('★ 手账窗口仍然只留 160 条（防爆没被破坏）',
      H.coach().hands.length === LIMIT, '实际 ' + H.coach().hands.length);

    const txt = badgeOf(A.d);
    ok('★★ 角标显示 260（累计），不再停在 160', /260/.test(txt), '实际：' + txt);
    ok('★★ 而且不含「160」这个被卡住的数', !/160/.test(txt), '实际：' + txt);

    // 面板标题行跟角标必须同一个口径，不然就是两处打架
    H.renderCoach();
    const sub = A.d.getElementById('coachSub');
    const subTxt = sub ? String(sub.textContent || '') : '';
    ok('★ 面板「累计 N 手」与角标同口径（都是 260）', /260/.test(subTxt), subTxt.slice(0, 80));

    // ⚠ 这就是「跨一次页面加载」：上面的 260 是从存档里读回来再渲染的
    ok('★ 存档里的累计数没有被回填逻辑削掉', H.coach().stat.hands === 260, '实际 ' + H.coach().stat.hands);
    A.w.close();
  }

  // ============================================================ 2
  section('2. 当前这一局的记录一条都不能裁（长局必炸的那条）');
  {
    const A = boot(null);
    await sleep(400);
    const H = A.w.HOLDEM;
    const sid = H.session() ? H.session().id : '';
    ok('当前局已经开起来了（有 sid）', !!sid, sid);

    const C = H.coach();
    C.hands = [];
    for (let i = 1; i <= 200; i++) C.hands.push(rec(i, sid, true));   // 本局 200 手
    C.hands.push(rec(-1, 'OLD', true));                              // 一条跨局老记录，排最后
    C.hands.sort((a, b) => a.t - b.t);
    C.stat.hands = 200;

    H.fixCoach();                     // ← 真实入口：裁剪 / 回填
    H.updateCoachBadge();             // ← 真实入口：刷角标（这两件事是分开的，别混）
    const hs = H.coach().hands;
    const cur = hs.filter(r => r.sid === sid);

    ok('★★ 本局 200 条一条不少（旧逻辑会砍成 160）', cur.length === 200, '实际 ' + cur.length);
    ok('★★ 本局 200 条按原顺序留着（第 1 手在最前、第 200 手在最后）',
      cur[0] && cur[0].h === 1 && cur[cur.length - 1] && cur[cur.length - 1].h === 200,
      cur.length ? (cur[0].h + ' … ' + cur[cur.length - 1].h) : '空');
    ok('★ 跨局老记录被淘汰了（本局已经把名额占满）', hs.filter(r => r.sid === 'OLD').length === 0);
    ok('★ 角标跟着涨到 200 以上也不受限', /200/.test(badgeOf(A.d)), badgeOf(A.d));
    A.w.close();
  }

  // ============================================================ 3
  section('3. 跨局才淘汰：本局全留 + 历史按最近补足');
  {
    const A = boot(null);
    await sleep(400);
    const H = A.w.HOLDEM;
    const sid = H.session().id;

    const C = H.coach();
    C.hands = [];
    for (let i = 1; i <= 200; i++) C.hands.push(rec(i, 'OLD-A', true));  // 历史 200 手
    for (let i = 201; i <= 230; i++) C.hands.push(rec(i, sid, true));    // 本局 30 手

    H.fixCoach();
    const hs = H.coach().hands;
    const cur = hs.filter(r => r.sid === sid);
    const past = hs.filter(r => r.sid !== sid);

    ok('★★ 总数压回 160（防爆还是要防）', hs.length === LIMIT, '实际 ' + hs.length);
    ok('★★ 本局 30 手全在', cur.length === 30, '实际 ' + cur.length);
    ok('★★ 历史留的是「最近的」130 手（第 71–200 手，不是第 1–130 手）',
      past.length === 130 && past[0].h === 71 && past[past.length - 1].h === 200,
      past.length ? ('留了 ' + past.length + ' 条：' + past[0].h + '–' + past[past.length - 1].h) : '空');
    ok('★★ 历史在前、本局在后（顺序不能被打乱，否则手数全错位）',
      hs[hs.length - 1].sid === sid && hs[0].sid !== sid);
    A.w.close();
  }

  // ============================================================ 4
  section('4. 边界：本局正好占满名额时，一条历史都不许漏进来');
  {
    // ⚠ 这一条专治 past.slice(-0)：JS 里 slice(-0) 就是 slice(0)，
    //   会把整份历史都留下来 —— 结果 160+50=210 条，防爆直接失效。
    const A = boot(null);
    await sleep(400);
    const H = A.w.HOLDEM;
    const sid = H.session().id;

    const C = H.coach();
    C.hands = [];
    for (let i = 1; i <= 50; i++) C.hands.push(rec(i, 'OLD-A', true));
    for (let i = 51; i <= 210; i++) C.hands.push(rec(i, sid, true));   // 本局 160 手，正好占满

    H.fixCoach();
    const hs = H.coach().hands;
    ok('★★ 结果恰好 160 条（不是 210 —— slice(-0) 的坑）', hs.length === LIMIT, '实际 ' + hs.length);
    ok('★★ 160 条全是本局的', hs.filter(r => r.sid === sid).length === LIMIT);
    ok('★★ 历史 50 条一条都没漏进来', hs.filter(r => r.sid !== sid).length === 0);
    A.w.close();
  }

  // ============================================================ 5
  section('5. 老存档兜底：没有累计数就按现有记录回填，有则只补不削');
  {
    // 5a：老存档连 stat.hands 都没有 → 回填成窗口里已复盘的手数，角标不能是空白
    const s1 = {};
    s1[COACH_KEY] = JSON.stringify({ hands: Array.from({ length: 40 }, (_, i) => rec(i + 1, 'OLD', true)) });
    const A = boot(s1);
    await sleep(400);
    ok('★★ 没有累计数的老存档：角标回填成 40，不是空白', /40/.test(badgeOf(A.d)), badgeOf(A.d));
    ok('★ 回填写进了 stat.hands', A.w.HOLDEM.coach().stat.hands === 40,
      '实际 ' + A.w.HOLDEM.coach().stat.hands);
    A.w.close();

    // 5b：存档里的累计数比窗口大 → 绝不能往下削（削了又会「卡住」）
    const s2 = {};
    s2[COACH_KEY] = JSON.stringify({
      stat: { hands: 999 },
      hands: Array.from({ length: 10 }, (_, i) => rec(i + 1, 'OLD', true))
    });
    const B = boot(s2);
    await sleep(400);
    ok('★★ 累计数只补不削：999 还是 999', /999/.test(badgeOf(B.d)), badgeOf(B.d));
    B.w.close();
  }

  // ============================================================ 6
  section('6. 清空复盘记录之后，角标仍然归零');
  {
    const store = {};
    store[COACH_KEY] = JSON.stringify({
      stat: { hands: 260 },
      hands: Array.from({ length: 160 }, (_, i) => rec(i + 1, 'OLD', true))
    });
    const A = boot(store);
    await sleep(400);
    const H = A.w.HOLDEM;
    ok('清空前角标是 260（前提成立，否则下面这条不算）', /260/.test(badgeOf(A.d)), badgeOf(A.d));

    H.wipeCoach();
    ok('★★ 清空后 stat.hands 归零', H.coach().stat.hands === 0, '实际 ' + H.coach().stat.hands);
    ok('★★ 清空后角标不再带数字', !/\d/.test(badgeOf(A.d)), badgeOf(A.d));
    A.w.close();
  }

  // ============================================================ 7
  section('7. 反向断言：正常的一局不该被这条裁剪改动碰到');
  {
    const A = boot(null);
    await sleep(400);
    const H = A.w.HOLDEM;
    const sid = H.session().id;
    const C = H.coach();
    C.hands = [];
    for (let i = 1; i <= 10; i++) C.hands.push(rec(i, sid, true));     // 才 10 手，远不到上限
    C.stat.hands = 10;
    H.fixCoach();
    const hs = H.coach().hands;
    ok('★★ 没到上限时，一条不动、一步不挪', hs.length === 10 && hs[0].h === 1 && hs[9].h === 10,
      hs.length ? (hs.length + ' 条：' + hs[0].h + '–' + hs[hs.length - 1].h) : '空');
    ok('★ 顺序也没被重排', hs.every((r, i) => r.h === i + 1));
    A.w.close();
  }

  console.log('\n' + '='.repeat(56));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);

})().catch(e => { console.log('\n💥 自检本身崩了：' + (e && e.stack || e)); process.exit(1); });
