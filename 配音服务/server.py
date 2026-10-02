#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地配音服务 —— 给「德州扑克.html」里的 7 个 AI 角色配上声音。

设计原则（和主程序一致）：
  · 只依赖标准库起 HTTP 服务；TTS 引擎本身是可换的「后端」。
  · 页面只报「谁在说 + 说了什么」，音色由同目录的 voices.json 决定 ——
    调音色不该去改那个 1.5MB 的 HTML。
  · 服务端自己也缓存一份：同一句话第二次直接吐字节，不再调引擎。

三种后端：
  edge   默认。pip install edge-tts 就能跑，不需要显卡，不需要联网以外的任何东西。
  cosy   CosyVoice 2（本地 GPU）。音色可克隆、可控情绪，但要自己装 torch+CUDA。
  cmd    你自己写一条命令（读文本、写音频文件），本服务负责包成 HTTP。

用法：
  python server.py                     # 用 voices.json 里的 backend
  python server.py --backend edge
  python server.py --list-voices       # 列出 edge 后端可用的中文音色
  python server.py --port 9880
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# CosyVoice 源码与权重的默认位置（见 配音服务/README.md 的安装章节）
DEFAULT_REPO = os.environ.get('COSY_REPO') or ''
VOICES_PATH = os.path.join(HERE, 'voices.json')
CACHE_MAX = 600

# ============================================================ 音色表


def load_voices():
    """读 voices.json。读不到就用内置的兜底表 —— 服务不能因为一个 json 缺失就起不来。"""
    fallback = {
        'backend': 'edge',
        'voices': {
            'liyi':   {'voice': 'zh-CN-XiaoxiaoNeural', 'rate': '-12%', 'pitch': '-4Hz'},
            'maiqi':  {'voice': 'zh-CN-XiaoyiNeural',   'rate': '+18%', 'pitch': '+6Hz'},
            'aimi':   {'voice': 'zh-CN-XiaoxiaoNeural', 'rate': '+2%',  'pitch': '-1Hz'},
            'jiexi':  {'voice': 'zh-CN-XiaoyiNeural',   'rate': '+8%',  'pitch': '+2Hz'},
            'wangyi': {'voice': 'zh-CN-liaoning-XiaobeiNeural', 'rate': '-10%', 'pitch': '-3Hz'},
            'lili':   {'voice': 'zh-CN-XiaoyiNeural',   'rate': '-6%',  'pitch': '+10Hz'},
            'hujie':  {'voice': 'zh-CN-XiaoxiaoNeural', 'rate': '+6%',  'pitch': '-6Hz'},
        },
        'default': {'voice': 'zh-CN-XiaoxiaoNeural', 'rate': '+0%', 'pitch': '+0Hz'},
    }
    try:
        with io.open(VOICES_PATH, encoding='utf-8') as f:
            j = json.load(f)
        if not isinstance(j, dict):
            return fallback
        if not isinstance(j.get('voices'), dict) or not j['voices']:
            j['voices'] = fallback['voices']
        if not isinstance(j.get('default'), dict):
            j['default'] = fallback['default']
        j.setdefault('backend', 'edge')
        return j
    except FileNotFoundError:
        return fallback
    except Exception as e:
        print('!! voices.json 读不动（%s），改用内置表。' % e)
        return fallback


VOICES = load_voices()

# ============================================================ 语气表（演技）

# CosyVoice2 支持用「自然语言指令」控制**怎么说**（情绪 / 语速 / 音量 / 风格 /
# 方言），同一副嗓子能演出完全不同的味道 —— 这就是「配音感」的来源。
#
# 下面这些指令不是我们编的，是官方在 cosyvoice/utils/common.py 的 instruct_list
# 里列出的**实测过**的那一批。id 是稳定契约：页面只报 id，指令串留在服务端
# —— 想加一种语气，改这里就行，页面一行都不用动。
#
# 只管两件事：**情绪**和**语速**。音量 / 风格 / 方言那几类官方也能做，但牌桌上
# 用不上，先不铺开 —— 想加就是照格式往表里添一行的事。
TONES = {
    'flat':  {'label': '平铺直叙', 'ins': ''},
    'hot':   {'label': '恼火',     'ins': 'You are a helpful assistant. 请非常生气地说一句话。<|endofprompt|>'},
    'glad':  {'label': '得意',     'ins': 'You are a helpful assistant. 请非常开心地说一句话。<|endofprompt|>'},
    'down':  {'label': '丧气',     'ins': 'You are a helpful assistant. 请非常伤心地说一句话。<|endofprompt|>'},
    'quick': {'label': '急促',     'ins': 'You are a helpful assistant. 请用尽可能快地语速说一句话。<|endofprompt|>'},
}

