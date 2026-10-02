#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从多说话人语音数据集里挑出适合做「音色参考」的片段。

**为什么需要这个**：AISHELL-3 有 88035 条语音、218 个说话人、19GB。
你要的只是 7 段 6~10 秒的干净音频 —— 手动挑不现实。这个脚本替你挑。

挑完直接产出 CosyVoice 能用的东西：
    音色参考/<角色key>.wav    音频（16kHz 单声道，CosyVoice 要求 ≥16000Hz）
    音色参考/<角色key>.txt    该音频的**准确转写**（注册音色时要用，必须匹配！）

用法：
    # AISHELL-3（默认，女声，挑 7 个不同说话人）
    python 从数据集挑音色.py --data D:\\data_aishell3

    # 看看有哪些说话人可选，先不复制
    python 从数据集挑音色.py --data D:\\data_aishell3 --list

    # 指定时长范围、挑 10 个、只要 25~35 岁的
    python 从数据集挑音色.py --data D:\\data_aishell3 -n 10 --min 5 --max 9 --age 25-35

    # 只挑某几个说话人（挑过一次后想复现同一批）
    python 从数据集挑音色.py --data D:\\data_aishell3 --spks SSB0005,SSB0011

支持的目录结构
  ① AISHELL-3 / KeSpeech 这类「按说话人分文件夹 + 一个 label 文件」的布局（自动探测）
  ② 通用兜底：任何目录树里的 wav 都扫，文本用同名 .txt（没有就留空）

⚠️ 许可证各不相同，用之前看 `音色来源指南.md`。
   本脚本只做「挑」，不改变任何数据集的许可条款。
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REF_DIR = os.path.join(HERE, '音色参考')

# 角色 key —— 和德州扑克.html 里 PROFILES 的顺序一致，这样挑出来的音色能直接对号入座
ROLE_KEYS = ['liyi', 'maiqi', 'aimi', 'jiexi', 'wangyi', 'lili', 'hujie']
ROLE_NAMES = ['李姨', '麦琪', '艾米', '杰西', '王姨', '莉莉', '虎姐']


def log(msg=''):
    print(msg)


def sec(title):
    log('\n=== %s ===' % title)


# ---------------------------------------------------------------- 音频信息


def wav_info(path):
    """返回 (秒数, 采样率, 声道)；读不了返回 None。"""
    try:
        with wave.open(path, 'rb') as f:
            fr = f.getframerate()
            if fr <= 0:
                return None
            return f.getnframes() / float(fr), fr, f.getnchannels()
    except Exception:
        # 有些数据集是 flac/mp3，wave 打不开 —— 用 soundfile 兜一下
        try:
            import soundfile as sf
            info = sf.info(path)
            return info.duration, info.samplerate, info.channels
        except Exception:
            return None


