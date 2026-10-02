// 第十八轮自检 —— 音效 / 特效加码 / 赢家动画 / 教练评分曲线 / 功能区重组
//
// 规矩（前几轮踩出来的）：
//   · 固定随机源，结果可复现；
//   · 「持久化」的断言必须跨一次页面加载才算验过；
//   · 断言 CSS 尺寸要取「最后一条生效的规则」，不能取第一条；
//   · 涉及「谁该有、谁不该有」的，正反两向都要断言。
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

// ---------- 给无头环境补两个「浏览器才有」的东西 ----------
function makeAudioCtxMock() {
  const made = { osc: 0, buf: 0, src: 0, gain: 0, flt: 0, started: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; }
  });
  const node = extra => Object.assign({ connect() { return this; }, disconnect() { } }, extra || {});
  const C = function () {
    return {
      state: 'running',
      currentTime: 0,
      sampleRate: 48000,
      destination: node(),
      resume() { this.state = 'running'; },
      createGain() { made.gain++; return node({ gain: param() }); },
      createOscillator() {
        made.osc++;
        return node({ type: 'sine', frequency: param(), start() { made.started++; }, stop() { } });
      },
      createBiquadFilter() {
        made.flt++;
        return node({ type: 'bandpass', frequency: param(), Q: { value: 1 }, detune: { value: 0 } });
      },
      createBuffer(ch, len, rate) {
        made.buf++;
        const data = new Float32Array(len);
        return { length: len, sampleRate: rate, numberOfChannels: ch, getChannelData: () => data };
      },
      createBufferSource() { made.src++; return node({ buffer: null, start() { made.started++; }, stop() { } }); }
    };
  };
  C._made = made;
  return C;
}
function makeCtx2dMock() {
  const calls = [];
  const noop = name => function () { calls.push(name); };
  return {
    calls,
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', lineJoin: 'miter',
    globalAlpha: 1, lineCap: 'butt',
    clearRect: noop('clearRect'), fillRect: noop('fillRect'),
    beginPath: noop('beginPath'), moveTo: noop('moveTo'), lineTo: noop('lineTo'),
    stroke: noop('stroke'), fill: noop('fill'), closePath: noop('closePath'),
    fillText: noop('fillText'), strokeText: noop('strokeText'),
    arc: noop('arc'), rect: noop('rect'),
    save: noop('save'), restore: noop('restore'),
    setLineDash: noop('setLineDash'), translate: noop('translate'), scale: noop('scale'),
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() { } }),
    createRadialGradient: () => ({ addColorStop() { } })
  };
}

