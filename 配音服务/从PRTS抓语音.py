# -*- coding: utf-8 -*-
"""从 PRTS wiki 抓取指定角色的中文语音，量时长筛候选。

按角色内部 ID 工作，换谁都能用 —— ID 从 PRTS 语音记录页上的音频链接里直接读。

    python 从PRTS抓语音.py --id <角色ID> --dir <输出目录名>
    python 从PRTS抓语音.py --id <角色ID> --dir <输出目录名> --reportonly

⚠ 抓到的音频是否可用于你的用途，请自行确认授权。

⚠⚠ 别被文件名骗了：`voice/` 与 `voice_cn/` 都返回 HTTP 200、文件都叫 cn_001.wav，
   但 `voice/` 是国服**默认配音 = 日语**，`voice_cn/` 才是中文。这里只走 voice_cn。

⚠ 用途：本地自用。语音著作权属鹰角网络，别对外分发。
"""
import io
import os
import sys
import wave
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
REFERER = 'https://prts.wiki/'
BASE = 'https://torappu.prts.wiki/assets/audio/voice_cn/{cid}/cn_{n:03d}.wav'
NUMS = list(range(1, 71))          # 扫 001~070（含皮肤/活动语音）
LO, HI = 3.0, 10.0                 # CosyVoice zero-shot 参考音频的理想区间


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def fetch(cid, n):
    req = urllib.request.Request(BASE.format(cid=cid, n=n),
                                 headers={'User-Agent': UA, 'Referer': REFERER})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def probe(path):
    size = os.path.getsize(path)
    try:
        with wave.open(path, 'rb') as w:
            return (w.getnframes() / float(w.getframerate()),
                    w.getframerate(), w.getnchannels(), w.getsampwidth() * 8, size)
    except Exception as e:
        return ('ERR:%s' % e, 0, 0, 0, size)


def main():
    cid = arg('--id')
    dirname = arg('--dir')
    if not cid or not dirname:
        print('用法：--id <干员内部ID> --dir <输出子目录名> [--reportonly]')
        sys.exit(2)

    out = os.path.join(HERE, '音色素材', dirname)
    os.makedirs(out, exist_ok=True)
    reportonly = '--reportonly' in sys.argv

    print('')
    print('  🎙 抓取：%s' % cid)
    print('  输出：%s' % out)
    print('')

    have = {n for n in NUMS if os.path.exists(os.path.join(out, 'cn_%03d.wav' % n))}
    todo = [n for n in NUMS if n not in have]

    if not reportonly and todo:
        print('  探测/下载 %d 个编号（已有 %d）…' % (len(todo), len(have)))
        got, miss = [], []
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(fetch, cid, n): n for n in todo}
            for f in futs:
                n = futs[f]
                try:
                    data = f.result()
                    if len(data) < 1000:
                        miss.append(n)
                        continue
                    with open(os.path.join(out, 'cn_%03d.wav' % n), 'wb') as fh:
                        fh.write(data)
                    got.append(n)
                except urllib.error.HTTPError:
                    miss.append(n)
                except Exception:
                    miss.append(n)
        print('  下载成功 %d 个：%s' % (len(got), ' '.join('%03d' % n for n in sorted(got))))
        print('  不存在   %d 个' % len(miss))
        print('')

    rows, cands = [], []
    for n in NUMS:
        p = os.path.join(out, 'cn_%03d.wav' % n)
        if not os.path.exists(p):
            continue
        sec, sr, ch, bits, size = probe(p)
        if isinstance(sec, str):
            rows.append((n, None, sec))
            continue
        rows.append((n, (sec, sr, ch, bits, size), None))
        if LO <= sec <= HI:
            cands.append((n, sec))

    print('  %-6s %8s %8s %6s %5s %9s  %s' % ('编号', '时长', '采样率', '声道', '位深', '字节', '判定'))
    print('  ' + '-' * 70)
    for n, r, err in rows:
        if err:
            print('  cn_%03d %s' % (n, err))
        else:
            sec, sr, ch, bits, size = r
            mark = '⭐ 候选' if LO <= sec <= HI else ('太短' if sec < LO else '太长')
            print('  cn_%03d %7.2fs %8d %6d %4dbit %9d  %s' % (n, sec, sr, ch, bits, size, mark))

    print('')
    print('  候选（%.0f~%.0f 秒）共 %d 条：' % (LO, HI, len(cands)))
    for n, sec in cands:
        print('     cn_%03d  %.2fs' % (n, sec))
    print('')


if __name__ == '__main__':
    main()
