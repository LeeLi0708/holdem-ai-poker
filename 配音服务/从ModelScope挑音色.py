#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 ModelScope 上的 AISHELL-3 按需取音色 —— **不需要下载那 19GB**。

────────────────────────────────────────────────────────────────────
为什么有这个脚本（都是实测逼出来的）
────────────────────────────────────────────────────────────────────
AISHELL-3 完整包 19GB（85 小时 / 218 人 / 正版高保真真人录音）。实测下载速度：

    OpenSLR 主站          0.2  MB/s   → 要下 24 小时
    OpenSLR EU/CN 镜像    0.12 MB/s   → 更慢
    ModelScope 单文件接口  3.0  MB/s   → 快 15 倍，**而且能只取你要的那几个文件**

三个关键发现，让「19GB」直接变成「几 MB」：

  ① `spk-info.txt`（218 人的性别/年龄/口音）就在压缩包**最前面**
     → 前 5MB 就能拿到全部元数据
  ② 目录顺序是 `test/` 在前、`train/` 在后
     → 而 test 集自己就有 214 个说话人、172 个女声，且**全部带转写**
  ③ ModelScope 的文件树接口能单独查每个说话人的文件清单和字节数
     → 44.1kHz/16bit/单声道 = 每秒 88200 字节，按大小就能算出时长

于是流程变成：查清单 → 挑一条 3~10 秒的 → 只下那一条 → 转 16kHz → 注册。

────────────────────────────────────────────────────────────────────
用法（必须在 CosyVoice 的 conda 环境里跑，因为要 librosa）
────────────────────────────────────────────────────────────────────
    # 列出所有可选女声（按年龄段分组，标出最长音频多少秒）
    ...\\envs\\cosyvoice\\python.exe 从ModelScope挑音色.py --list

    # 按内置方案取一整套（7 个角色，年龄段与角色设定对齐）
    ...\\envs\\cosyvoice\\python.exe 从ModelScope挑音色.py --auto

    # 只换其中几个：角色=说话人
    ...\\envs\\cosyvoice\\python.exe 从ModelScope挑音色.py --pick liyi=SSB0354,maiqi=SSB0702

取完之后 **必须** 跑一次 `准备音色.py --rereg`，否则音色表里还是旧的：
    ...\\envs\\cosyvoice\\python.exe 准备音色.py --rereg
