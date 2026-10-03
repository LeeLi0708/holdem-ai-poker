/* _check改名迁移.js —— 验证「改名 ≠ 换人」（第三十二轮建、第三十三轮补改口径）
 *
 * 背景：角色名（连同立绘、性格）是**存在玩家本机存档**里的（holdem_agents_v1 → seats[]）。
 *   只改源码 PROFILES 没用 —— 老存档会把旧名带回来（用户实测：名字没改）。
 *
 * ⚠⚠ 第三十三轮补：第一版修法是「ROSTER_V +1，老座位整批请进替补席」——
 *   名字是换了，但**同一个人的档案被劈成两半**：座位上是新名字+空记忆，
 *   记忆全挂在替补席的旧名字上。用户当场看出来：
 *   「为什么被换下去了 **就是同一个人**」。
 *   ⇒ 正确做法 = **按 key 认人**：key 没变就是同一个人，就地改名、记忆留在座位上；
 *     只有 key 在新阵容里已经没了的，才算真被换下去。
 *   ⇒ 还多了一步「修已坏的存档」：同一个 key 出现两份（座位一份+替补席一份）
 *     必须**合并回一份**（并集，上限跟主线一致）。
 *
 * 断言：
 *   ① 源码 ROSTER_V >= 4
 *   ② 老世代存档(v=2, 旧名+旧记忆) → 座位上换成新名，**且旧记忆留在座位上**、替补席为空
 *   ③ 反面：当代存档 不许再迁移（否则每开一局阵容都被重置）
 *   ④ 跨一次页面加载仍在（真持久化）
 *   ⑤ ★★★ 已被劈开的存档（座位新名+薄记忆 / 替补席旧名+满记忆）→ **合并回一份**
 *
 * ⚠ ③ 的反面断言是命门：只测「旧存档会迁移」的话，一个「永远迁移」的 bug 也能全绿。
 * ⚠ ⑤ 是第三十三轮用户报障的逐字复现，这条**必须在打补丁前的备份上变红**。
 */
// jsdom 没有 requestAnimationFrame，页面尾部会抛（不影响被测逻辑），静音掉
const _origErr = console.error;
console.error = function () {
  const s = Array.prototype.join.call(arguments, ' ');
  if (/requestAnimationFrame/.test(s)) return;
  _origErr.apply(console, arguments);
};

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// 允许传入别的 HTML 来跑（用来证明「这条守卫真能红」：拿打补丁前的备份撞一次）
const HTML = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, '德州扑克.html');

// jsdom 解析：用与其他自检一致的 JSDOM_DIR 常量写法
// ⚠ 必须把绝对路径原文**写成同一个字面量** —— `_导出GitHub项目.py` 的 GLOBAL 规则
//   是按这个具体字符串（JSDOM_ABS）做全局替换的，写法一变就替换不到、用户名会漏进镜像。
const JSDOM_DIR = 'jsdom';
const { JSDOM } = require(JSDOM_DIR);

const OLD_NAMES = ['李姨', '麦琪', '艾米', '杰西', '王姨', '莉莉', '虎姐'];
const NEW_NAMES = ['墨千夜', '绯罗刹', '零·苓霜', '魅羽·J', '稔岁姨', '糖宫莉莉', '虎彻·牙'];
const KEYS      = ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie'];
const AGENTS_KEY = 'holdem_agents_v1';

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const html = fs.readFileSync(HTML, 'utf8');
const ROSTER_V_SRC = Number((html.match(/const ROSTER_V\s*=\s*(\d+)/) || [])[1]);

/** 造一份老世代存档（旧名 + 旧记忆），灌进 beforeParse */
function makeOldSave(v) {
  const seats = OLD_NAMES.map((n, i) => ({
    key: KEYS[i], name: n, emoji: '🙂', style: '稳健', look: '休闲',
    aggr: 5, tight: 5, bluff: 5, opt: 5, persona: '',
    mem: { notes: ['旧记忆' + (i + 1)], reflects: 30 + i },
    stats: { hands: 7, wins: 3, chips: 1000 },
    reads: {}
  }));
  return JSON.stringify({ v: v, seats: seats, bench: [], savedAt: Date.now() - 86400000 });
}

/** ★ 造一份「被旧逻辑劈开」的存档：座位=新名+薄记忆，替补席=旧名+满记忆（用户截图的样子） */
function makeSplitSave(v) {
  const seats = NEW_NAMES.map((n, i) => ({
    key: KEYS[i], name: n, emoji: '🙂', style: '稳健', look: '休闲',
    aggr: 5, tight: 5, bluff: 5, opt: 5, persona: '',
    mem: { notes: ['新座记忆' + (i + 1)], reflects: 1 },
    stats: { hands: 5, vpip: 2, pfr: 1, shows: 1, lastShow: '', lastShowHand: 0, recent: [] },
    reads: {}
  }));
  const bench = OLD_NAMES.map((n, i) => ({
    key: KEYS[i], name: n, emoji: '🙂', style: '稳健', look: '休闲',
    aggr: 5, tight: 5, bluff: 5, opt: 5, persona: '',
    mem: { notes: ['旧记忆' + (i + 1)], reflects: 33 },
    stats: { hands: 40, vpip: 9, pfr: 3, shows: 4, lastShow: '', lastShowHand: 0, recent: [] },
    reads: {}
  }));
  return JSON.stringify({ v: v, seats: seats, bench: bench, savedAt: Date.now() });
}

