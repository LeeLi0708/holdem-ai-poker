#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""下载 CosyVoice2-0.5B 模型权重（~3.8GB）。

只下推理真正用到的文件，跳过 TensorRT / batch 变体（省 1.5GB）。

⚠ 为什么不用 `modelscope` SDK 的 snapshot_download：
   本机没装 git-lfs，而 ModelScope 的大文件走 LFS 重定向到 CDN。
   这里直接用官方文件接口 + 跟随重定向，实测 16 MB/s，还支持断点续传。

    python 配音服务/下载模型.py
    python 配音服务/下载模型.py --dir D:\\models\\CosyVoice2-0.5B
    python 配音服务/下载模型.py --check          # 只体检，不下载
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

REPO = 'iic/CosyVoice2-0.5B'
REV = 'master'
API = 'https://www.modelscope.cn/api/v1/models/%s/repo' % REPO
LIST_API = 'https://www.modelscope.cn/api/v1/models/%s/repo/files?Revision=%s&Recursive=True' % (REPO, REV)

DEFAULT_DIR = os.environ.get('COSY_MODEL') or ''

# 推理必需。没列在这里的一律不下。
#   flow.cache.pt                  —— 只有 use_flow_cache=True 才用，省 450MB
#   flow.decoder.estimator.fp32.onnx —— TensorRT 加速用，省 286MB
#   flow.encoder.fp32/fp16.zip     —— TensorRT 加速用，省 309MB
#   speech_tokenizer_v2.batch.onnx —— 批量推理用，省 496MB
KEEP = [
    'cosyvoice2.yaml',
    'llm.pt',
    'flow.pt',
    'hift.pt',
    'campplus.onnx',
    'speech_tokenizer_v2.onnx',
]


def is_need(path):
    if path.startswith('CosyVoice-BlankEN/'):
        return path.endswith(('.json', '.txt', '.safetensors'))
    return path in KEEP


def curl_bin():
    # curl 在 Windows 10+ 是系统自带（curl.exe）；Git Bash 里也有
    for c in ('curl', r'C:\Windows\System32\curl.exe'):
        p = shutil.which(c) or (c if os.path.exists(c) else None)
        if p:
            return p
    return None


def fetch_list():
    out = subprocess.run([curl_bin(), '-sL', '--max-time', '40', LIST_API],
                         capture_output=True)
    try:
        d = json.loads(out.stdout.decode('utf-8'))
        return [f for f in d['Data']['Files'] if f.get('Type') == 'blob']
    except Exception as e:
        print('❌ 取不到文件清单：%s' % e)
        print(out.stdout[:300])
        sys.exit(1)


