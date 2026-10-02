#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 7 个角色准备音色（CosyVoice 2 用的参考音频 + 注册进 spk2info.pt）。

**为什么要这一步**：CosyVoice2-0.5B 是基座模型，**自带音色表是空的**
（没有 spk2info.pt）。它靠「零样本克隆」工作 —— 给它一段参考音频，
它学着那个嗓子说话。所以要先给每个角色一段参考音频。

**参考音频从哪来**，三条路，按省事程度排：

  ① 默认：本脚本用 edge-tts 生成 7 段（每个角色一个不同的嗓子）。
     零素材、立刻能用。缺点：本质还是 edge-tts 的音色，只是搬到了本地。

  ② 换成真人录音（推荐，也是这套方案真正的价值）：
     把 配音服务/音色参考/<角色key>.wav 替换成你自己的录音，重跑本脚本即可。
     要求：**6~10 秒、干净、无背景音乐、只有一个人说话、普通话**。
     ⚠ 用别人的声音要先取得同意。

  ③ 用开源多说话人数据集（如 AISHELL-3 一类）挑 7 个不同女声当参考。
     这是「不找人也能有 7 个真嗓子」的正路。

跑完之后，合成时只报角色 key，不再重新读参考音频（走缓存好的 speaker 表示）。

    python 准备音色.py                # 生成缺的参考音频 + 注册
    python 准备音色.py --refs-only    # 只生成参考音频，不注册（不需要 torch）
    python 准备音色.py --force        # 参考音频已存在也重新生成
    python 准备音色.py --list         # 看看现在什么状态
    python 准备音色.py --rereg        # 换了参考音频后强制重新注册（重要）