# ⚠ slow「慢悠悠」已于第二十九轮下架：那条指令会被模型理解成「边说边停」，
#   一句里塞进近两秒死空白。删掉条目即可 —— tone_ins() 查不到就返回 ''，
#   老存档里带着 slow 的请求会安静地退化成「不特别」，不会报错。


def tone_ins(tid):
    # 语气 id -> 指令串。不认识的 id 一律当「没有语气」，绝不让页面把服务搞挂。
    t = TONES.get(str(tid or '').strip())
    return (t or {}).get('ins') or ''


# ============================================================ 副语言标记（音效）

# CosyVoice2 的 tokenizer 把这些方括号注册成了**独立特殊 token**
# （cosyvoice/tokenizer/tokenizer.py:245 的 additional_special_tokens），
# 所以写在台词里就能让引擎在该处笑一声 / 叹口气 / 抽口气 —— **硬控制**，
# 不是靠提示词劝出来的，也不吃 inference_instruct2 那条路。
#
# ⚠ 这张表是白名单。AI 自己编的标记（[angry] / [笑] 之类）不在册，
#   引擎不会把它当音效，而是当普通文字念出来 —— 听着就是一段莫名其妙的英文。
#   所以不认的一律**删掉**，不是留着。
PARAS = ['laughter', 'sigh', 'breath', 'noise', 'cough', 'clucking',
         'accent', 'quick_breath', 'hissing', 'vocalized-noise',
         'lipsmack', 'mn']

# 人也认得的写法：AI 偶尔会写成 [laugh] / [sighing]，顺手归一，别为这点事重来一遍
PARA_ALIAS = {
    'laugh': 'laughter', 'laughs': 'laughter', 'chuckle': 'laughter',
    'breathing': 'breath', 'breathe': 'breath', 'inhale': 'breath', 'exhale': 'breath',
    'sighing': 'sigh', 'sighs': 'sigh', 'deep_breath': 'breath',
    # AI 偶尔会用中文写。只收最没有歧义的几个；「[哼]」「[冷笑]」这类照剥 ——
    # 引擎本来也不认识，留着只会被念出来。
    '笑': 'laughter', '笑声': 'laughter', '大笑': 'laughter', '哈哈': 'laughter',
    '叹气': 'sigh', '唉': 'sigh', '哀叹': 'sigh',
    '吸气': 'breath', '换气': 'breath', '深呼吸': 'breath', '喘气': 'breath',
}

# 半角 [x] 和全角 【x】 都算标记，里面的内容不限字符（所以中文标记也能识别、也能剥）。
# ⚠ 全角这两兄弟必须一起管：remove_bracket 会把【】删掉、把里面的字留下，
#   不在这里整段剥掉的话，「【笑】」最后就变成一个字正腔圆的「笑」被念出去。
PARA_RE = re.compile(r'[\[【]\s*([^\[\]【】]+?)\s*[\]】]')


def clean_para(text):
    # 只留白名单里的副语言标记，其余方括号标记一律剥掉。认不出的删掉而不是留着。
    def _sub(m):
        w = m.group(1).lower()
        w = PARA_ALIAS.get(w, w)
        return '[%s]' % w if w in PARAS else ''
    return PARA_RE.sub(_sub, str(text or ''))

# 语速倍率的合法区间 —— 越界就夹住，别让一个手滑的请求把嗓子拉成怪声。
SPEED_MIN, SPEED_MAX = 0.5, 2.0