def fmt(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return '%.1f %s' % (n, u)
        n /= 1024.0
    return '%.1f TB' % n


def download(curl, path, dest, size):
    url = '%s?Revision=%s&FilePath=%s' % (API, REV, path)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + '.part'

    # 断点续传：已经有 part 就从它的长度接着下
    have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    if have > size:
        have = 0
        try:
            os.remove(tmp)
        except OSError:
            pass

    cmd = [curl, '-L', '--fail', '--retry', '6', '--retry-delay', '3',
           '--retry-all-errors', '-C', '-', '-o', tmp]
    if not sys.stdout.isatty():
        cmd += ['-s']
    cmd.append(url)

    t0 = time.time()
    p = subprocess.Popen(cmd)
    # 进度：轮询 part 大小（比解析 curl 进度条可靠）
    try:
        while p.poll() is None:
            time.sleep(1.0)
            now = os.path.getsize(tmp) if os.path.exists(tmp) else have
            if size and sys.stdout.isatty():
                pct = 100.0 * now / size
                el = max(0.001, time.time() - t0)
                sp = (now - have) / el
                sys.stdout.write('\r        %5.1f%%  %s / %s  %s/s      '
                                 % (pct, fmt(now), fmt(size), fmt(sp)))
                sys.stdout.flush()
    except KeyboardInterrupt:
        p.kill()
        print('\n  已中断。下次运行会从断点继续。')
        sys.exit(130)

    rc = p.wait()
    if rc != 0 or not os.path.exists(tmp):
        return False, 0

    real = os.path.getsize(tmp)
    if size and real != size:
        print('\r        ⚠ 大小对不上：拿到 %s，应该是 %s（会保留 .part，下次续传）' % (fmt(real), fmt(size)))
        return False, real

    os.replace(tmp, dest)
    return True, real


def human_check(d):
    """体检：必需文件是否都在、大小是否对。"""
    need = {
        'cosyvoice2.yaml': 7330,
        'llm.pt': 2023316821,
        'flow.pt': 450575567,
        'hift.pt': 83390254,
        'campplus.onnx': 28303423,
        'speech_tokenizer_v2.onnx': 496082973,
        'CosyVoice-BlankEN/model.safetensors': 988097824,
    }
    print('\n=== 模型体检 ===')
    good = 0
    for k, want in need.items():
        p = os.path.join(d, k)
        if not os.path.exists(p):
            print('   ❌ 缺 %s' % k)
        elif os.path.getsize(p) != want:
            print('   ⚠ %s 大小不对：%s（应 %s）' % (k, fmt(os.path.getsize(p)), fmt(want)))
        else:
            print('   ✅ %s  %s' % (k.ljust(38), fmt(want)))
            good += 1
    print('   —— %d / %d 就位' % (good, len(need)))
    return good == len(need)


def main():
    ap = argparse.ArgumentParser(description='下载 CosyVoice2-0.5B 权重')
    ap.add_argument('--dir', default=DEFAULT_DIR, help='模型存放目录')
    ap.add_argument('--check', action='store_true', help='只体检，不下载')
    args = ap.parse_args()
    d = args.dir

    if args.check:
        sys.exit(0 if human_check(d) else 1)

    curl = curl_bin()
    if not curl:
        print('❌ 找不到 curl。Windows 10 以上自带，或装一个 Git for Windows。')
        sys.exit(1)

    print('')
    print('  📦 CosyVoice2-0.5B 模型下载')
    print('     目标目录  %s' % d)
    print('     只下推理必需件，跳过 TensorRT / batch 变体（省 1.5GB）')
    print('')

    files = fetch_list()
    todo = [f for f in files if is_need(f['Path'])]
    todo.sort(key=lambda f: f.get('Size') or 0)          # 先小后大：小文件先到位，能早点发现问题

    total = sum(f.get('Size') or 0 for f in todo)
    print('     要下 %d 个文件，合计 %s' % (len(todo), fmt(total)))
    print('')

    done_bytes = 0
    failed = []
    t_all = time.time()
    for i, f in enumerate(todo, 1):
        path, size = f['Path'], f.get('Size') or 0
        dest = os.path.join(d, path.replace('/', os.sep))

        if os.path.exists(dest) and size and os.path.getsize(dest) == size:
            print('   [%d/%d] ✅ 已存在，跳过  %s' % (i, len(todo), path))
            done_bytes += size
            continue

        print('   [%d/%d] ⬇ %s  (%s)' % (i, len(todo), path, fmt(size)))
        okk, got = download(curl, path, dest, size)
        if okk:
            done_bytes += got
            print('\r        ✅ 完成  %s                              ' % fmt(got))
        else:
            failed.append(path)
            print('\r        ❌ 失败  %s                              ' % path)

    el = time.time() - t_all
    print('')
    print('  ' + '=' * 46)
    print('   下载结束：%s / %s，用时 %d 分 %d 秒' % (fmt(done_bytes), fmt(total), el // 60, el % 60))
    if failed:
        print('   ⚠ 以下文件失败（重跑本脚本会自动续传）：')
        for f in failed:
            print('       · %s' % f)
    print('  ' + '=' * 46)

    allok = human_check(d)
    sys.exit(0 if allok and not failed else 1)


if __name__ == '__main__':
    main()