function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.message || String(e))));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => { });
  let seed = 20261001 >>> 0;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/holdem',
    virtualConsole: vc,
    beforeParse(window) {
      window.Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      window.fetch = async () => { throw new Error('no net'); };
      window.AudioContext = makeAudioCtxMock();
      // ⚠ 同一张画布必须拿到同一个 ctx —— 每次 new 一个的话，
      //   测试手里那个对象跟页面真正画的那个不是同一个，调用记录永远是 0。
      window.HTMLCanvasElement.prototype.getContext = function () {
        if (!this.__mockCtx) this.__mockCtx = makeCtx2dMock();
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

(async () => {
  const { w, d, errors, dom } = boot(null);
  await new Promise(r => setTimeout(r, 300));
  const H = w.HOLDEM;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================ 1. 音效系统
  section('1. 🔊 音效系统');
  ok('HOLDEM 导出了音效接口', !!(H.sfx && H.allSfx && H.setSfxVol));
  const names = H.allSfx();
  ok('音色表非空且够用', names.length >= 18, names.length + ' 种：' + names.join(','));
  ok('必备音色一个不少', ['deal', 'flop', 'chip', 'check', 'call', 'raise', 'fold', 'allin',
    'win', 'bigwin', 'lose', 'blindup', 'bigpot', 'bust', 'turn', 'coach', 'click', 'hot']
    .every(n => names.indexOf(n) >= 0));
  ok('★ 音效默认是开的', H.sfxOn() === true, 'on=' + H.sfxOn() + ' vol=' + H.sfxVol());
  // 逐个真跑一遍：每一种音都要能真的建出振荡器/噪声源，且不抛错
  const made = w.AudioContext._made;
  const before = { osc: made.osc, src: made.src, buf: made.buf };
  let allOk = true, badName = '';
  for (const n of names) {
    const r = H.sfx(n);
    if (r !== true) { allOk = false; badName = n; }
  }
  ok('★ 每一种音色都能真的发声（不是空壳）', allOk, badName ? ('卡在 ' + badName) : '');
  ok('★ 确实建出了音频节点', made.osc > before.osc && made.buf > before.buf,
    '振荡器 +' + (made.osc - before.osc) + ' · 噪声源 +' + (made.src - before.src));
  ok('没人听的时候（关闭）不出声', (() => { H.setSfx(false); const r = H.sfx('chip'); H.setSfx(true); return r === false; })());
  ok('不存在的音色名安静返回 false', H.sfx('这个音不存在') === false);

  // ⚠ 最关键的一条：音效与特效绝不能抢 Math.random（抢了会让牌序漂、既有断言随机挂）
  section('2. ⚠ 音效/特效不抢共享随机源（前几轮踩过的大坑）');
  const realRandom = w.Math.random;
  let usedShared = false;
  w.Math.random = function () { usedShared = true; return 0.5; };
  try {
    for (const n of names) H.sfx(n);
    H.fxWinPot(1, 500);
    H.fxAllIn('测试', 300);
    H.fxBigPot(1200);
    H.fxBlindUp(2, 20, 40);
    H.fxBust(2);
  } catch (e) { usedShared = true; }
  w.Math.random = realRandom;
  ok('★★ 音效 + 一整套特效跑下来，一次都没碰 Math.random', usedShared === false);

  // ============================================================ 3. 特效加码
  section('3. ✨ 特效加码（用户原话：特效层太小了）');
  const styleText = [...d.querySelectorAll('style')].map(s => s.textContent).join('\n');
  // ⚠ 必须先把 @media 块整段剔掉再找「最后一条规则」。
  //   否则窄屏回落规则（.fx-txt 在 ≤900px 时是 36px）会被当成最后一条，
  //   「字号已经放大到 56px」这条断言会永远判定失败 —— 这是第二次踩这个坑。
  const stripMedia = css => {
    let out = '', i = 0;
    while (i < css.length) {
      const at = css.indexOf('@media', i);
      if (at < 0) { out += css.slice(i); break; }
      out += css.slice(i, at);
      let j = css.indexOf('{', at);
      if (j < 0) break;
      let depth = 0;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      i = j;
    }
    return out;
  };
  const styleFlat = stripMedia(styleText);          // 只有「任何宽度都生效」的规则
  // 取「最后一条生效的规则」——同名字的规则有好几条，取第一条会被旧值骗过
  const lastFontOf = sel => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    let m, last = null;
    while ((m = re.exec(styleFlat))) last = m[1];
    if (!last) return null;
    const f = /font-size\s*:\s*([\d.]+)px/.exec(last);
    return f ? Number(f[1]) : null;
  };
  ok('★ .fx-txt 最后一条规则的字号已经放大到 56px（原来是 32）', lastFontOf('.fx-txt') === 56, lastFontOf('.fx-txt') + 'px');
  ok('★ .fx-allin 放大到 64px', lastFontOf('.fx-allin') === 64, lastFontOf('.fx-allin') + 'px');
  ok('★ .fx-pot 放大到 48px', lastFontOf('.fx-pot') === 48, lastFontOf('.fx-pot') + 'px');
  ok('★ .fx-blind 放大到 42px', lastFontOf('.fx-blind') === 42, lastFontOf('.fx-blind') + 'px');
  ok('窄屏有回落（否则大字撑出屏幕）', /@media\s*\(max-width:\s*900px\)[\s\S]*?\.fx-txt\{[^}]*font-size:36px/.test(styleText));
  ok('新增了全屏金光 .fx-flash', /\.fx-flash\s*\{/.test(styleText));
  ok('新增了桌面轻震 .stage-shake', /\.stage-shake\s*\{/.test(styleText));
  ok('新增了金币飞溅 .fx-coin', /\.fx-coin\s*\{/.test(styleText));
  ok('★ 桌面轻震加在 .stage 上，没有碰 #table（#table 有内联 scale，动画会盖掉它）',
    /\.stage-shake\s*\{/.test(styleText) && !/#table\.stage-shake/.test(styleText));
  ok('冲击波起步从 130px 放大到 200px',
    (() => { const re = /\.fx-ring\{([^}]*)\}/g; let m, last = null; while ((m = re.exec(styleFlat))) last = m[1];
      return last && /width:\s*200px/.test(last); })());

  // 特效元素真的挂得上去、并且不吃点击
  const layer = d.getElementById('fxLayer');
  const n0 = layer.children.length;
  H.fxAllIn('测试员', 500);
  ok('★ 全下特效真的挂进 fxLayer 了', layer.children.length > n0, '+' + (layer.children.length - n0) + ' 个');
  const ring = layer.querySelector('.fx-ring');
  ok('冲击波元素 class 正确', !!ring);
  const cs = ring ? w.getComputedStyle(ring).pointerEvents : '';
  ok('★★ 特效元素 pointer-events 是 none（绝不吃点击）', cs === 'none', 'pointer-events=' + cs);
  ok('fxLayer 自己也是 none', w.getComputedStyle(layer).pointerEvents === 'none');

  // 减少动态效果
  ok('★ prefers-reduced-motion 里覆盖了新增特效', /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.fx-flash/.test(styleText)
    && /prefers-reduced-motion[\s\S]*?\.seat\.hot/, '');

  // ============================================================ 4. 赢家 / 手气旺
  section('4. 🔥👑 赢家动画（用户原话：谁赢的很多那个人加动画特效）');
  const seats = [...d.querySelectorAll('.seat')];
  ok('8 个座位都带了连胜角标位', seats.length === 8 && seats.every(s => !!s.querySelector('.streak')),
    seats.filter(s => s.querySelector('.streak')).length + '/8');
  ok('hotnessOf 是个可调的函数', typeof H.hotnessOf === 'function');

  const P = H.players();
  const setStreak = (i, st, tot) => { P[i].winStreak = st; P[i].winTotal = tot || 0; };
  // 正：连赢 3 手 → hot + king
  setStreak(1, 3, 0); H.render();
  ok('★ 连赢 3 手 → 座位拿到 hot', seats[1].classList.contains('hot'));
  ok('★ 连赢 3 手 → 座位拿到 king，角标变皇冠',
    seats[1].classList.contains('king') && seats[1].querySelector('.streak').textContent.indexOf('👑') === 0,
    seats[1].querySelector('.streak').textContent);
  // 正：连赢 2 手 → hot 但还不是 king
  setStreak(1, 0, 0); setStreak(2, 2, 0); H.render();
  ok('★ 连赢 2 手 → hot 但不是 king（分级正确）',
    seats[2].classList.contains('hot') && !seats[2].classList.contains('king'));
  ok('★ 角标是 🔥 记法', seats[2].querySelector('.streak').textContent === '🔥×2',
    seats[2].querySelector('.streak').textContent);
  // 反：没有连胜的人绝不能带 hot（防止「所有人都发光」这种廉价做法）
  ok('★★ 没连胜、没赢钱的人身上没有 hot（正反两向都验）',
    ![0, 3, 4, 5, 6, 7].some(i => seats[i].classList.contains('hot')) &&
    !seats[1].classList.contains('hot'));
  // 累计赢很多也能触发
  setStreak(2, 0, 0); setStreak(3, 1, 1800); H.render();
  ok('★ 连赢只有 1 手、但本局累计赢到 1.8 倍起始筹码 → 也判定为 hot',
    seats[3].classList.contains('hot'));
  setStreak(3, 0, 0);
  // 出局的人不该发光
  setStreak(4, 9, 9999); P[4].out = true; H.render();
  ok('出局的人不再发光（人都没了还发光很怪）', !seats[4].classList.contains('hot'));
  P[4].out = false; setStreak(4, 0, 0);
  // 新一局必须清零
  H.resetGame();
  await sleep(120);
  ok('★ 重新开局后手气光环清空（不然上一局的火会烧到新一局）',
    H.players().every(p => !p.winStreak && !p.winTotal) &&
    ![...d.querySelectorAll('.seat')].some(s => s.classList.contains('hot')));
  H.render();

  // ============================================================ 5. 功能区重组
  section('5. 🧩 功能区与游戏区拆分（用户原话：不要所有按钮都堆在一起）');
  // ---- 5.1 「文字被竖着摞成一列」的真凶：header 写死高度 + 没有 flex-wrap + 控件可被压缩 ----
  const headerRule = (() => {
    const re = /(?:^|[}\n])\s*header\s*\{([^}]*)\}/g; let m, last = null;
    while ((m = re.exec(styleFlat))) last = m[1];
    return last || '';
  })();
  ok('★★ header 不再写死高度（height:auto）', /height:\s*auto/.test(headerRule), headerRule.slice(0, 100));
  ok('★★ header 允许换行（flex-wrap:wrap）—— 这是文字被压成一列的直接原因', /flex-wrap:\s*wrap/.test(headerRule));
  ok('★★ 工具栏子树里的控件一律不许压缩（flex-shrink:0）',
    /\.htools \*,\s*\.toolbar \*\s*\{[^}]*flex-shrink:\s*0/.test(styleFlat));
  ok('★★ 按钮和勾选项都不许折行（white-space:nowrap）',
    /\.btn-mini,\s*\.htools label,\s*\.toolbar label\s*\{[^}]*white-space:\s*nowrap/.test(styleFlat));

  // ---- 5.2 功能区真的独立出来了一条 ----
  const bar = d.getElementById('toolBar');
  ok('★ 新增了独立的功能区工具条 #toolBar', !!bar && bar.classList.contains('toolbar'));
  ok('★ 功能区在 header 之外（真的跟游戏区拆开了）', bar && !bar.closest('header'));
  ok('★ 功能区排在 header 和牌桌之间', bar && bar.previousElementSibling &&
    bar.previousElementSibling.tagName.toLowerCase() === 'header' &&
    bar.nextElementSibling && bar.nextElementSibling.classList.contains('main'));

  const grpIn = sel => [...d.querySelectorAll(sel)];
  const gPlay = grpIn('.htools .hgrp');
  const gTools = grpIn('.toolbar .hgrp');
  ok('★ 游戏动作留在顶栏（只剩 1 组）', gPlay.length === 1 && gPlay[0].classList.contains('hg-play'),
    gPlay.map(g => g.className).join(' '));
  ok('★ 大脑 / 工具 / 显示 三组搬进了功能区', gTools.length === 3 &&
    ['hg-state', 'hg-tools', 'hg-toggles'].every(c => gTools.some(g => g.classList.contains(c))),
    gTools.map(g => g.className.replace('hgrp', '').trim()).join(' / '));
  ok('★ 每组都有小标题（不再是一堆按钮糊在一起）',
    gTools.every(g => !!g.querySelector('.tbar-lbl')) && gTools.length === 3,
    gTools.map(g => (g.querySelector('.tbar-lbl') || {}).textContent || '').join(' / '));

  // ---- 5.3 老控件一个都不能丢 ----
  const mustHave = ['tgBrain', 'aiStatus', 'btnRange', 'btnSeed', 'btnAISet', 'btnAILog', 'btnSfx',
    'tgHud', 'tgEq', 'tgReveal', 'tgBlindUp', 'btnNext', 'btnReset', 'btnCoach', 'btnEndSession'];
  const missing = mustHave.filter(id => !d.getElementById(id));
  ok('★★ 老控件一个都没丢', missing.length === 0, missing.length ? ('缺：' + missing.join(',')) : mustHave.length + ' 个都在');
  const outsideBars = mustHave.filter(id => {
    const el = d.getElementById(id);
    return el && !el.closest('.htools') && !el.closest('.toolbar');
  });
  ok('★ 全部都在顶栏或功能区里（bindUI 的 getElementById 全靠这个）', outsideBars.length === 0, outsideBars.join(','));
  ok('主行动按钮被标成主色（.btn-mini 那套浅色不够显眼）',
    /#btnNext\s*\{[\s\S]*?background:linear-gradient/.test(styleText));
  ok('组与组之间有分隔线（视觉上分得开）', /\.hgrp\{[^}]*border-left:1px solid/.test(styleText));
  ok('★ 整条工具栏可以换行，但组内不折（不会把「开始第 1 手」甩到第二行去）',
    /\.hgrp\{[^}]*flex-wrap:nowrap/.test(styleText) && /\.htools,\s*\.toolbar\{[^}]*flex-wrap:wrap/.test(styleText));
  ok('窄屏允许组内折行（否则单组比屏幕还宽会溢出）',
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.hgrp\{[^}]*flex-wrap:wrap/.test(styleText));

  // ---- 5.4 底部操作区：同一个「被压扁」的病，一并加固 ----
  ok('★★ 底部 #controls 允许换行（原来 max-width:1160 + 不换行 → 四个动作按钮被压窄、文字溢出）',
    /#controls\{[^}]*flex-wrap:\s*wrap/.test(styleFlat));
  ok('★★ 四个动作按钮绝不被压缩', /\.acts \.btn\{[^}]*flex-shrink:\s*0|\.acts \.btn\{[^}]*flex:0 0 auto/.test(styleFlat));
  ok('★ 加注框也不会被压没', /\.raisebox\{[^}]*flex:1 1 330px/.test(styleFlat));

  // ============================================================ 6. 音效开关与音量
  section('6. 🔊 音效开关 / 音量 / 落盘');
  ok('工具栏有快捷静音按钮', !!d.getElementById('btnSfx'));
  ok('设置面板里有音效开关', !!d.getElementById('tgSfx'));
  ok('设置面板里有音量条', !!d.getElementById('sfxVol'));
  ok('设置面板里有试听按钮', !!d.getElementById('sfxTest'));
  const tg = d.getElementById('tgSfx'), vol = d.getElementById('sfxVol');
  ok('开关的初始状态跟 SFX 一致', tg.checked === H.sfxOn(), 'checked=' + tg.checked);
  H.setSfxVol(0.8);
  ok('★ 调音量真的生效', Math.abs(H.sfxVol() - 0.8) < 1e-9, H.sfxVol());
  ok('音量条读数同步了', vol.value === '80', vol.value);
  ok('百分比文字同步了', d.getElementById('sfxVolTxt').textContent === '80%', d.getElementById('sfxVolTxt').textContent);
  H.setSfxVol(5);
  ok('音量上限被夹住（不会 500%）', H.sfxVol() === 1, H.sfxVol());
  H.setSfxVol(-3);
  ok('音量下限被夹住', H.sfxVol() === 0, H.sfxVol());
  H.setSfxVol(0.45);
  d.getElementById('btnSfx').click();
  ok('★ 点工具栏按钮能静音', H.sfxOn() === false);
  ok('静音后按钮变成 🔇 且带 .off', d.getElementById('btnSfx').textContent.indexOf('🔇') === 0
    && d.getElementById('btnSfx').classList.contains('off'));
  ok('静音后设置里的开关也跟着变', d.getElementById('tgSfx').checked === false);
  ok('★ 静音时整条音量行变灰（看得出这条现在没意义）',
    d.getElementById('sfxVolRow').classList.contains('dim'));
  d.getElementById('btnSfx').click();
  ok('再点一下恢复', H.sfxOn() === true);
  ok('恢复后音量行不再变灰', !d.getElementById('sfxVolRow').classList.contains('dim'));
  // 落盘键必须进备份表（不然「一键备份」会漏掉它）
  ok('★ 音效设置进了备份键表', html.indexOf("'holdem_sfx_v1'") >= 0 && /BACKUP_KEYS[\s\S]*?holdem_sfx_v1/.test(html));

  // ============================================================ 7. 跨一次页面加载验落盘
  section('7. 💾 跨一次加载验音效设置落盘（只验内存不算验过）');
  H.setSfx(false);
  H.setSfxVol(0.31);
  await sleep(50);
  const dump = {};
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    dump[k] = w.localStorage.getItem(k);
  }
  ok('磁盘上真的有 holdem_sfx_v1', !!dump['holdem_sfx_v1'], (dump['holdem_sfx_v1'] || '').slice(0, 60));
  const second = boot(dump);
  await new Promise(r => setTimeout(r, 250));
  const H2 = second.w.HOLDEM;
  ok('★★ 重新打开页面后，音效「关」被记住了', H2.sfxOn() === false);
  ok('★★ 重新打开页面后，音量 0.31 被记住了', Math.abs(H2.sfxVol() - 0.31) < 1e-9, H2.sfxVol());
  ok('★★ 重新打开页面后，界面上的开关也是关着的', second.d.getElementById('tgSfx').checked === false);
  ok('重新打开后没有脚本错误', second.errors.length === 0, second.errors.slice(0, 2).join(' | '));
  dom.window.close(); second.dom.window.close();

  // ============================================================ 8. 教练评分曲线
  section('8. 📈 教练评分曲线（评分 vs 手数）');
  const boot3 = boot(null);
  await new Promise(r => setTimeout(r, 250));
  const w3 = boot3.w, d3 = boot3.d, H3 = w3.HOLDEM;
  ok('走势页有第三张画布', !!d3.getElementById('curveScoreCv'));
  ok('有对应的图例位', !!d3.getElementById('curveScoreLegend'));
  ok('有评分 KPI 区', !!d3.getElementById('scoreKpi'));
  ok('导出了 scoreStats', typeof H3.scoreStats === 'function');
  ok('导出了 drawScoreCurve', typeof H3.drawScoreCurve === 'function');

  // 拿不到数据时不能崩，也不能装作有数据
  const empty = H3.scoreStats();
  ok('★ 一手都没评时，如实报 0 手（不硬编造）', empty.n === 0, JSON.stringify({ n: empty.n, trend: empty.trend }));
  ok('★ 整块渲染在没数据时也不崩', H3.renderScoreCurve() === true);
  ok('★ 没数据时 KPI 给出说明，不是空白', d3.getElementById('scoreKpi').textContent.length > 10,
    d3.getElementById('scoreKpi').textContent.slice(0, 40));

  // 灌入真的评分记录（走 COACH.hands，跟教练本身同一个数据源）
  const CO = H3.coach();
  const sid = H3.coachSession() ? H3.coachSession().id : '';
  ok('能拿到当前这一局的 id（不然下面的记录都进不了筛选）', !!sid, sid);
  const pushScore = (h, score, s, over) => CO.hands.push(Object.assign(
    { sid: s, h: h, t: Date.now(), score: score, reviewed: true, err: '' }, over || {}));
  const clearScores = () => { CO.hands.length = 0; };

  const scores = [55, 58, 61, 70, 72, 75, 88, 90];
  scores.forEach((s, i) => pushScore(i + 1, s, sid));
  const st = H3.scoreStats();
  ok('★ 8 条记录都进来了', st.n === 8, st.n + ' 手');
  ok('★ 平均分算对了', Math.abs(st.avg - (55 + 58 + 61 + 70 + 72 + 75 + 88 + 90) / 8) < 1e-9, st.avg.toFixed(2));
  ok('★ 最近 5 手均分算对了', Math.abs(st.avg5 - (70 + 72 + 75 + 88 + 90) / 5) < 1e-9, st.avg5.toFixed(2));
  ok('★ 走势判定为「在进步」（后 5 手明显高过前 5 手）', st.trend === 'up', st.trend + ' 差 ' + st.delta.toFixed(2));
  ok('最高 / 最低取对了', st.best === 90 && st.worst === 55, st.best + ' / ' + st.worst);
  const cv = d3.getElementById('curveScoreCv');
  const c2d = cv.getContext('2d');
  c2d.calls.length = 0;                         // 清一次，只统计这一轮
  ok('★ 有数据时整块渲染成功', H3.renderScoreCurve() === true);
  ok('★ 真的调用了绘制原语（不是空函数）', c2d.calls.length > 30, c2d.calls.length + ' 次绘制调用');
  ok('★ 画了折线（beginPath + lineTo 都有）',
    c2d.calls.indexOf('beginPath') >= 0 && c2d.calls.filter(x => x === 'lineTo').length > 3,
    'lineTo × ' + c2d.calls.filter(x => x === 'lineTo').length);
  ok('★ 参考线用了虚线（setLineDash）', c2d.calls.indexOf('setLineDash') >= 0);
  ok('图例里写清了三条线各是什么',
    d3.getElementById('curveScoreLegend').textContent.indexOf('滚动 5 手均分') >= 0 &&
    d3.getElementById('curveScoreLegend').textContent.indexOf('每一手的评分') >= 0);
  const kpiTxt = d3.getElementById('scoreKpi').textContent;
  ok('★ KPI 显示了平均分与最近 5 手', kpiTxt.indexOf('平均分') >= 0 && kpiTxt.indexOf('最近 5 手均分') >= 0 && kpiTxt.indexOf('在进步') >= 0);

  // 反方向：退步也要判出来
  clearScores();
  [90, 88, 85, 80, 62, 58, 55, 50].forEach((s, i) => pushScore(i + 1, s, sid));
  ok('★★ 走势反过来也要判对（在退步）', H3.scoreStats().trend === 'down', H3.scoreStats().trend);
  // 持平
  clearScores();
  [70, 70, 70, 70, 70, 70, 70, 70].forEach((s, i) => pushScore(i + 1, s, sid));
  ok('★★ 分数没变化时判「持平」，不硬说有走势', H3.scoreStats().trend === 'flat', H3.scoreStats().trend);
  // 样本不足不硬给结论
  clearScores();
  [50, 50, 50].forEach((s, i) => pushScore(i + 1, s, sid));
  ok('★ 不到 6 手不硬给走势结论', H3.scoreStats().trend === 'flat' && H3.scoreStats().n === 3);
  // 出错的记录、别的局的记录都不能算进来
  clearScores();
  pushScore(1, 90, sid);
  pushScore(2, 90, '别人的局');
  pushScore(3, 10, sid, { err: '请求失败' });
  pushScore(4, 10, sid, { reviewed: false });
  ok('★★ 只算「这一局 + 已点评 + 没出错」的（别的局、失败的手都不能混进来）',
    H3.scoreStats().n === 1 && H3.scoreStats().avg === 90, JSON.stringify(H3.scoreStats().list.map(r => r.score)));
  ok('全部评分曲线操作下来零脚本错误', boot3.errors.length === 0, boot3.errors.slice(0, 2).join(' | '));
  boot3.dom.window.close();

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('（第一份 DOM 的运行期错误：' + errors.length + '）');
  if (errors.length) errors.slice(0, 5).forEach(e => console.log('  ' + e.slice(0, 200)));
  process.exit(fail ? 1 : 0);
})();
