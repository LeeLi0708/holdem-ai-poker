// 打一份真实的教练请求体出来看 —— 验证推理模式参数的确切形状
const fs=require('fs'), path=require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname,'..','德州扑克.html'),'utf8');
const bodies = [];
const vc = new VirtualConsole(); vc.on('jsdomError', ()=>{}); vc.on('error', ()=>{});
const dom = new JSDOM(html, { runScripts:'dangerously', pretendToBeVisual:true, url:'http://localhost/h',
  virtualConsole: vc,
  beforeParse(w){
    w.fetch = (url, opts)=>{
      const b = JSON.parse(opts.body);
      bodies.push(b);
      const sys = (b.messages.find(m=>m.role==='system')||{}).content||'';
      const usr = (b.messages.filter(m=>m.role==='user')[0]||{}).content||'';
      return Promise.resolve({ ok:true, status:200,
        json:()=>Promise.resolve({ choices:[{message:{content: JSON.stringify(
          sys.indexOf('决策质量')>=0 ? {score:80,verdict:'v',good:'g',bad:'b',fix:'f',note:'n'}
                                      : {action:'check',size:null,read:'r',think:'t',say:'s'})}}],
          usage:{prompt_tokens:100,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100,completion_tokens:50}}),
        text:()=>Promise.resolve('') });
    };
  }});
const w = dom.window, d = w.document;
setTimeout(async ()=>{
  const H = w.HOLDEM;
  // 直接问一次，看请求体
  const sys = H.coachSys('你是德州扑克教练，只带一个业余玩家，负责逐手复盘。');
  await H.coachAsk('coach-hand', sys, '【这一手 · 第 1 手】\n你的底牌：A♥ K♥', 1600);
  const last = bodies[bodies.length-1];
  const { temperature, ...rest } = last;
  console.log('=== 教练复盘请求体（思考模式） ===');
  console.log(JSON.stringify({
    model: rest.model, thinking: rest.thinking, reasoning_effort: rest.reasoning_effort,
    max_tokens: rest.max_tokens, response_format: rest.response_format,
    stream: rest.stream,
    有没有带_temperature: Object.prototype.hasOwnProperty.call(last,'temperature'),
    消息条数: rest.messages.length, 系统提示词字数: sys.length
  }, null, 2));
  console.log('\n=== 对比：牌局决策请求体（关思考） ===');
  const b0 = bodies.find(b=>!b.reasoning_effort);
  if (b0){
    console.log(JSON.stringify({ model:b0.model, thinking:b0.thinking, temperature:b0.temperature,
      max_tokens:b0.max_tokens, response_format:b0.response_format }, null, 2));
  } else {
    console.log('（这次只问了教练、没打牌，所以没有决策请求体。决策请求体的形状由 AI大脑自检 第 15 节断言：thinking=disabled + 带 temperature。）');
  }
  process.exit(0);
}, 400);
