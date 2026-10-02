#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice 2 的 Windows 适配补丁。

上游 CosyVoice 是照着 Linux + conda 写的。在 Windows 上跑推理，有两处必须改，
另外顺手确认几件事。**本脚本是幂等的**，重复跑不会叠加。

    python 配音服务/补丁-CosyVoice-Windows.py [--repo 路径]

改动都做了唯一命中校验：命中数不对就整份不写盘 —— 免得在别人的代码里乱改。

补丁清单
  1. third_party/Matcha-TTS/matcha/utils/pylogger.py
     它 import lightning 只是为了一个 rank_zero_only（多卡日志去重）。
     单进程推理根本用不上，而 lightning 会拖进整套 torchmetrics。
     → 包一层 try/except，装了就照用，没装就退化成恒等装饰器。
     （@ 省掉约 150MB 依赖）

  2. cosyvoice/cli/frontend.py
     这行只要 torch 看得到 GPU 就去要 CUDAExecutionProvider：
         providers=["CUDAExecutionProvider" if torch.cuda.is_available() else "CPUExecutionProvider"]
     但 pip 装的 onnxruntime 是 CPU 版，根本没有这个 provider → 直接抛异常。
     （onnxruntime-gpu 在 Windows 上要求 CUDA/cuDNN 版本严丝合缝，很容易踩坑。）
     → 改成按 onnxruntime.get_available_providers() 过滤。

另外两处**不需要改**（已核实，仅作记录）
  · cli/frontend.py 的文本前端本身就是三级降级：ttsfrd → wetext → 空。
    两样都没装时 text_frontend=''，只跳过数字/日期正则化，基础清洗照做。
    **所以不需要 pynini / WeTextProcessing**（那正是 Windows 上最难装的一环）。
    扑克台词（「这把我加注」）不含数字日期，跳过正则化毫无影响。
  · vllm / tensorrt / deepspeed / pyworld 全是函数内延迟导入，且在训练或加速路径上，
    Windows 推理用不到，不装即可。
"""
import argparse
import io
import os
import sys

DEFAULT_REPO = os.environ.get('COSY_REPO') or ''


def apply(path, tag, old, new):
    if not os.path.exists(path):
        print('   ❌ 找不到 %s' % path)
        return False
    s = io.open(path, encoding='utf-8').read()
    if new in s:
        print('   ⏭ %s 已打过，跳过' % tag)
        return True
    n = s.count(old)
    if n != 1:
        print('   ❌ %s 命中 %d 次（期望 1），不写盘' % (tag, n))
        return False
    io.open(path, 'w', encoding='utf-8').write(s.replace(old, new, 1))
    print('   ✅ %s 已打' % tag)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=DEFAULT_REPO, help='CosyVoice 源码根目录')
    args = ap.parse_args()
    R = args.repo

    if not os.path.isdir(R):
        print('❌ 源码目录不存在：%s' % R)
        sys.exit(1)

    print('')
    print('  🔧 CosyVoice 2 Windows 适配补丁')
    print('     源码 %s' % R)
    print('')

    ok = True

    # ---------- 1. Matcha-TTS 的 lightning 依赖 ----------
    p1 = os.path.join(R, 'third_party', 'Matcha-TTS', 'matcha', 'utils', 'pylogger.py')
    ok &= apply(
        p1, 'Matcha-TTS pylogger 去掉 lightning 硬依赖',
        'from lightning.pytorch.utilities import rank_zero_only',
        """try:
    from lightning.pytorch.utilities import rank_zero_only
except ImportError:
    # 单进程推理用不上多卡 rank 机制，省掉一整套 lightning + torchmetrics
    def rank_zero_only(fn):
        return fn""")

    # ---------- 2. onnxruntime 的 CUDA provider ----------
    p2 = os.path.join(R, 'cosyvoice', 'cli', 'frontend.py')
    ok &= apply(
        p2, 'onnxruntime provider 按实际可用过滤',
        """        self.speech_tokenizer_session = onnxruntime.InferenceSession(speech_tokenizer_model, sess_options=option,
                                                                     providers=["CUDAExecutionProvider" if torch.cuda.is_available() else
                                                                                "CPUExecutionProvider"])""",
        """        # ⚠ Windows 修正：pip 装的是 onnxruntime（CPU 版）时并没有 CUDAExecutionProvider，
        #   而上游这行只要 torch 看得到 GPU 就会去要 CUDA provider → 直接抛异常。
        #   改成按「运行时真实可用的 provider」挑，装了 onnxruntime-gpu 就自动用 GPU，没装就老实走 CPU。
        _avail = onnxruntime.get_available_providers()
        _want = ["CUDAExecutionProvider", "CPUExecutionProvider"] if torch.cuda.is_available() else ["CPUExecutionProvider"]
        _prov = [p for p in _want if p in _avail] or ["CPUExecutionProvider"]
        if torch.cuda.is_available() and "CUDAExecutionProvider" not in _avail:
            logging.warning('torch 看得到 GPU，但 onnxruntime 不支持 CUDA（装的是 CPU 版）'
                            '—— 语音 tokenizer 走 CPU。想要更快：pip install onnxruntime-gpu')
        self.speech_tokenizer_session = onnxruntime.InferenceSession(speech_tokenizer_model, sess_options=option,
                                                                     providers=_prov)""")

    print('')
    if ok:
        print('  ✅ 补丁完成（可重复运行）')
    else:
        print('  ⚠ 有补丁没打上，看上面的报错')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