# ---------------------------------------------------------------- 句内静音瘦身
GAP_MAX_SEC = 0.40      # 内部空白超过这个长度就压到这么长


def trim_long_gaps(audio, sr, max_gap=GAP_MAX_SEC):
    """把**句内**超长静音压短，首尾不动。

    动机（2026-10-02 实测）：口气「慢悠悠」的指令是「请用尽可能慢地语速说一句话」，
    CosyVoice 会把它理解成「边说边停」—— 艾米那句 9.60 秒里塞了 1.80 + 0.95 秒
    两段死空白，王姨 13.32 秒里塞了 2.90 + 1.43 秒。听感就是「一卡一卡的」。
    **慢速该体现在语速上，不该体现在空白上。**

    ⚠ 从静音段中间裁：裁掉的两侧本来都接近零，拼起来不会爆音。
    ⚠ 没有超长静音就原样返回 —— 正常句子一个样本都不动。
    """
    import numpy as np
    audio = np.ascontiguousarray(audio)
    n = int(audio.shape[0]) if audio.ndim == 1 else int(audio.shape[-1])
    win = max(2, int(0.020 * sr))
    hop = max(1, int(0.010 * sr))
    if n < win * 4:
        return audio
    nf = (n - win) // hop + 1
    frames = np.lib.stride_tricks.as_strided(
        audio, shape=(nf, win), strides=(audio.strides[0] * hop, audio.strides[0]))
    rms = np.sqrt((frames.astype(np.float32) ** 2).mean(axis=1) + 1e-12)
    peak = float(np.percentile(rms, 95))
    if peak <= 0:
        return audio
    silent = rms < max(peak * 0.01, 1e-4)

    cuts = []
    i = 0
    while i < nf:
        if not silent[i]:
            i += 1
            continue
        j = i
        while j < nf and silent[j]:
            j += 1
        s = i * hop
        e = min(n, (j - 1) * hop + win)
        # 只动内部静音：首尾留着（句首那口气是自然的，句尾无所谓）
        if i > 0 and j < nf and (e - s) > max_gap * sr:
            keep = int(round(max_gap * sr))
            # ⚠ 保留**两端各一半**、裁中间：起点必须是 s + keep//2。
            #   写成 s + drop//2 会让裁剪区间越过段尾，把静音后面的**字一起吃掉**
            #   （这个 bug 被验证脚本的正向断言抓到过一次，见 _probe静音瘦身.py）。
            a = s + keep // 2
            b = e - (keep - keep // 2)
            cuts.append((a, b))
        i = j
    if not cuts:
        return audio

    keep = []
    cur = 0
    for a, b in cuts:
        keep.append(audio[cur:a])
        cur = b
    keep.append(audio[cur:])
    return np.concatenate(keep)


def norm_speed(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f <= 0:            # NaN / 负数 / 零
        return None
    return max(SPEED_MIN, min(SPEED_MAX, f))


# ============================================================ 后端

RATE_RE = re.compile(r'^[+-]\d{1,3}%$')
PITCH_RE = re.compile(r'^[+-]\d{1,3}Hz$')


def norm_rate(v):
    s = str(v or '+0%').strip()
    return s if RATE_RE.match(s) else '+0%'


def norm_pitch(v):
    s = str(v or '+0Hz').strip()
    return s if PITCH_RE.match(s) else '+0Hz'


class BackendError(Exception):
    pass


class EdgeBackend:
    """edge-tts：微软的免费合成。不需要显卡，pip 一个包就能用 —— 先用它把链路跑通。"""

    name = 'edge'
    mime = 'audio/mpeg'

    def __init__(self):
        try:
            import edge_tts  # noqa: F401
        except Exception:
            raise BackendError(
                '没装 edge-tts。在命令行里跑一次：\n'
                '    pip install edge-tts\n'
                '装完再启动本服务。'
            )
        self._edge = edge_tts

    def synth(self, key, text, cfg):
        import asyncio

        async def run():
            c = self._edge.Communicate(
                text,
                cfg.get('voice') or 'zh-CN-XiaoxiaoNeural',
                rate=norm_rate(cfg.get('rate')),
                pitch=norm_pitch(cfg.get('pitch')),
                volume='+0%',
            )
            buf = bytearray()
            async for chunk in c.stream():
                if chunk.get('type') == 'audio':
                    buf += chunk['data']
            return bytes(buf)

        data = asyncio.run(run())
        if not data:
            raise BackendError('edge-tts 没有返回音频')
        return data

    @staticmethod
    def list_chinese_voices():
        import asyncio
        import edge_tts

        vs = asyncio.run(edge_tts.list_voices())
        out = []
        for v in vs:
            loc = str(v.get('Locale', ''))
            if loc.startswith('zh-'):
                out.append((v.get('ShortName', ''), v.get('Gender', ''), loc))
        return sorted(out)


class CosyBackend:
    """CosyVoice 2（本地 GPU / CPU）。0.5B 参数，约 4~6GB 显存，流式首包 <150ms。

    音色走「零样本克隆」，但**不每次读参考音频**：
    先把每个角色的参考音频注册进 spk2info.pt，之后合成只报 spk_id —— 走的是缓存好的
    speaker embedding / speech token，省掉每次重算。注册是一次性的，见 准备音色.py。

    参考音频从哪来？默认脚本用 edge-tts 生成 7 段（零素材、马上能用），
    随时可以换成你自己的录音 —— 换成真人录音就是真正的「复刻」，代码一行不用改。
    """

    name = 'cosy'
    mime = 'audio/wav'

    def __init__(self):
        cfg = VOICES.get('cosy') or {}
        self.repo = (cfg.get('repo') or os.environ.get('COSY_REPO') or DEFAULT_REPO).rstrip('\\/')
        self.model_dir = (cfg.get('model_dir') or os.environ.get('COSY_MODEL') or '').rstrip('\\/')
        self.fp16 = bool(cfg.get('fp16', True))
        self.speed = float(cfg.get('speed', 1.0) or 1.0)
        self._lock = threading.Lock()
        self._warned = set()
        # 语气模式（instruct）必须把参考音频以**文件路径**交回去，不能用注册过的
        # spk_id —— 上游 frontend_instruct2 会重新从 wav 提一遍特征。
        self.ref_dir = os.path.join(HERE, '音色参考')

        if not self.model_dir:
            raise BackendError(
                'voices.json 的 cosy.model_dir 是空的，也没设环境变量 COSY_MODEL。\n'
                '   例：C:\\Users\\你\\.workbuddy\\binaries\\cosyvoice\\pretrained_models\\CosyVoice2-0.5B'
            )
        if not os.path.isdir(self.model_dir):
            raise BackendError('模型目录不存在：%s\n（跑一次 下载模型.py 就有了）' % self.model_dir)

        missing = [f for f in ('cosyvoice2.yaml', 'llm.pt', 'flow.pt', 'hift.pt',
                               'campplus.onnx', 'speech_tokenizer_v2.onnx')
                   if not os.path.exists(os.path.join(self.model_dir, f))]
        if missing:
            raise BackendError('模型目录不完整，缺：%s\n（跑一次 下载模型.py，它会断点续传）'
                               % '、'.join(missing))

        if not os.path.isdir(self.repo):
            raise BackendError('CosyVoice 源码目录不存在：%s' % self.repo)

        # 源码根 + Matcha-TTS 都要在 sys.path 上（上游就是这么用的，没 pip install）
        for p in (self.repo, os.path.join(self.repo, 'third_party', 'Matcha-TTS')):
            if not os.path.isdir(p):
                raise BackendError('缺少目录：%s' % p)
            if p not in sys.path:
                sys.path.insert(0, p)
        if self.model_dir not in sys.path:
            sys.path.insert(0, os.path.dirname(self.model_dir))

        try:
            from cosyvoice.cli.cosyvoice import CosyVoice2
        except Exception as e:
            raise BackendError(
                'import CosyVoice2 失败：%s\n'
                '  常见原因：没在这个 conda 环境里装依赖。看 配音服务/README.md 的安装章节。' % e
            )

        print('  正在加载 CosyVoice 2（第一次要 30~60 秒）…')
        t0 = time.time()
        try:
            self.model = CosyVoice2(self.model_dir, load_jit=False, load_trt=False, fp16=self.fp16)
        except Exception as e:
            raise BackendError('CosyVoice2 加载失败：%s' % e)
        self.sr = int(getattr(self.model, 'sample_rate', 24000))
        print('  模型加载完事，用了 %.0f 秒' % (time.time() - t0))

        # 已注册的音色（spk2info.pt）
        try:
            self.spks = list(self.model.list_available_spks())
        except Exception:
            self.spks = []
        self.want = sorted((VOICES.get('voices') or {}).keys())
        have = [k for k in self.want if (self._spk_of(k) in self.spks)]
        lack = [k for k in self.want if k not in have]
        print('  🎙 音色就绪 %d / %d' % (len(have), len(self.want)))
        if lack:
            print('     ⚠ 还没注册：%s' % '、'.join(lack))
            print('       跑一次「准备音色.py」给它们建音色（会打印具体命令）')
        if not have:
            raise BackendError(
                '一个音色都没注册 —— 先去跑「配音服务/准备音色.py」，\n'
                '它会用 edge-tts 生成 7 段参考音频并注册进 spk2info.pt。'
            )

    def _spk_of(self, key):
        cfg = (VOICES.get('voices') or {}).get(key) or {}
        return cfg.get('spk_id') or key

    def synth(self, key, text, cfg):
        import numpy as np
        import soundfile as sf

        spk = self._spk_of(key)
        if spk not in self.spks:
            fb = self.spks[0]
            if key not in self._warned:
                self._warned.add(key)
                print('   ⚠ 音色 %s 没注册，先用 %s 顶着（跑「准备音色.py」补齐）' % (spk, fb))
            spk = fb

        speed = norm_speed(cfg.get('speed')) or float(self.speed or 1.0)
        ins = str(cfg.get('instruct') or '')

        # 没有语气 → 走老路：直接用注册好的 spk_id，省掉每次重提特征的开销。
        # 有语气   → 必须走 instruct2，而且得把参考音频路径一起交回去。
        # ⚠ 参考音频找不到就**静默退回老路**：宁可少一点演技，也不能这一句不出声。
        wav = ''
        if ins:
            for cand in (key, spk):
                p = os.path.join(self.ref_dir, str(cand) + '.wav')
                if os.path.exists(p):
                    wav = p
                    break
            if not wav:
                ins = ''

        chunks = []
        # 串行合成：GPU 上并发跑反而更慢，而且会和浏览器抢显存
        with self._lock:
            try:
                if ins:
                    gen = self.model.inference_instruct2(
                        text, ins, wav, stream=False, speed=speed)
                else:
                    gen = self.model.inference_zero_shot(
                        text, '', '', zero_shot_spk_id=spk, stream=False, speed=speed)
                for out in gen:
                    chunks.append(out['tts_speech'].numpy().flatten())
            except Exception as e:
                raise BackendError('合成失败（音色 %s）：%s' % (spk, e))

        if not chunks:
            raise BackendError('CosyVoice 没有返回音频')
        audio = np.concatenate(chunks)
        # 🔇 句内超长空白压短 —— 「慢悠悠」会让模型边说边停（详见 trim_long_gaps）。
        audio = trim_long_gaps(audio, self.sr)
        bio = io.BytesIO()
        sf.write(bio, audio, self.sr, format='WAV', subtype='PCM_16')
        return bio.getvalue()


class CmdBackend:
    """万能兜底：把文本写进临时文件，跑你自己的命令，把它生成的音频读回来。

    voices.json 里配：
      "cmd": { "run": "mytool.exe --text {txt} --out {out}", "ext": "wav" }
    {txt} 会被替换成文本文件路径（UTF-8），{out} 是要求生成的音频路径。
    """

    name = 'cmd'

    def __init__(self):
        cfg = VOICES.get('cmd') or {}
        self.tpl = cfg.get('run') or ''
        if not self.tpl:
            raise BackendError('voices.json 里没配 cmd.run')
        self.ext = cfg.get('ext') or 'wav'
        self.mime = 'audio/mpeg' if self.ext.lower() in ('mp3', 'mpeg') else 'audio/wav'

    def synth(self, key, text, cfg):
        d = tempfile.mkdtemp(prefix='tts_')
        txt = os.path.join(d, 'in.txt')
        out = os.path.join(d, 'out.' + self.ext)
        with io.open(txt, 'w', encoding='utf-8') as f:
            f.write(text)
        cmd = self.tpl.replace('{txt}', txt).replace('{out}', out)
        p = subprocess.run(cmd, shell=True, capture_output=True)
        if p.returncode != 0:
            raise BackendError('命令失败（%d）：%s' % (p.returncode, p.stderr.decode('utf-8', 'ignore')[:200]))
        if not os.path.exists(out):
            raise BackendError('命令没生成音频文件：%s' % out)
        with open(out, 'rb') as f:
            return f.read()


def make_backend(name):
    name = (name or 'edge').lower()
    if name == 'edge':
        return EdgeBackend()
    if name == 'cosy':
        return CosyBackend()
    if name == 'cmd':
        return CmdBackend()
    raise BackendError('不认识的后端：%s（可选 edge / cosy / cmd）' % name)


# ============================================================ 服务端缓存
_cache = {}
_cache_lock = threading.Lock()


def cache_get(k):
    with _cache_lock:
        v = _cache.get(k)
        if v is None:
            return None
        _cache.pop(k, None)
        _cache[k] = v          # 摸一下 = 最近用过
        return v


def cache_put(k, v):
    with _cache_lock:
        _cache[k] = v
        while len(_cache) > CACHE_MAX:
            _cache.pop(next(iter(_cache)))


# ============================================================ HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = 'HoldemTTS/1.0'
    protocol_version = 'HTTP/1.1'
    backend = None

    def log_message(self, fmt, *args):
        sys.stdout.write('  · %s\n' % (fmt % args))

    # ---- 公共响应头：file:// 打开的页面 Origin 是 null，必须给 CORS。
    #      POST + application/json 会触发 OPTIONS 预检，所以下面必须实现 do_OPTIONS。
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/ping'):
            return self._json(200, {
                'ok': True,
                'backend': self.backend.name,
                'voices': sorted(VOICES.get('voices', {}).keys()),
                'cache': len(_cache),
            })
        if self.path.startswith('/voices'):
            return self._json(200, VOICES)
        if self.path.startswith('/tones'):
            # 页面不需要知道指令串长什么样，只要知道有哪些 id 可选。
            return self._json(200, {'ok': True, 'tones': [
                {'id': k, 'label': v['label'], 'on': bool(v['ins'])}
                for k, v in TONES.items()],
                # 页面自检拿它核对「两边的白名单没有跑偏」
                'paras': list(PARAS)})
        return self._json(404, {'ok': False, 'err': '只提供 POST /tts、GET /ping、GET /voices'})

    def do_POST(self):
        # ⚠ 先把请求体读完，再判路径。
        #   否则 keep-alive 连接上「没被读走的那截 body」会被当成下一个请求来解析，
        #   日志里就会刷出一堆 "Bad HTTP/0.9 request type"（自检里真踩到过）。
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        raw = b''
        if n > 0:
            raw = self.rfile.read(n if n <= 64 * 1024 else 64 * 1024)

        if not self.path.startswith('/tts'):
            return self._json(404, {'ok': False, 'err': '路径不对，应该是 POST /tts'})
        if n <= 0:
            return self._json(400, {'ok': False, 'err': '请求体是空的'})
        if n > 64 * 1024:
            return self._json(400, {'ok': False, 'err': '请求体太大了'})
        try:
            req = json.loads(raw.decode('utf-8'))
        except Exception as e:
            return self._json(400, {'ok': False, 'err': '不是合法 JSON：%s' % e})

        text = str(req.get('text') or '').strip()
        if not text:
            return self._json(400, {'ok': False, 'err': 'text 不能为空'})
        if len(text) > 300:
            text = text[:300]

        # 🎭 副语言标记：只放行白名单里的那几个，AI 自己编的剥掉。
        #    ⚠ 必须在这里剥（不是 synth 里）—— 缓存键紧接着用 text，剥干净了才不浪费缓存。
        text = clean_para(text)
        if not text.strip():
            return self._json(400, {'ok': False, 'err': 'text 里只有标记，剥掉之后就没东西可念了'})

        key = str(req.get('speaker') or '')
        cfg = dict(VOICES.get('voices', {}).get(key) or VOICES.get('default') or {})

        # 请求级的「怎么说」—— 覆盖 voices.json 里的静态配置。
        # 只认白名单：不认识的 tone 当没有，越界的 speed 夹回区间。
        tone = str(req.get('tone') or '').strip()
        if tone:
            ins = tone_ins(tone)
            if ins:
                cfg['instruct'] = ins
        sp = norm_speed(req.get('speed'))
        if sp is not None:
            # 和角色自己的快慢底色**相乘**：李姨的慢是她的性格，总倍率是全场调音，
            # 两者互不顶替。夹一次，免得 0.88 × 0.7 之后再乘出怪声。
            base = norm_speed(cfg.get('speed')) or 1.0
            cfg['speed'] = norm_speed(base * sp) or base

        # ⚠ 缓存键必须把「怎么说」整个算进去。少一项，换个语气就是旧声音重放。
        ck = (self.backend.name, key, text, str(cfg.get('rate')),
              str(cfg.get('pitch')), str(cfg.get('instruct')), str(cfg.get('speed')))
        hit = cache_get(ck)
        if hit is not None:
            return self._send_audio(hit, cached=True)

        t0 = time.time()
        try:
            data = self.backend.synth(key, text, cfg)
        except Exception as e:
            print('!! 合成失败：%s' % e)
            return self._json(500, {'ok': False, 'err': str(e)[:300]})
        ms = int((time.time() - t0) * 1000)
        cache_put(ck, data)
        print('  [%s] %s 字 → %d 字节 / %dms  「%s」'
              % (key or 'default', len(text), len(data), ms, text[:18]))
        return self._send_audio(data, cached=False)

    def _send_audio(self, data, cached):
        self.send_response(200)
        self.send_header('Content-Type', self.backend.mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-TTS-Cache', 'hit' if cached else 'miss')
        self._cors()
        self.end_headers()
        self.wfile.write(data)


# ============================================================ 入口


def main():
    ap = argparse.ArgumentParser(description='本地配音服务（给德州扑克.html 用）')
    ap.add_argument('--backend', default=None, help='edge / cosy / cmd（默认取 voices.json）')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=9880)
    ap.add_argument('--list-voices', action='store_true', help='列出 edge 可用的中文音色后退出')
    args = ap.parse_args()

    if args.list_voices:
        try:
            for sn, g, loc in EdgeBackend.list_chinese_voices():
                print('%-38s %-7s %s' % (sn, g, loc))
        except Exception as e:
            print('列不出来：%s' % e)
        return

    name = args.backend or VOICES.get('backend') or 'edge'

    # 端口被占（服务已经在跑）不算错误 —— 直接用现成的那个就行，别把用户吓一跳
    try:
        backend = make_backend(name)
    except BackendError as e:
        print('\n❌ 起不来：后端 %s\n%s\n' % (name, e))
        print('提示：先用 edge 后端把链路跑通 ——  pip install edge-tts\n')
        sys.exit(1)

    Handler.backend = backend
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print('\n❌ 端口 %d 起不来（多半是已经在跑了）：%s' % (args.port, e))
        print('   已经开着就不用再开。直接回页面点「连通性测试」试试。\n')
        sys.exit(1)

    nv = len(VOICES.get('voices') or {})
    print('')
    print('  🎙 本地配音服务已启动')
    print('     后端      %s' % backend.name)
    print('     地址      http://%s:%d/tts' % (args.host, args.port))
    print('     音色      已配置 %d 个角色（voices.json）' % nv)
    print('     缓存      最多 %d 句' % CACHE_MAX)
    print('')
    print('  ⚠ 这个窗口别关 —— 关了配音就不出声了。')
    print('     用完按 Ctrl+C 停掉。')
    print('')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止。\n')


if __name__ == '__main__':
    main()
