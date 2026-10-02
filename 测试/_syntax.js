// 主文件内联脚本语法自检（改完文件先跑这个，比开浏览器快）
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', '德州扑克.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.log('❌ 没找到 script 块'); process.exit(1); }
try { new vm.Script(m[1], { filename: 'poker.js' }); console.log('✅ 语法通过，脚本 ' + m[1].split('\n').length + ' 行'); }
catch (e) { console.log('❌ 语法错误: ' + e.message); process.exit(1); }