def to_ref_wav(src, dst, target_sr=16000):
    """把音频转成 CosyVoice 能读的参考音频：单声道、指定采样率、PCM_16。

    注意：不能简单地「复制文件」—— 数据集常是 44.1kHz/立体声，
    而 CosyVoice 的 load_wav(prompt_wav, 16000) 要求采样率 ≥16000，
    立体声还会让它 mean(dim=0) 之后的形状不对。
    """
    try:
        import numpy as np
        import soundfile as sf
    except Exception:
        return False, '没装 soundfile/numpy，无法转码'
    try:
        data, sr = sf.read(src, dtype='float32', always_2d=True)
        if data.shape[1] > 1:
            data = data.mean(axis=1, keepdims=True)          # 立体声 → 单声道
        if sr != target_sr:
            # 线性插值重采样：够用，且不引入 scipy 依赖
            n_out = int(round(data.shape[0] * target_sr / float(sr)))
            idx = np.linspace(0, max(0, data.shape[0] - 1), n_out)
            i0 = np.floor(idx).astype(np.int64)
            i1 = np.minimum(i0 + 1, data.shape[0] - 1)
            frac = (idx - i0).astype(np.float32)[:, None]
            data = (data[i0] * (1 - frac) + data[i1] * frac).astype('float32')
        # 去掉首尾的静音，否则克隆出来的声音会「慢半拍」
        mono = data[:, 0]
        peak = float(np.max(np.abs(mono))) if mono.size else 0.0
        if peak > 1e-4:
            thr = peak * 0.02
            voiced = np.where(np.abs(mono) > thr)[0]
            if voiced.size > target_sr // 2:
                a = max(0, int(voiced[0]) - target_sr // 40)
                b = min(mono.shape[0], int(voiced[-1]) + target_sr // 40)
                data = data[a:b]
        sf.write(dst, data, target_sr, subtype='PCM_16')
        return True, ''
    except Exception as e:
        return False, str(e)[:120]


# ---------------------------------------------------------------- 数据源


class Item:
    __slots__ = ('path', 'spk', 'text', 'sec', 'sr', 'ch')

    def __init__(self, path, spk='', text='', sec=0.0, sr=0, ch=1):
        self.path, self.spk, self.text = path, spk, text
        self.sec, self.sr, self.ch = sec, sr, ch


def clean_text(s):
    """数据集里的转写常是「广 州 女 装」这种逐字空格分隔 —— 去掉字间空格。"""
    s = re.sub(r'\s+', ' ', s).strip()
    if not s:
        return ''
    # 全是汉字+空格 → 去空格
    if re.fullmatch(r'[\u4e00-\u9fff ]+', s):
        return s.replace(' ', '')
    # 混合的：只把汉字之间的空格去掉
    return re.sub(r'(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])', '', s)


def find_label_file(root):
    """找一个像是「id → 文本」的 label 文件。

    ⚠ AISHELL-3 的转写文件叫  /  —— **没有扩展名**。
      第一版按「必须 .txt/.lab/.tsv 结尾」去筛，结果一条都找不到（自检逮到的）。
      所以这里只按文件名关键词匹配，不限制扩展名。
    """
    cands = []
    for dp, _, fns in os.walk(root):
        for fn in fns:
            low = fn.lower()
            if low.endswith(('.wav', '.flac', '.mp3', '.pt', '.bin', '.json')):
                continue
            if any(k in low for k in ('label', 'content', 'transcript', 'prosody')):
                p = os.path.join(dp, fn)
                # label 文件不会太大；顺手挡掉误匹配到的大文件
                try:
                    if os.path.getsize(p) > 80 * 1024 * 1024:
                        continue
                except OSError:
                    continue
                cands.append(p)
    return cands


def find_spk_info(root):
    """找说话人属性表（性别/年龄/口音）。"""
    for dp, _, fns in os.walk(root):
        for fn in fns:
            if 'spk' in fn.lower() and fn.lower().endswith(('.txt', '.tsv')):
                return os.path.join(dp, fn)
    return None


def parse_labels(paths):
    """返回 {utt_id: text}。兼容 AISHELL 的「SSB00050001 广 州」和 tsv 两种。"""
    table = {}
    for p in paths:
        try:
            with io.open(p, encoding='utf-8', errors='ignore') as f:
                for line in f:
                    line = line.rstrip('\n')
                    if not line or line.startswith('#'):
                        continue
                    parts = line.split('\t') if '\t' in line else line.split(' ', 1)
                    if len(parts) < 2:
                        continue
                    uid = parts[0].strip()
                    txt = clean_text(parts[-1])
                    if uid and txt and uid not in table:
                        table[uid] = txt
        except Exception:
            continue
    return table


def parse_spk_info(path):
    """返回 {spk_id: {'gender': '女'/'男', 'age': int, 'accent': str}}。"""
    out = {}
    if not path or not os.path.exists(path):
        return out
    try:
        with io.open(path, encoding='utf-8', errors='ignore') as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) < 2:
                    continue
                sid = parts[0]
                rec = {}
                for tok in parts[1:]:
                    if tok in ('女', '男', 'female', 'male', 'F', 'M'):
                        rec['gender'] = '女' if tok in ('女', 'female', 'F') else '男'
                    elif re.fullmatch(r'\d{1,2}', tok):
                        rec['age'] = int(tok)
                    elif re.fullmatch(r'[A-Z]', tok):
                        rec['level'] = tok
                    elif re.fullmatch(r'[\u4e00-\u9fff]{2,6}', tok):
                        rec.setdefault('accent', tok)
                if rec:
                    out[sid] = rec
    except Exception:
        pass
    return out


def scan(root, verbose=True):
    """扫出所有候选片段。"""
    labels = parse_labels(find_label_file(root))
    spk_info = parse_spk_info(find_spk_info(root))
    if verbose:
        log('  转写条目 %d 条' % len(labels))
        log('  说话人属性 %d 人' % len(spk_info))
        if not labels:
            log('  ⚠ 没找到转写文件 —— 挑出来的音频会缺 prompt_text，克隆质量会打折。')
            log('    （CosyVoice 注册音色时要求 prompt_text 与音频内容匹配）')

    items = []
    for dp, _, fns in os.walk(root):
        for fn in sorted(fns):
            if not fn.lower().endswith(('.wav', '.flac', '.mp3')):
                continue
            p = os.path.join(dp, fn)
            stem = os.path.splitext(fn)[0]
            # 说话人：优先按目录名（AISHELL 是 SSB0005/0001.wav），再退回文件名前缀
            spk = os.path.basename(dp)
            if not re.fullmatch(r'[A-Za-z]{2,4}\d{3,6}', spk):
                m = re.match(r'([A-Za-z]{2,4}\d{3,6})', stem)
                spk = m.group(1) if m else spk
            info = wav_info(p)
            if not info:
                continue
            sec_, sr, ch = info
            items.append(Item(p, spk, labels.get(stem, ''), sec_, sr, ch))
    if verbose:
        log('  扫到 %d 个音频文件' % len(items))
    return items, spk_info, labels


# ---------------------------------------------------------------- 挑选


def pick(items, spk_info, args):
    """按条件挑片段：每个说话人最多取 1 条，保证音色不重复。"""
    by_spk = {}
    for it in items:
        if it.sec < args.min or it.sec > args.max:
            continue
        if args.need_text and not it.text:
            continue
        info = spk_info.get(it.spk) or {}
        if args.gender and info.get('gender') and info['gender'] != args.gender:
            continue
        if args.gender and not info.get('gender') and args.gender_required:
            continue
        if args.age:
            lo, hi = args.age
            age = info.get('age')
            if age is None or not (lo <= age <= hi):
                continue
        # 每个说话人留「最接近理想时长」的那条
        cur = by_spk.get(it.spk)
        ideal = (args.min + args.max) / 2.0
        if cur is None or abs(it.sec - ideal) < abs(cur.sec - ideal):
            by_spk[it.spk] = it
    # 按「文本长度是否合适」排序：太短（<8 字）不够，太长（>40 字）也没必要
    cands = list(by_spk.values())

    def score(it):
        n = len(it.text)
        pen = 0 if 8 <= n <= 40 else (8 - n) * 2 if n < 8 else (n - 40)
        return (pen, abs(it.sec - (args.min + args.max) / 2.0))

    cands.sort(key=score)
    if args.spks:
        want = set(x.strip() for x in args.spks.split(',') if x.strip())
        cands = [c for c in cands if c.spk in want]
    return cands


# ---------------------------------------------------------------- 输出


def write_refs(chosen, overwrite=False):
    os.makedirs(REF_DIR, exist_ok=True)
    # 认领：按角色顺序分配，一个说话人只给一个角色
    used = set()
    rows = []
    for idx, it in enumerate(chosen):
        role = ROLE_KEYS[idx] if idx < len(ROLE_KEYS) else 'extra%d' % (idx - len(ROLE_KEYS) + 1)
        if it.spk in used:
            continue
        used.add(it.spk)
        wav_dst = os.path.join(REF_DIR, role + '.wav')
        txt_dst = os.path.join(REF_DIR, role + '.txt')
        if os.path.exists(wav_dst) and not overwrite:
            rows.append((role, it.spk, it.sec, '已存在，跳过（--force 覆盖）', ''))
            continue
        okk, err = to_ref_wav(it.path, wav_dst)
        if not okk:
            rows.append((role, it.spk, it.sec, '转码失败：%s' % err, ''))
            continue
        # 文本必须跟音频一起写下来 —— 注册音色时要用，不匹配会明显拉低克隆质量
        with io.open(txt_dst, 'w', encoding='utf-8') as f:
            f.write(it.text or '')
        with io.open(os.path.join(REF_DIR, role + '.json'), 'w', encoding='utf-8') as f:
            json.dump({'role': role, 'role_name': ROLE_NAMES[ROLE_KEYS.index(role)]
                       if role in ROLE_KEYS else role,
                       'source_spk': it.spk, 'source_file': it.path,
                       'source_sec': round(it.sec, 2), 'source_sr': it.sr,
                       'text': it.text}, f, ensure_ascii=False, indent=2)
        rows.append((role, it.spk, it.sec, '✅', it.text))
    return rows


# ---------------------------------------------------------------- 入口


def main():
    ap = argparse.ArgumentParser(description='从多说话人语音数据集里挑音色参考音频')
    ap.add_argument('--data', required=True, help='数据集根目录')
    ap.add_argument('-n', '--num', type=int, default=7, help='挑几个（默认 7，对应 7 个角色）')
    ap.add_argument('--min', type=float, default=6.0, help='最小时长（秒），默认 6')
    ap.add_argument('--max', type=float, default=10.0, help='最大时长（秒），默认 10')
    ap.add_argument('--gender', default='女', choices=['女', '男', 'any'], help='只要哪个性别')
    ap.add_argument('--gender-required', action='store_true',
                    help='属性表里没标性别的说话人一律排除（默认保留）')
    ap.add_argument('--age', default='', help='年龄范围，如 25-35')
    ap.add_argument('--spks', default='', help='只挑这几个说话人，逗号分隔')
    ap.add_argument('--need-text', action='store_true',
                    help='只挑有转写文本的片段（推荐开 —— 没有文本克隆质量会打折）')
    ap.add_argument('--list', action='store_true', help='只列出候选，不写文件')
    ap.add_argument('--force', action='store_true', help='覆盖已存在的参考音频')
    args = ap.parse_args()

    if not os.path.isdir(args.data):
        log('❌ 数据集目录不存在：%s' % args.data)
        sys.exit(1)
    if args.age:
        m = re.fullmatch(r'(\d+)\s*-\s*(\d+)', args.age)
        if not m:
            log('❌ --age 要写成「25-35」这样')
            sys.exit(1)
        args.age = (int(m.group(1)), int(m.group(2)))
    if args.gender == 'any':
        args.gender = ''

    log('')
    log('  🎚 从数据集挑音色')
    log('     数据 %s' % args.data)
    log('     条件 %s · %.0f~%.0f 秒 · 每说话人取 1 条' % (
        args.gender or '不限性别', args.min, args.max))

    sec('扫描')
    items, spk_info, _ = scan(args.data)

    sec('挑选')
    cands = pick(items, spk_info, args)
    log('  符合条件的有 %d 个说话人' % len(cands))

    if not cands:
        log('')
        log('  ❌ 一条都没挑出来。可以试试放宽条件：')
        log('       --min 4 --max 14        （放宽时长）')
        log('       --gender any            （不限性别）')
        log('       去掉 --need-text         （允许没有转写的片段）')
        log('       先跑 --list 看看数据里到底有什么')
        sys.exit(1)

    log('')
    log('  %-4s %-10s %6s  %s' % ('#', '说话人', '时长', '转写（截断）'))
    log('  ' + '-' * 66)
    for i, it in enumerate(cands[:max(args.num, 12)], 1):
        info = spk_info.get(it.spk) or {}
        tag = '/'.join(x for x in (info.get('gender'), str(info.get('age')) if info.get('age') else '') if x)
        log('  %-4d %-10s %5.1fs  %s %s' % (
            i, it.spk, it.sec, (it.text or '（无转写）')[:22], ('[%s]' % tag) if tag else ''))

    if args.list:
        log('')
        log('  （--list：只看不写）')
        sys.exit(0)

    sec('写入参考音频')
    rows = write_refs(cands[:args.num], overwrite=args.force)
    log('  %-8s %-10s %7s  %-8s %s' % ('角色', '来源说话人', '时长', '状态', '转写'))
    log('  ' + '-' * 70)
    for role, spk, s, st, txt in rows:
        log('  %-8s %-10s %6.1fs  %-8s %s' % (role, spk, s, st, (txt or '')[:20]))

    good = sum(1 for r in rows if r[3] == '✅')
    log('')
    log('  写入 %d 条到：%s' % (good, REF_DIR))
    if good:
        log('')
        log('  下一步 —— 把它们注册成 CosyVoice 音色：')
        log('      "%s" 准备音色.py --refs-only-skip' % sys.executable)
        log('  然后重启配音服务，点面板里的 ▶ 试听。')
    log('')
    log('  ⚠ 别忘了看「音色来源指南.md」里的许可证说明。')


if __name__ == '__main__':
    main()
