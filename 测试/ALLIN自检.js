/* =========================================================================
   第三十二轮自检 —— 🀄 ALL IN
   -------------------------------------------------------------------------
   守三件事（用户 2026-10-02 提的三条需求）：

     ① 所有 ALL IN 的时候都要讲话
        —— 提示词要"强制"，代码要"兜底"，两头都得在。
     ② 给所有人重新起名字，二次元一点
        —— 旧名在新文件里一个都不能剩（且要防"糖宫莉莉"这种子串误报）。
     ③ 弹出 ALL IN 的人的立绘，从左入场，有特效
        —— ART 里要有 stand；fxStand 要真能把 img 塞进 #fxLayer；
           换人时要能替换上一张；没立绘时要静默不弹（别挡牌桌）。

   ⚠ 这个文件的所有断言都走**真实链路**（applyAction / fxAllIn / fxStand），
     不自己手搓字符串 —— 「存在性断言」测不出「指向错了」，也测不出「换了没换」。
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

// 本轮改名的 7 位（旧 → 新）
const RENAME = {
  '李姨': '墨千夜', '麦琪': '绯罗刹', '艾米': '零·苓霜', '杰西': '魅羽·J',
  '王姨': '稔岁姨', '莉莉': '糖宫莉莉', '虎姐': '虎彻·牙'
};
const NEW_NAMES = Object.values(RENAME);

function boot(store) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e && e.message || e)));
  vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
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

(async () => {

  // ============================================================ 1
  section('1. 提示词：全下必须说话（需求①的一半）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];

    ok('页面起得来，没有脚本错误', A.errors.length === 0, A.errors.slice(0, 2).join(' | '));

    const sys = H.sysText(P);
    ok('★★ 提示词里写了「全下必须说话」', sys.indexOf('必须') >= 0 && sys.indexOf('allin') >= 0);
    ok('★★ 明确说了 say「不能是空数组」', sys.indexOf('不能是空数组') >= 0);
    ok('★★ 并且给了「一律填 1」（voice，必须让人听见）', sys.indexOf('一律填 1') >= 0);
    ok('★ 提醒了「一声不吭像机器人」这个理由（模型更认动机）', sys.indexOf('像机器人') >= 0);
    A.w.close();
  }

  // ============================================================ 2
  section('2. 代码兜底：模型不听话也得说话（需求①的另一半）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const P = H.players()[1];

    ok('导出里有 ensureAllInSay', typeof H.ensureAllInSay === 'function');
    ok('全下兜底台词表有 7 条（每位 AI 一条）',
      H.ALLIN_FALLBACK && Object.keys(H.ALLIN_FALLBACK).length === 7,
      H.ALLIN_FALLBACK ? Object.keys(H.ALLIN_FALLBACK).join(',') : '无');

    // 正例：模型留空 → 兜底必须补上
    const p1 = { key: 'liyi', name: '墨千夜', isHuman: false, actionType: 'allin', aiSays: [], aiSay: '', aiSayVoice: false };
    H.ensureAllInSay(p1);
    ok('★★ 全下 + aiSays 为空 → 兜底补了一句', p1.aiSays.length === 1, JSON.stringify(p1.aiSays));
    ok('★★ 且把「这句要念」打开了（不是只多一行字）', p1.aiSayVoice === true);
    ok('★ 台词取自该角色的专属条目（不是通用模板）', p1.aiSays[0] === H.ALLIN_FALLBACK['liyi'],
      p1.aiSays[0]);

    // 反例：模型自己说了 → 一字不能改
    const OWN = '我自己想说的那句。';
    const p2 = { key: 'liyi', name: '墨千夜', isHuman: false, actionType: 'allin', aiSays: [OWN], aiSay: OWN, aiSayVoice: false };
    H.ensureAllInSay(p2);
    ok('★★ 模型自己说了 → 兜底不插手（原句一字未改）',
      p2.aiSays.length === 1 && p2.aiSays[0] === OWN, JSON.stringify(p2.aiSays));
    ok('★ 模型自己说了 → voice 不被强行改（尊重模型的选择）', p2.aiSayVoice === false);

    // 空串也算"没说"
    const p3 = { key: 'hujie', name: '虎彻·牙', isHuman: false, actionType: 'allin', aiSays: ['   '], aiSay: '   ', aiSayVoice: false };
    H.ensureAllInSay(p3);
    ok('★★ 只给了空白字符 → 视同没说，兜底补上', p3.aiSays.length === 1 && !!p3.aiSays[0].trim(),
      JSON.stringify(p3.aiSays));

    // 每个角色都有兜底台词（不能出现"某个角色没台词"）
    let missing = [];
    for (const k of ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie']) {
      if (!H.ALLIN_FALLBACK[k]) missing.push(k);
    }
    ok('★ 7 位角色一个都不缺兜底台词', missing.length === 0, missing.join(',') || '齐全');

    A.w.close();
  }

  // ============================================================ 3
  section('3. 立绘资源：ART.stand（需求③的地基）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const ART = H.art;
    ok('ART 在', !!ART);

    const keys = ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie'];
    let bad = [];
    for (const k of keys) {
      const a = ART[k];
      if (!a || !a.stand || !/^data:image\/webp;base64,/.test(a.stand)) bad.push(k);
    }
    ok('★★ 7 位角色都有 stand 立绘（webp data URI）', bad.length === 0, bad.join(',') || '齐全');

    // 真解码一张，确认不是空壳
    const raw = ART['hujie'].stand.replace(/^data:image\/webp;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    ok('★★ stand 是真 webp（RIFF....WEBP）',
      buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP',
      buf.slice(0, 12).toString('hex'));
    ok('★ stand 体积合理（>10KB，不是占位图）', buf.length > 10 * 1024, (buf.length / 1024).toFixed(1) + ' KB');

    // 玩家自己也留了一手：没有 stand 也不能炸
    ok('★ 玩家(you) 没有 stand 也要是合法对象（fxStand 会静默跳过）',
      !!ART.you && typeof ART.you === 'object');
    A.w.close();
  }

  // ============================================================ 4
  section('4. fxStand：真的把立绘塞进了 #fxLayer（需求③的核心）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, d = A.d;
    const layer = d.getElementById('fxLayer');
    ok('fxLayer 在', !!layer);

    ok('导出里有 fxStand', typeof H.fxStand === 'function');
    ok('层里一开始没有立绘', layer.querySelectorAll('.fx-stand').length === 0);

    // 走真实入口：fxAllIn（带 p，跟产品里一样）
    const p = H.players()[1];
    H.fxAllIn(p.name, 5000, p);

    const boxes = layer.querySelectorAll('.fx-stand');
    ok('★★ fxAllIn 之后，层里出现 1 个 .fx-stand', boxes.length === 1, boxes.length + ' 个');
    const img = boxes[0].querySelector('img.fx-stand-img');
    ok('★★ 立绘里确实有 <img class="fx-stand-img">', !!img);
    ok('★★ img.src 就是该角色的 stand（指向没错，不是别人的图）',
      !!img && img.src === H.art[H.artKeyOf(p)].stand,
      img ? img.src.slice(0, 42) + '...' : '无');
    ok('★ 有名字铭牌，且写的是这个角色的名字',
      !!boxes[0].querySelector('.fx-stand-tag') &&
      boxes[0].querySelector('.fx-stand-tag').textContent === p.name,
      boxes[0].querySelector('.fx-stand-tag') ? boxes[0].querySelector('.fx-stand-tag').textContent : '无');
    ok('★ 有地面光（不然像贴纸浮空）', !!boxes[0].querySelector('.fx-stand-ground'));

    A.w.close();
  }

  // ============================================================ 5
  section('5. fxStand：换人时替换上一张 + 无立绘时静默（边界）');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, d = A.d;
    const layer = d.getElementById('fxLayer');

    // 连续两个人全下
    const ps = H.players();
    H.fxAllIn(ps[1].name, 1000, ps[1]);
    const first = layer.querySelector('.fx-stand');
    H.fxAllIn(ps[2].name, 2000, ps[2]);

    // ⚠ 退场是「淡出 420ms 再移除」，所以「立刻」查必然还有 2 个 —— 这是对的。
    //   要分开测两件事：① 旧的那张**已被标记退场**；② **等退场结束后**场上只剩 1 张。
    const now = layer.querySelectorAll('.fx-stand');
    ok('★★ 立刻查：旧的那张已被标记 .fx-stand-out（开始退场）',
      first.classList.contains('fx-stand-out'), now.length + ' 个在场');
    ok('★★ 立刻查：新那张已经入场，且是后来者的立绘（不是旧的）',
      !!(function () {
        const live = [...now].filter(b => !b.classList.contains('fx-stand-out'));
        return live.length === 1 && live[0].querySelector('img').src === H.art[H.artKeyOf(ps[2])].stand;
      })());

    // 等退场跑完（460ms 的移除定时器）
    await sleep(700);
    const after = layer.querySelectorAll('.fx-stand');
    ok('★★ 退场结束后：场上只剩 1 张立绘（没有叠影残留）', after.length === 1, after.length + ' 个');

    // 无立绘（玩家自己）→ 静默，不弹空框
    const before = layer.querySelectorAll('.fx-stand').length;
    const r = H.fxStand(null, '我', true);
    ok('★ 玩家（没有 stand）调 fxStand → 返回 null，不弹空框',
      r === null && layer.querySelectorAll('.fx-stand').length === before);

    const r2 = H.fxStand('不存在的key', '幽灵', false);
    ok('★ 未知 key → 同样静默返回 null', r2 === null);

    A.w.close();
  }

  // ============================================================ 6
  section('6. 改名：旧名一个不剩、新名全在（需求②）');
  {
    // 纯文本层先扫一遍（快），再用运行时的 PROFILES 复核
    //
    // ⚠⚠ 数旧名必须**先剥注释** —— 见坑 35。
    //   改名那轮我在 ROSTER_V 上方写了注释「第三十二轮把 7 位角色改名（李姨→墨千夜 …）」，
    //   这条断言当场变红（李姨×1）。**但注释里出现旧名是无害的**：它不渲染、不进存档，
    //   反而是给下一个人（和新会话）的关键线索 —— 断言不该逼着后人删掉它。
    //   要证的是「旧名不再出现在**玩家看得见的地方**」，不是「全文一次都不许提」。
    //
    // ⚠⚠⚠ 剥注释**必须只在 <script> 里做** —— 这是第二遍才想明白的（同见坑 35）。
    //   第一版对**整份 HTML** 逐字符扫引号，结果：
    //     1425 行是牌桌水印 `<div ...>TEXAS HOLD'EM</div>` —— **HTML 里的那撇 `'`**
    //     让扫描器以为进了一个字符串，之后每遇到一个 `'` 就翻一次奇偶，
    //     于是在 ROSTER_V 附近的注释处恰好「假在字符串里」，注释没被剥掉 ⇒ **假红**。
    //   教训：**HTML 不是 JS**。要在 HTML 里找 JS 注释，先把 <script> 段切出来再说。
    //
    // ⚠⚠⚠ 第二版「逐字符状态机」**也不行**（这次踩到了更隐蔽的）：
    //   源码里有**正则字面量**（如 `/[^\d]/`），状态机把它当除法 `/`，
    //   于是紧随其后的引号被误判成「字符串开始」⇒ 又假红。
    //   一个「什么都能解析」的手写状态机，等于一个**不可靠的解析器** ——
    //   在测试里它只会制造假红，而假红会诱导你去改**没坏的产品代码**。
    //   最终改用**朴素剥法**（块注释 regex + 逐行 `//`，且先验引号配对）：
    //   不够"聪明"，但在"**只数名字**"这件事上足够，而且**可读、可预期**。
    //   （**假红比没有测试更危险** —— 先怀疑测试，别急着改产品。）

    // 切出所有 <script> 段（内联脚本才是 JS）
    const jsOnly = (() => {
      const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
      let m, buf = [];
      while ((m = re.exec(html))) buf.push(m[1]);
      return buf.join('\n;\n');
    })();
    ok('★★ 从 HTML 里切出了 <script> 段（剥注释只认 JS，不认 HTML 水印）', jsOnly.length > 100000,
       jsOnly.length + ' 字符');

    // 朴素剥注释：先去掉 /* */，再逐行去掉安全的 //（行首、且该行引号已配平）
    const _stripComments = (s) => {
      s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');          // 块注释（含多行）
      return s.split('\n').map((line) => {
        const k = line.indexOf('//');
        if (k < 0) return line;
        const head = line.slice(0, k);
        // 该行 // 之前若有落单的引号，说明 // 可能是字符串内容（如 URL），保守不剥
        let s1 = 0, s2 = 0, s3 = 0;
        for (const c of head) { if (c === "'") s1++; else if (c === '"') s2++; else if (c === '`') s3++; }
        if (s1 % 2 === 0 && s2 % 2 === 0 && s3 % 2 === 0) return head;
        return line;
      }).join('\n');
    };
    const raw = _stripComments(jsOnly);
    // "糖宫莉莉" 里含 "莉莉"，所以查 "莉莉" 要排除该子串
    const residuals = [];
    for (const [oldN, newN] of Object.entries(RENAME)) {
      let c = 0, idx = 0;
      while ((idx = raw.indexOf(oldN, idx)) >= 0) { c++; idx += oldN.length; }
      if (oldN === '莉莉') {
        // 数 "糖宫莉莉" 出现次数，减掉
        let s = 0, j = 0;
        while ((j = raw.indexOf('糖宫莉莉', j)) >= 0) { s++; j += 4; }
        c -= s;
      }
      if (c > 0) residuals.push(oldN + '×' + c);
    }
    ok('★★ 源码里旧名全部清零（只看 <script>、已剥注释；"莉莉"已排除"糖宫莉莉"子串）',
      residuals.length === 0, residuals.join(',') || '清零');

    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM;
    const names = H.players().map(x => x.name);
    const need = ['墨千夜', '绯罗刹', '零·苓霜', '魅羽·J', '稔岁姨', '糖宫莉莉', '虎彻·牙'];
    const miss = need.filter(n => names.indexOf(n) < 0);
    ok('★★ 运行时 7 个新名全在牌桌上', miss.length === 0, miss.join(',') || '齐全');
    ok('★ 运行时没有再出现任何旧名',
      Object.keys(RENAME).every(o => names.indexOf(o) < 0), names.join(' '));

    // PERSONA 是按"名字"索引的 —— 改名最容易漏这里
    const p = H.players()[1];
    ok('★★ PERSONA 能按新名取到人格（改名后这里最容易断）',
      !!p.persona && p.persona.length > 20, p.persona ? p.persona.slice(0, 14) + '…' : '空');
    ok('★★ 人格正文里也自报新名（不是嘴上喊新名、心里还是旧名）',
      p.persona.indexOf(p.name) >= 0, '正文含「' + p.name + '」');

    // 7 位 AI 全查一遍（⚠ 玩家没有 persona，别把玩家算进去）
    let badp = [], checked = 0;
    for (const q of H.players()) {
      if (q.isHuman) continue;
      checked++;
      if (!q.persona || q.persona.indexOf(q.name) < 0) badp.push(q.name);
    }
    ok('★★ 7 位 AI 的人格正文都自报新名（玩家不计）',
      badp.length === 0 && checked === 7, badp.join(',') || ('查了 ' + checked + ' 位'));

    // ── 6b：改名对**老存档**必须生效，且**不许把同一个人劈成两半** ──────────
    // 名字是存在玩家本机 localStorage 的存档里的（AGENTS_KEY → seats[].name），
    // 只改源码不生效 —— 老存档会把旧名带回来。修法是 ROSTER_V +1 触发换代重认。
    // ⚠⚠ 第三十三轮补：换代必须**按 key 认人**。第一版写的是「老座位整批进替补席」，
    //   于是改名被当成了换人 —— 座位上新名字+空记忆、记忆全挂在替补席的旧名上。
    //   用户当场看出来：「为什么被换下去了 **就是同一个人**」。
    // 守住三点：① 世代号足够新 ② 界面确实换上新名 ③ **旧记忆留在座位上、替补席是空的**。
    // ⚠ 少了这条，下次改名若忘了 +1，就又会出现「用户说名字没改」而测试全绿。
    const rv = Number((html.match(/const ROSTER_V\s*=\s*(\d+)/) || [])[1]);
    ok('★★ ROSTER_V >= 4（改名那轮 +1；3→4 是为了把被劈开的存档按 key 合并回来）', rv >= 4, rv);

    {
      const OLD = ['李姨', '麦琪', '艾米', '杰西', '王姨', '莉莉', '虎姐'];
      const KEYIDX = ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie'];
      const oldSeats = OLD.map((nm, i) => ({
        key: KEYIDX[i], name: nm, emoji: '🙂', style: '稳健', look: '休闲',
        aggr: 5, tight: 5, bluff: 5, opt: 5, persona: '',
        mem: { notes: ['旧记忆' + (i + 1)], reflects: 30 + i },
        stats: { hands: 7, wins: 3, chips: 1000 }, reads: {}
      }));
      const saveJson = JSON.stringify({ v: rv - 1, seats: oldSeats, bench: [], savedAt: Date.now() });

      const D = new JSDOM(html, {
        runScripts: 'dangerously',
        url: 'https://x.local/',
        beforeParse(win) { win.localStorage.setItem('holdem_agents_v1', saveJson); }
      });
      const HH = D.window.HOLDEM;
      HH.renderRoster();
      // 从**界面**读，不读内存 —— 用户看到的是界面
      const uiSeat = Array.from(D.window.document.querySelectorAll('#rosterList .rr-name')).map(e => e.textContent.trim());
      const uiBench = Array.from(D.window.document.querySelectorAll('#benchList .rr-name')).map(e => e.textContent.trim());
      const RR = HH.roster();
      const newAll = NEW_NAMES.every(n => uiSeat.indexOf(n) >= 0);
      ok('★★★ 老世代存档 → **界面**上 7 个座位全换成新名（用户报的「名字没改」不复现）',
        newAll && uiSeat.length === 7, uiSeat.join(' '));
      ok('★★★ 旧名不再出现在座位上', !OLD.some(n => uiSeat.some(x => x.startsWith(n))), uiSeat.join(' '));
      ok('★★ 世代号已写成当前 ROSTER_V', Number(RR.v) === rv, RR.v);
      ok('★★★ 替补席是**空的** —— 改名不是换人（旧逻辑会塞 7 个旧名进来）',
        (RR.bench || []).length === 0 && uiBench.length === 0,
        { bench: (RR.bench || []).length, ui: uiBench.join(' ') });
      ok('★★★ 1 号座（key 仍是 liyi）的旧记忆**留在座位上**（不是被搬去替补席）',
        !!RR.seats[0] && RR.seats[0].key === 'liyi' && RR.seats[0].mem.notes[0] === '旧记忆1',
        RR.seats[0] && RR.seats[0].mem && RR.seats[0].mem.notes);
      ok('★★ 复盘次数也跟着留在座位上（30 次，不是被清零）',
        Number(RR.seats[0].mem.reflects) === 30, RR.seats[0].mem.reflects);
      D.window.close();
    }

    A.w.close();
  }

  // ============================================================ 7
  section('7. 特效 CSS：入场/退场/光晕/地面光/铭牌 都在');
  {
    const cssAnchors = [
      ['.fx-stand{', '容器'],
      ['@keyframes fxStandIn', '入场动画'],
      ['@keyframes fxStandOut', '退场动画'],
      ['@keyframes fxStandBreath', '呼吸'],
      ['@keyframes fxStandGlow', '光晕'],
      ['@keyframes fxStandSweep', '斜光扫过'],
      ['@keyframes fxStandGround', '地面光'],
      ['@keyframes fxStandTag', '铭牌'],
    ];
    let miss = cssAnchors.filter(([a]) => html.indexOf(a) < 0).map(([, n]) => n);
    ok('★★ 8 段特效 CSS 一个不少', miss.length === 0, miss.join(',') || '齐全');
    ok('★ 入场是"从左"（translateX 负值起步）', /fxStandIn[\s\S]{0,220}translate\(-5[0-9]%/.test(html));
    ok('★ 过冲回弹（cubic-bezier 有 >1 的控制点）',
      /fx-stand\{[\s\S]{0,320}cubic-bezier\(\.16,\s*\.9,\s*\.28,\s*1\.06\)/.test(html));
    ok('★ 外部容器负责滑入、内层 img 负责缩放（避免 transform 互盖）',
      /\.fx-stand\{[\s\S]{0,600}?\}\s*[\s\S]{0,600}?\.fx-stand-img\{/.test(html));
    // ⚠ 锚在底边（bottom:0）而不是中线 —— 立绘 480px 高、牌桌才 760px，
    //   若用 top:50% 居中会往下溢出、脚被切掉（第一版就写错了）
    ok('★★ 立绘锚在底边（bottom:0），不是垂直居中',
      /\.fx-stand\{[\s\S]{0,260}?bottom:0/.test(html) &&
      !/\.fx-stand\{[\s\S]{0,160}?top:50%/.test(html));
    ok('★ 入场动画里不再有竖向 -50% 位移（那是居中时代的残留）',
      !/fxStandIn\{[\s\S]{0,200}?-50%/.test(html));
  }

  // ============================================================ 8
  section('8. ★★★ 端到端：走真实 applyAction，全下会说话 + 立绘会入场');
  {
    const A = boot(null);
    await sleep(340);
    const H = A.w.HOLDEM, d = A.d;
    const p = H.players()[2];

    // 场景：模型决定全下，但**没给 say**（这就是本轮要救的那种情况）
    p.aiSays = []; p.aiSay = ''; p.aiSayVoice = false;
    p.chips = 3000; p.bet = 0; p.totalBet = 0;
    // ⚠ applyAction(p, type, amount) —— 第二参是**动作字符串**，不是对象。
    //   raise 到超过自己筹码，内部才会判成 allin（normalizeDecision 会把 allin 揉成 raise）。
    H.applyAction(p, 'raise', 99999);

    ok('★★ 真实链路确实走到了「真全下」', p.actionType === 'allin', p.actionType);
    ok('★★ 模型没给 say，兜底补上了这句话', p.aiSays.length === 1 && !!p.aiSays[0], JSON.stringify(p.aiSays));
    ok('★★ 而且是念出来的（voice=true，不是只多一行字）', p.aiSayVoice === true);

    const stands = d.getElementById('fxLayer').querySelectorAll('.fx-stand');
    ok('★★ 同时立绘也确实入场了', stands.length === 1, stands.length + ' 张');
    ok('★★ 入场的正是这位全下者（名字与立绘都对得上）',
      stands.length === 1 &&
      stands[0].querySelector('.fx-stand-tag').textContent === p.name &&
      stands[0].querySelector('img').src === H.art[H.artKeyOf(p)].stand,
      stands.length ? stands[0].querySelector('.fx-stand-tag').textContent : '无');

    A.w.close();
  }

  console.log('\n' + '='.repeat(60));
  console.log('  第三十二轮自检：' + pass + ' 项通过 / ' + fail + ' 项失败');
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('自检崩溃：', e); process.exit(2); });