"""
import argparse
import concurrent.futures as cf
import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
META_DIR = os.path.join(HERE, '音色素材', 'meta')
REF_DIR = os.path.join(HERE, '音色参考')

REPO = 'saiting/AISHELL-3'
API = 'https://www.modelscope.cn/api/v1/datasets/%s/repo' % REPO
TREE = API + '/tree?Revision=master&Root='
FILE = API + '?Revision=master&FilePath='
UA = {'User-Agent': 'Mozilla/5.0'}

BPS = 44100 * 2          # 44.1kHz / 16bit / 单声道 → 每秒字节数
SR_OUT = 16000           # CosyVoice 的硬要求：≥16000 Hz
MIN_SEC, MAX_SEC = 3.0, 10.0

# 内置方案：角色 -> 说话人。年龄段跟角色设定对齐（B=14~25 / C=26~40 / D=>41）
AUTO_PICK = [
    ('maiqi', 'SSB0702'),   # 麦琪 22 疯子型
    ('lili', 'SSB0693'),    # 莉莉 21
    ('aimi', 'SSB0671'),    # 艾米 30 精算型
    ('jiexi', 'SSB0341'),   # 杰西 28
    ('hujie', 'SSB0197'),   # 虎姐 35
    ('liyi', 'SSB0354'),    # 李姨 56 岩石型
    ('wangyi', 'SSB0737'),  # 王姨 58
]

CN = {'liyi': '李姨', 'maiqi': '麦琪', 'aimi': '艾米', 'jiexi': '杰西',
      'wangyi': '王姨', 'lili': '莉莉', 'hujie': '虎姐'}


# ------------------------------------------------------------------ 网络

def _get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_meta():
    """下 spk-info.txt / content.txt（缺了才下，都在包的靠前位置，很小）"""
    os.makedirs(META_DIR, exist_ok=True)
    want = {'spk-info.txt': 'spk-info.txt',
            'content.txt': 'test/content.txt'}
    for local, remote in want.items():
        dst = os.path.join(META_DIR, local)
        if os.path.exists(dst) and os.path.getsize(dst) > 1000:
            continue
        print('  下载元数据 %s …' % remote)
        open(dst, 'wb').write(_get(FILE + urllib.parse.quote(remote, safe='/')))

    info, text = {}, {}
    for l in io.open(os.path.join(META_DIR, 'spk-info.txt'), encoding='utf-8'):
        p = l.split()
        if len(p) >= 4 and p[0].startswith('SSB'):
            info[p[0]] = {'age': p[1], 'gender': p[2], 'accent': p[3]}
    for l in io.open(os.path.join(META_DIR, 'content.txt'), encoding='utf-8'):
        p = l.rstrip('\n').split('\t')
        if len(p) >= 2:
            fn = p[0].strip()
            t = ''.join(re.findall(r'[\u4e00-\u9fff]', p[1]))
            text[fn] = t                        # 完整文件名 → 取值转写时用
            text[fn.split('.')[0][:7]] = t       # 7 位说话人号 → --list 判有无转写时用
    return info, text


def tree(root):
    url = TREE + urllib.parse.quote(root, safe='/')
    for _ in range(3):
        try:
            d = json.loads(_get(url, 40).decode('utf-8'))
            return (d.get('Data') or {}).get('Files') or []
        except Exception:
            continue
    return None


def scan(spk):
    fs = tree('test/wav/' + spk)
    if fs is None:
        return spk, None
    rows = [(f['Path'].split('/')[-1], f['Size'])
            for f in fs if f['Path'].endswith('.wav')]
    rows.sort(key=lambda x: -x[1])
    return spk, rows


# ------------------------------------------------------------------ 挑选

def best_of(rows):
    """优先 3~10 秒里最长的那条；都没到这个区间就取全局最长。"""
    cand = [r for r in rows if MIN_SEC <= r[1] / BPS <= MAX_SEC]
    return max(cand or rows, key=lambda x: x[1])


def do_list(info, text):
    fem = [s for s in info if info[s]['gender'] == 'female' and s in text]
    print('\n  可选女声 %d 人（只列 test 集里、带转写的）\n' % len(fem))
    print('  %-9s %-4s %-8s %6s %8s' % ('说话人', '段', '口音', '条数', '最长秒'))
    print('  ' + '-' * 44)
    res = {}
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for spk, rows in ex.map(scan, sorted(fem)):
            if rows:
                res[spk] = rows
    for ag in ('A', 'B', 'C', 'D'):
        for spk in sorted(res, key=lambda s: -max(r[1] for r in res[s])):
            if info[spk]['age'] != ag:
                continue
            mx = max(r[1] for r in res[spk]) / BPS
            tag = '  ← 可用' if mx >= 3.0 and len(res[spk]) >= 3 else ''
            print('  %-9s %-4s %-8s %6d %8.2f%s'
                  % (spk, ag, info[spk]['accent'], len(res[spk]), mx, tag))
    print('\n  挑好后：--pick 角色=说话人  例如  --pick liyi=SSB0354')
    print('  段位对应角色年龄：B=14~25 · C=26~40 · D=>41\n')


# ------------------------------------------------------------------ 取用

def fetch_one(spk, name, key):
    import numpy as np
    import soundfile as sf
    import librosa

    rel = 'test/wav/%s/%s' % (spk, name)
    raw = _get(FILE + urllib.parse.quote(rel, safe='/'), timeout=180)
    tmp = os.path.join(REF_DIR, '_tmp_%s.wav' % key)
    open(tmp, 'wb').write(raw)
    try:
        y, _ = librosa.load(tmp, sr=SR_OUT, mono=True)
        y, _ = librosa.effects.trim(y, top_db=30)       # 去首尾静音
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 0:
            y = y / peak * 0.95                          # 归一化，避免削波
        sf.write(os.path.join(REF_DIR, key + '.wav'), y, SR_OUT, subtype='PCM_16')
        return len(y) / float(SR_OUT)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def do_pick(pairs, info, text):
    os.makedirs(REF_DIR, exist_ok=True)
    print('\n  %-8s %-9s %-20s %8s  %s' % ('角色', '说话人', '文件', '输出秒', '转写'))
    print('  ' + '-' * 78)
    n_ok = 0
    for key, spk in pairs:
        if spk not in info:
            print('  %-8s %-9s ❌ 说话人不存在' % (key, spk))
            continue
        r = scan(spk)
        if not r[1]:
            print('  %-8s %-9s ❌ 查不到文件' % (key, spk))
            continue
        name, size = best_of(r[1])
        sec = fetch_one(spk, name, key)
        t = text.get(name, '')
        if t:
            io.open(os.path.join(REF_DIR, key + '.txt'), 'w',
                    encoding='utf-8').write(t)
        print('  %-8s %-9s %-20s %8.2f  %s'
              % (key + ' ' + CN.get(key, ''), spk, name, sec, t or '⚠ 没有转写'))
        n_ok += 1

    print('')
    print('  完成 %d 个 → %s' % (n_ok, REF_DIR))
    print('')
    print('  ⚠ 下一步必须跑（否则音色表里还是旧的，等于白换）：')
    print('      准备音色.py --rereg')
    print('    详见 `准备音色.py --help`；换完重启配音服务即生效，页面不用刷新。')


def main():
    ap = argparse.ArgumentParser(description='从 ModelScope 上的 AISHELL-3 按需取音色')
    ap.add_argument('--list', action='store_true', help='列出可选女声')
    ap.add_argument('--auto', action='store_true', help='按内置方案取一整套（7 角色）')
    ap.add_argument('--pick', default='', help='角色=说话人，逗号分隔，如 liyi=SSB0354,maiqi=SSB0702')
    args = ap.parse_args()

    print('\n  🎙 从 ModelScope 取 AISHELL-3 真人音色')
    info, text = get_meta()
    n_line = sum(1 for k in text if k.endswith('.wav'))
    print('  元数据就绪：%d 个说话人（女声 %d）· 转写 %d 条'
          % (len(info), sum(1 for v in info.values() if v['gender'] == 'female'), n_line))

    if args.list:
        do_list(info, text)
        return
    if args.auto:
        do_pick(AUTO_PICK, info, text)
        return
    if args.pick:
        pairs = []
        for item in args.pick.split(','):
            item = item.strip()
            if not item:
                continue
            if '=' not in item:
                print('  ❌ 格式应为 角色=说话人，收到：%s' % item)
                sys.exit(1)
            k, v = item.split('=', 1)
            pairs.append((k.strip(), v.strip()))
        if not pairs:
            print('  ❌ --pick 是空的')
            sys.exit(1)
        do_pick(pairs, info, text)
        return

    ap.print_help()


if __name__ == '__main__':
    main()