/** 起一份页面，返回 {dom, H} */
function boot(saveJson) {
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://x.local/',
    beforeParse(win) {
      if (saveJson) win.localStorage.setItem(AGENTS_KEY, saveJson);
    }
  });
  const H = dom.window.HOLDEM;
  if (!H) throw new Error('HOLDEM 未导出');
  return { dom: dom, H: H };
}

/** 从界面上真正读名字（#rosterList 的 .rr-name），不走内存 */
function uiSeatNames(dom) {
  return Array.from(dom.window.document.querySelectorAll('#rosterList .rr-name'))
    .map(e => e.textContent.trim());
}
function uiBenchNames(dom) {
  return Array.from(dom.window.document.querySelectorAll('#benchList .rr-name'))
    .map(e => e.textContent.trim());
}

console.log('=== 改名迁移自检（按 key 认人版） ===');
console.log('被测文件：' + HTML);

// ── 第一节：源码世代号 ─────────────────────────────────────────
console.log('\n① 源码里的 ROSTER_V');
{
  ok(Number.isFinite(ROSTER_V_SRC), '源码里能找到 ROSTER_V', ROSTER_V_SRC);
  ok(ROSTER_V_SRC >= 4, 'ROSTER_V >= 4（3→4 是为了让被劈开的存档按 key 合并回来）', ROSTER_V_SRC);
}

// ── 第二节：老世代存档 (v=2) —— 就地改名，记忆留座 ─────────────
console.log('\n② 老世代存档 (v=2, 旧名+旧记忆) → 换成新名，**记忆留在座位上**');
{
  const A = boot(makeOldSave(2));
  const R = A.H.roster();
  ok(!!R, 'HOLDEM.roster() 可读');

  // ⚠ 界面读数：用户看到的是**界面**，不是内存对象 —— 必须从 #rosterList 真读一遍
  A.H.renderRoster();
  const uiNames = uiSeatNames(A.dom);
  console.log('   界面在座 : ' + uiNames.join(' '));
  ok(uiNames.length === 7, '界面花名册显示 7 行', uiNames.length);
  ok(NEW_NAMES.every(n => uiNames.indexOf(n) >= 0),
     '**界面**上的 7 个座位全是新名（这才是用户看到的）', uiNames);
  ok(!OLD_NAMES.some(n => uiNames.some(x => x.startsWith(n))),
     '**界面**上没有旧名（用户报的「名字没改」不复现）', uiNames);

  const seatNames = (R.seats || []).map(a => a.name);
  ok(NEW_NAMES.every(n => seatNames.indexOf(n) >= 0), '7 个座位全是**新名**', seatNames);
  ok(Number(R.v) === ROSTER_V_SRC, '世代 v 被写成当前 ROSTER_V', R.v);

  // ★★ 命门：同一个 key = 同一个人 ⇒ 记忆必须留在座位上
  ok((R.bench || []).length === 0,
     '★★★ 替补席**为空** —— 改名不再被当成换人（旧逻辑会塞 7 个旧名进来）', (R.bench || []).length);
  const uiBench = uiBenchNames(A.dom);
  ok(uiBench.length === 0, '界面替补席也是空的（用户不会看到「被换下去的人」）', uiBench);
  const s0 = R.seats[0];
  ok(s0 && s0.key === 'liyi', '1 号座还是 liyi 这个人（key 没变）', s0 && s0.key);
  ok(s0 && s0.mem && s0.mem.notes[0] === '旧记忆1',
     '★★★ 1 号座的**旧记忆原样留在座位上**（不是被搬到替补席）', s0 && s0.mem && s0.mem.notes);
  ok(s0 && Number(s0.mem.reflects) === 30,
     '★★ 复盘次数也跟着留在座位上（30 次，不是被清零）', s0 && s0.mem.reflects);
  const allKept = (R.seats || []).every((a, i) => a.mem && a.mem.notes && a.mem.notes[0] === ('旧记忆' + (i + 1)));
  ok(allKept, '7 个座位的旧记忆**各归各位**（谁的就是谁的）',
     (R.seats || []).map(a => a.mem && a.mem.notes));

  A.dom.window.close();
}