"""
import argparse
import io
import json
import os
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES_PATH = os.path.join(HERE, 'voices.json')
REF_DIR = os.path.join(HERE, '音色参考')

# 所有角色共用同一段参考文本（只有嗓子不同）。
# 选它的理由：音节覆盖够全、语气中性、没有数字和英文 —— 读起来 6~8 秒正合适。
REF_TEXT = '大家好，今天的手气还算不错，我们慢慢玩，不用着急。'

DEFAULT_REPO = os.environ.get('COSY_REPO') or ''


def load_voices():
    with io.open(VOICES_PATH, encoding='utf-8') as f:
        return json.load(f)


def ref_path(key):
    return os.path.join(REF_DIR, key + '.wav')


def text_path(key):
    return os.path.join(REF_DIR, key + '.txt')


def ref_text_of(key):
    """该角色参考音频对应的文本。

    ⚠ 必须与音频内容**一致** —— CosyVoice 注册音色时靠它做对齐，
       对不上会明显拉低克隆质量。
       优先读 音色参考/<key>.txt（数据集挑来的、或自己录的都带这个文件），
       没有才回落到内置那句（即 edge-tts 生成时用的那句）。
    """
    p = text_path(key)
    if os.path.exists(p):
        try:
            t = io.open(p, encoding='utf-8').read().strip()
            if t:
                return t
        except Exception:
            pass
    return REF_TEXT


# ---------------------------------------------------------------- 生成参考音频


def gen_refs(VJ, force=False):
    """用 edge-tts 生成参考音频（24kHz 单声道 WAV）。"""
    try:
        import edge_tts  # noqa: F401
    except Exception:
        print('   ❌ 没装 edge-tts。装一下：pip install edge-tts')
        return False
    try:
        import soundfile as sf
    except Exception:
        print('   ❌ 没装 soundfile。装一下：pip install soundfile')
        return False
    import asyncio
    import edge_tts

    os.makedirs(REF_DIR, exist_ok=True)
    voices = VJ.get('voices') or {}
    ok = True

    for key in sorted(voices.keys()):
        cfg = voices[key] or {}
        out = ref_path(key)
        if os.path.exists(out) and not force:
            print('   ⏭ %-8s 已有参考音频，跳过（--force 可重生成）' % key)
            continue

        v = cfg.get('voice') or (VJ.get('default') or {}).get('voice') or 'zh-CN-XiaoxiaoNeural'
        rate = cfg.get('rate') or '+0%'
        pitch = cfg.get('pitch') or '+0Hz'

        async def run():
            c = edge_tts.Communicate(REF_TEXT, v, rate=rate, pitch=pitch, volume='+0%')
            buf = bytearray()
            async for ch in c.stream():
                if ch.get('type') == 'audio':
                    buf += ch['data']
            return bytes(buf)

        try:
            mp3 = asyncio.run(run())
        except Exception as e:
            print('   ❌ %-8s edge-tts 合成失败：%s' % (key, e))
            ok = False
            continue
        if not mp3:
            print('   ❌ %-8s edge-tts 没返回音频' % key)
            ok = False
            continue

        # edge-tts 只出 MP3；用 soundfile 解出来（libsndfile ≥1.1 支持 MP3 读取）
        try:
            tmp_mp3 = out + '.tmp.mp3'
            with open(tmp_mp3, 'wb') as f:
                f.write(mp3)
            data, sr = sf.read(tmp_mp3, dtype='float32', always_2d=True)
            os.remove(tmp_mp3)
            mono = data.mean(axis=1)
            sf.write(out, mono, sr, subtype='PCM_16')
            # 文本跟音频一起落盘：注册音色时要用它，而且内容必须对得上
            with io.open(text_path(key), 'w', encoding='utf-8') as f:
                f.write(REF_TEXT)
            sec = len(mono) / float(sr)
            print('   ✅ %-8s %s  %.1f 秒  %d Hz' % (key, v, sec, sr))

            # CosyVoice 的 load_wav 要求采样率 ≥16000 —— 顺手挡一下
            if sr < 16000:
                print('      ⚠ 采样率 %d 低于 16000，CosyVoice 读不了' % sr)
                ok = False
        except Exception as e:
            print('   ❌ %-8s 解码/写盘失败：%s' % (key, e))
            ok = False

    return ok


# ---------------------------------------------------------------- 注册音色


def register(VJ, force_reg=False):
    """把参考音频注册进 spk2info.pt（需要 torch + cosyvoice）。"""
    try:
        import torch  # noqa: F401
    except Exception:
        print('   ❌ 这个 Python 环境里没有 torch。')
        print('      注册这一步必须在 CosyVoice 的 conda 环境里跑，例如：')
        print('        C:\\ProgramData\\miniconda3\\envs\\cosyvoice\\python.exe 配音服务\\准备音色.py')
        return False

    cfg = VJ.get('cosy') or {}
    repo = (cfg.get('repo') or os.environ.get('COSY_REPO') or DEFAULT_REPO).rstrip('\\/')
    model_dir = (cfg.get('model_dir') or os.environ.get('COSY_MODEL') or '').rstrip('\\/')
    if not model_dir or not os.path.isdir(model_dir):
        print('   ❌ voices.json 里的 cosy.model_dir 不对：%r' % model_dir)
        return False

    for p in (repo, os.path.join(repo, 'third_party', 'Matcha-TTS')):
        if os.path.isdir(p) and p not in sys.path:
            sys.path.insert(0, p)

    try:
        from cosyvoice.cli.cosyvoice import CosyVoice2
        from cosyvoice.utils.file_utils import load_wav
    except Exception as e:
        print('   ❌ import CosyVoice 失败：%s' % e)
        return False

    fp16 = bool(cfg.get('fp16', True))
    print('   正在加载 CosyVoice 2（第一次 30~60 秒）…')
    try:
        model = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=fp16)
    except Exception as e:
        print('   ❌ 加载失败：%s' % e)
        return False

    have = set(model.list_available_spks())
    print('   当前已注册：%s' % ('、'.join(sorted(have)) if have else '（空）'))

    voices = VJ.get('voices') or {}
    done, skipped, failed = 0, 0, []
    for key in sorted(voices.keys()):
        w = ref_path(key)
        if not os.path.exists(w):
            failed.append(key + '（缺参考音频）')
            continue
        spk = (voices[key] or {}).get('spk_id') or key
        if spk in have and not force_reg:
            skipped += 1
            print('   ⏭ %-8s 已注册，跳过（要换掉它用 --rereg）' % key)
            continue
        try:
            # ⚠ 这里必须传**文件路径**，不能传 tensor。
            #   add_zero_shot_spk → frontend_zero_shot 内部有三处
            #   （_extract_speech_feat / _extract_speech_token / _extract_spk_embedding）
            #   都会自己调 load_wav(prompt_wav, sr)。传 tensor 进去，
            #   torchaudio 会把它当文件路径，报「Invalid file: tensor([...])」。
            #
            # 文本用该角色自己的（数据集挑来的音频，内容各不相同）
            txt = ref_text_of(key)
            model.add_zero_shot_spk(txt, w, spk)
            done += 1
            have.add(spk)
            print('   ✅ %-8s 已注册为音色「%s」' % (key, spk))
        except Exception as e:
            failed.append('%s（%s）' % (key, e))
            print('   ❌ %-8s 注册失败：%s' % (key, e))

    # ⚠ add_zero_shot_spk 只改内存，**必须显式落盘** —— 上游把它和 save_spkinfo() 拆成两个方法。
    #   漏了这一步，注册完一关进程就全没了。
    if done:
        try:
            model.save_spkinfo()
            print('   ✅ 音色表已落盘：%s' % os.path.join(model_dir, 'spk2info.pt'))
        except Exception as e:
            print('   ❌ 音色表落盘失败：%s' % e)
            return False

    print('')
    print('   新注册 %d 个 · 已有 %d 个' % (done, skipped))
    if failed:
        print('   ⚠ 有问题：')
        for f in failed:
            print('       · %s' % f)
    print('   音色表已写入：%s' % os.path.join(model_dir, 'spk2info.pt'))
    return not failed


# ---------------------------------------------------------------- 状态


def show_status(VJ):
    voices = VJ.get('voices') or {}
    print('')
    print('  %-9s %-9s %-9s %s' % ('角色', '参考音频', '注册名', '参考文本（必须与音频一致）'))
    print('  ' + '-' * 74)
    for key in sorted(voices.keys()):
        cfg = voices[key] or {}
        w = ref_path(key)
        if os.path.exists(w):
            try:
                with wave.open(w, 'rb') as f:
                    info = '%.1fs/%dHz' % (f.getnframes() / float(f.getframerate()), f.getframerate())
            except Exception:
                info = '有（读不了）'
        else:
            info = '❌ 缺'
        t = ref_text_of(key)
        from_file = os.path.exists(text_path(key))
        print('  %-9s %-9s %-9s %s' % (
            key, info, cfg.get('spk_id') or key,
            ('「%s」' % (t[:26] + ('…' if len(t) > 26 else '')))))
        print('  %-9s %s' % ('', '↳ 文本来源：%s' % ('音色参考/%s.txt' % key if from_file else '内置默认句（edge 生成）')))
    print('')
    print('  参考音频目录：%s' % REF_DIR)
    print('  （把这里的 .wav 换成你自己的录音，重跑本脚本，就变成你的音色了）')
    return True


# ---------------------------------------------------------------- 入口


def main():
    ap = argparse.ArgumentParser(description='给角色准备 CosyVoice 音色')
    ap.add_argument('--refs-only', action='store_true', help='只生成参考音频，不注册')
    ap.add_argument('--force', action='store_true', help='参考音频已存在也重新生成')
    ap.add_argument('--list', action='store_true', help='只看状态')
    ap.add_argument('--rereg', action='store_true',
                    help='已注册的也重新注册（换了参考音频之后必须加这个）')
    args = ap.parse_args()

    VJ = load_voices()

    print('')
    print('  🎙 角色音色准备')
    print('')

    if args.list:
        sys.exit(0 if show_status(VJ) else 1)

    print('  ── 第 1 步：参考音频 ──')
    ok_refs = gen_refs(VJ, force=args.force)
    print('')

    if args.refs_only:
        print('  （--refs-only：跳过注册）')
        show_status(VJ)
        sys.exit(0 if ok_refs else 1)

    print('  ── 第 2 步：注册进 CosyVoice 音色表 ──')
    ok_reg = register(VJ, force_reg=args.rereg)
    print('')
    show_status(VJ)
    sys.exit(0 if (ok_refs and ok_reg) else 1)


if __name__ == '__main__':
    main()
