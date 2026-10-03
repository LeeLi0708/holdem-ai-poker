/* _check座位名牌.js —— 座位名牌必须能完整显示 4 字名（第三十三轮补丁的守卫）
 *
 * 报障：用户说「名字不能显示全」。座位宽度是按 **2 字名**（李姨/麦琪）留的，
 *   改成 3~4 字（墨千夜 / 糖宫莉莉 / 零·苓霜）之后放不下：
 *     · AI 大脑**关**：糖宫莉莉 要 54px，只有 50px ⇒ 缺 4px
 *     · AI 大脑**开**：🧠 再吃 15px ⇒ **7 个名字全被截**，最狠缺 20px
 *
 * ⚠⚠ 为什么必须用**真浏览器**：
 *   jsdom 没有排版引擎 —— offsetWidth / clientWidth 恒为 0、offsetParent 恒为 null。
 *   这条 bug 恰好是纯排版问题，用 jsdom 写出来会「全绿」却什么也没测到（假绿）。
 *   所以这里起一个无头 Chrome，读**真实布局**的 clientWidth / scrollWidth。
 *
 * ⚠ 本脚本**不依赖**主自检套件：Chrome 找不到就明确报 SKIP（而不是假装通过）。
 *   跑不动却「全绿」比跑不动更糟 —— 那会让人以为布局被人守着。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 允许传入别的 HTML 来跑（用来证明"这条守卫真能红"：拿打补丁前的备份撞一次）
const HTML = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, '德州扑克.html');

let pass = 0, fail = 0, skip = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra !== undefined ? '  → ' + extra : '')); }
}

const html = fs.readFileSync(HTML, 'utf8');

// ── 找浏览器 ────────────────────────────────────────────────
function findBrowser() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

console.log('=== 座位名牌能否显示全（第三十三轮） ===');

// ── 一、静态：CSS 覆盖存在、且排在原有规则之后 ──────────────
console.log('\n① 静态检查（不依赖浏览器）');
{
  const OLD = '.seat{ width:174px; }';
  const NEW = '.seat{ width:198px; }';
  ok(html.indexOf(OLD) >= 0, '原宽度规则 .seat{width:174px} 还在（说明我是"覆盖"而不是"改写"）');
  ok(html.indexOf(NEW) >= 0, '新宽度规则 .seat{ width:198px; } 存在');
  // ⚠ 同权重下"谁后写谁赢" —— 必须排在既有规则之后，否则白改
  ok(html.indexOf(NEW) > html.indexOf(OLD),
     '新规则排在原规则**之后**（同权重靠后赢，这条不成立就白改）');
  ok(html.indexOf('.seat.mine{ width:210px; }') > html.indexOf('.seat.mine{ width:186px; }'),
     '人类座位 .seat.mine 也排在原规则之后');
  ok(html.indexOf('.ln1 .sty{ font-size:9px; padding:1px 4px; }') >= 0,
     '风格徽章收窄规则存在');
  // 名字字号**不许**被改小 —— 名字是给人读的
  ok(html.indexOf('.ln1 .nm{ font-size:13.5px;') >= 0,
     '名字字号仍是 13.5px（没有为了塞下去把它缩小）');
  ok(html.indexOf('.ln1 .nm{ font-size:12') < 0 && html.indexOf('.ln1 .nm{ font-size:13px') < 0,
     '没有出现把名字改小的规则');
}

// ── 二、真实布局：起无头浏览器量 ────────────────────────────
const browser = findBrowser();
if (!browser) {
  skip++;
  console.log('\n② 真实布局检查 —— ⏭ SKIP');
  console.log('   没找到 Chrome/Edge。**这不是通过**：布局这条线这次没人守。');
  console.log('   装了 Chrome 再跑一次即可。');
} else {
  console.log('\n② 真实布局检查（' + path.basename(browser) + ' 无头）');

  const probe = `
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    try{
      var t = document.getElementById('table');
      var R = t.getBoundingClientRect();
      var scale = R.width / 1160;
      function trunc(){
        var o = [];
        document.querySelectorAll('#table .seat').forEach(function(el){
          var nm = el.querySelector('.ln1 .nm');
          o.push({ n: nm.textContent, c: nm.clientWidth, s: nm.scrollWidth,
                   cut: nm.scrollWidth - nm.clientWidth });
        });
        return o;
      }
      var off = trunc();
      document.querySelectorAll('#table .seat .ln1 .brn').forEach(function(b){ b.textContent = '🧠'; });
      var on = trunc();
      var seats = [];
      document.querySelectorAll('#table .seat').forEach(function(el){
        var r = el.getBoundingClientRect();
        seats.push({ n: el.querySelector('.ln1 .nm').textContent,
          l:(r.left-R.left)/scale, r:(r.right-R.left)/scale,
          t:(r.top-R.top)/scale,  b:(r.bottom-R.top)/scale });
      });
      var ov = [];
      for (var i=0;i<seats.length;i++) for (var j=i+1;j<seats.length;j++){
        var a=seats[i], b=seats[j];
        var ox = Math.min(a.r,b.r)-Math.max(a.l,b.l), oy = Math.min(a.b,b.b)-Math.max(a.t,b.t);
        if (ox>0 && oy>0) ov.push(a.n+'x'+b.n);
      }
      var out = [];
      seats.forEach(function(s){
        if (s.l<-0.5 || s.r>1160.5 || s.t<-0.5 || s.b>760.5) out.push(s.n);
      });
      var pre = document.createElement('pre'); pre.id = '__SEATCHK__';
      pre.textContent = '<<<' + JSON.stringify({ scale:+scale.toFixed(3), off:off, on:on, ov:ov, out:out }) + '>>>';
      document.body.appendChild(pre);
    }catch(e){
      var p2 = document.createElement('pre'); p2.id='__SEATCHK__';
      p2.textContent = '<<<ERR ' + e.message + '>>>';
      document.body.appendChild(p2);
    }
  }, 1500);
});
</script>
</body>`;

  const tmp = path.join(os.tmpdir(), 'holdem_seat_probe.html');
  fs.writeFileSync(tmp, html.replace('</body>', probe, 1), 'utf8');

  let dom = '';
  try {
    dom = execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--window-size=1600,1000',
      '--dump-dom', '--virtual-time-budget=9000',
      '--allow-file-access-from-files',
      'file:///' + tmp.replace(/\\/g, '/'),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    dom = '';
  }

  const m = /&lt;&lt;&lt;([\s\S]*?)&gt;&gt;&gt;/.exec(dom);
  if (!m) {
    fail++;
    console.log('  ❌ 拿不到浏览器的测量结果（页面没跑起来？）');
  } else {
    const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    let D = null;
    try { D = JSON.parse(raw); } catch (e) {}
    if (!D || D.off === undefined) {
      fail++;
      console.log('  ❌ 测量结果解析失败：' + raw.slice(0, 200));
    } else {
      console.log('   缩放 = ' + D.scale);
      const badOff = D.off.filter(d => d.cut > 1);
      const badOn = D.on.filter(d => d.cut > 1);
      D.off.forEach(d => console.log('     [关] ' + d.n + '  client=' + d.c + ' need=' + d.s + ' cut=' + d.cut));
      D.on.forEach(d => console.log('     [开] ' + d.n + '  client=' + d.c + ' need=' + d.s + ' cut=' + d.cut));

      ok(D.off.length === 8, '量到了 8 个座位', D.off.length);
      ok(badOff.length === 0,
         '★★ AI 大脑**关**：0 个名字被截（原来 糖宫莉莉 缺 4px）',
         badOff.map(d => d.n + '缺' + d.cut).join(', '));
      ok(badOn.length === 0,
         '★★★ AI 大脑**开**：0 个名字被截（原来 7 个全截，最狠缺 20px）—— 这条是命门',
         badOn.map(d => d.n + '缺' + d.cut).join(', '));
      ok((D.ov || []).length === 0, '★★ 加宽后座位两两不压叠', (D.ov || []).join(', '));
      ok((D.out || []).length === 0, '★★ 加宽后没有座位越出牌桌', (D.out || []).join(', '));
    }
  }

  try { fs.unlinkSync(tmp); } catch (e) {}
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败' + (skip ? ' / ' + skip + ' 跳过' : '') + ' ===');
process.exit(fail ? 1 : 0);