// ── 第三节：反面 —— 当代存档 (v===ROSTER_V) **不许**再迁移 ──────
console.log('\n③ 反面：当代存档 (v===ROSTER_V) 不许再迁移（否则每局都重置阵容）');
{
  const seats = NEW_NAMES.map((n, i) => ({
    key: KEYS[i], name: n, emoji: '🙂', style: '稳健', look: '休闲',
    aggr: 5, tight: 5, bluff: 5, opt: 5, persona: '',
    mem: { notes: ['当代自定义记忆' + (i + 1)], reflects: 3 },
    stats: { hands: 1, wins: 0, chips: 1000 }, reads: {}
  }));
  const save = JSON.stringify({ v: ROSTER_V_SRC, seats: seats, bench: [], savedAt: Date.now() });
  const A = boot(save);
  const R = A.H.roster();
  const seatNames = (R.seats || []).map(a => a.name);
  ok(seatNames.every((n, i) => n === NEW_NAMES[i]), '当代存档的座位名字**原样不动**', seatNames);
  ok((R.bench || []).length === 0, '当代存档**不产生**替补席（没有被误迁移）', (R.bench || []).length);
  ok(R.seats[0].mem.notes[0] === '当代自定义记忆1', '当代存档的自定义记忆保住了', R.seats[0].mem.notes);
  ok(Number(R.seats[0].mem.reflects) === 3, '当代存档的复盘次数**不增不减**', R.seats[0].mem.reflects);
  A.dom.window.close();
}

// ── 第四节：跨一次页面加载（真持久化）──────────────────────────
console.log('\n④ 迁移结果**跨一次页面加载**仍在（真持久化，不是内存假象）');
{
  const A = boot(makeOldSave(2));
  const written = A.dom.window.localStorage.getItem(AGENTS_KEY);
  ok(!!written, '迁移后立刻写回了存档');
  const j = JSON.parse(written);
  ok(Number(j.v) === ROSTER_V_SRC, '写回存档的 v 就是新世代', j.v);
  ok((j.bench || []).length === 0, '写回存档里替补席是空的', (j.bench || []).length);

  const B = boot(written);                       // 真正的第二次加载
  const R2 = B.H.roster();
  const seatNames2 = (R2.seats || []).map(a => a.name);
  console.log('   第二次加载在座 : ' + seatNames2.join(' '));
  ok(NEW_NAMES.every(n => seatNames2.indexOf(n) >= 0), '重新加载后仍是 7 个新名', seatNames2);
  ok((R2.bench || []).length === 0, '重新加载后替补席仍为空（没被二次迁移）', (R2.bench || []).length);
  ok(R2.seats[0].mem.notes[0] === '旧记忆1', '重新加载后 1 号座的旧记忆仍在', R2.seats[0].mem.notes);
  B.dom.window.close();
  A.dom.window.close();
}

// ── 第五节：★★★ 已被劈开的存档 → 合并回一份（用户报障逐字复现）──
console.log('\n⑤ 已被劈开的存档（座位新名+薄记忆 / 替补席旧名+满记忆）→ 合并回一份');
{
  const A = boot(makeSplitSave(ROSTER_V_SRC - 1));   // v 比当前小一代 ⇒ 会触发迁移
  const R = A.H.roster();
  A.H.renderRoster();
  const seatNames = (R.seats || []).map(a => a.name);
  const uiNames = uiSeatNames(A.dom);
  ok(NEW_NAMES.every(n => seatNames.indexOf(n) >= 0), '座位上仍是 7 个新名', seatNames);
  ok(NEW_NAMES.every(n => uiNames.indexOf(n) >= 0), '**界面**上仍是 7 个新名', uiNames);

  ok((R.bench || []).length === 0,
     '★★★ 替补席被**收干净**了 —— 不会再有「被换下去的同一个人」', (R.bench || []).length);
  ok(uiBenchNames(A.dom).length === 0, '界面替补席为空（用户截图里那 4 个旧名消失）', uiBenchNames(A.dom));

  const s0 = R.seats[0];
  const notes = (s0 && s0.mem && s0.mem.notes) || [];
  console.log('   1 号座合并后的记忆 : ' + JSON.stringify(notes));
  ok(notes.indexOf('旧记忆1') >= 0, '★★ 旧的那份记忆（旧记忆1）**并回来了**', notes);
  ok(notes.indexOf('新座记忆1') >= 0, '★★ 新的那份记忆（新座记忆1）也留着（并集，不丢）', notes);
  ok(Number(s0.mem.reflects) === 34,
     '★★★ 复盘次数**相加**（1 + 33 = 34），不是二选一丢掉一边', s0 && s0.mem.reflects);
  ok(Number(s0.mem.notes.length) <= 12, 'notes 仍在主线上限内（≤12）', s0 && s0.mem.notes.length);
  ok(Number(s0.stats.hands) === 45, '战绩也合并（5 + 40 = 45 手）', s0 && s0.stats.hands);
  ok((s0.stats.recent || []).length <= 3, 'stats.recent 仍在主线上限内（≤3）', (s0.stats.recent || []).length);

  // 合并要跨一次加载仍在
  const written = A.dom.window.localStorage.getItem(AGENTS_KEY);
  const B = boot(written);
  const R2 = B.H.roster();
  ok((R2.bench || []).length === 0 && Number(R2.seats[0].mem.reflects) === 34,
     '合并结果跨一次页面加载仍在（不是内存假象）',
     { bench: (R2.bench || []).length, reflects: R2.seats[0].mem.reflects });
  B.dom.window.close();
  A.dom.window.close();
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
