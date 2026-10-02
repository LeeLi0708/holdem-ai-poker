#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""并发分段下载 —— 对付「单连接被限速」。

⚠ 这个脚本是被实测逼出来的，不是设计时想到的。

同一个文件、同一个 URL，实测：
    单连接（pip / curl -o）      375 KB ~ 1.7 MB/s
    8 路并发分段                 30 MB/s   ← 快 20~80 倍

结论：瓶颈不在带宽，在**每连接的限速**。所以多开几条连接，各拉一段，再拼起来。
torch 的 wheel 有 2.4GB，单连接要等 30 分钟以上，并发只要 80 秒。

    python 并发下载.py <url> <输出路径> [-n 8]
"""
import argparse
import os
import subprocess
import sys
import time


def curl_bin():
    for c in ('curl', r'C:\Windows\System32\curl.exe'):
        if os.path.exists(c) or subprocess.run(['where', c], capture_output=True).returncode == 0:
            return c
    return None


def remote_size(curl, url):
    out = subprocess.run([curl, '-sIL', '--max-time', '30', url], capture_output=True)
    size = 0
    for line in out.stdout.decode('utf-8', 'ignore').splitlines():
        if line.lower().startswith('content-length:'):
            try:
                size = max(size, int(line.split(':')[1].strip()))
            except ValueError:
                pass
    return size


def fmt(n):
    for u in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return '%.1f %s' % (n, u)
        n /= 1024.0
    return '%.1f TB' % n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('out')
    ap.add_argument('-n', '--conn', type=int, default=8)
    ap.add_argument('-r', '--retry', type=int, default=6)
    args = ap.parse_args()

    curl = curl_bin()
    if not curl:
        print('❌ 找不到 curl')
        sys.exit(1)

    size = remote_size(curl, args.url)
    if not size:
        print('❌ 拿不到文件大小（服务器没给 Content-Length）')
        sys.exit(1)

    print('  文件大小 %s' % fmt(size))
    print('  用 %d 条连接分段拉' % args.conn)

    part_dir = args.out + '.parts'
    os.makedirs(part_dir, exist_ok=True)
    chunk = size // args.conn + 1

    procs = []
    for i in range(args.conn):
        s = i * chunk
        e = min(size - 1, s + chunk - 1)
        if s >= size:
            break
        pf = os.path.join(part_dir, 'p%02d' % i)
        # 已有且大小对得上就跳过（断点续传的粒度是「段」）
        want = e - s + 1
        if os.path.exists(pf) and os.path.getsize(pf) == want:
            continue
        cmd = [curl, '-sL', '--retry', str(args.retry), '--retry-delay', '3',
               '--retry-all-errors', '-r', '%d-%d' % (s, e), '-o', pf, args.url]
        procs.append((i, pf, want, subprocess.Popen(cmd)))

    if not procs:
        print('  所有分段都已下好')
    t0 = time.time()
    # ⚠ 进度必须按「所有分段的实际大小」算，不能只算还没跑完的那几条 ——
    #   否则每完成一段，已下的字节就从总和里掉出去，进度会往回跳（第一版就这毛病）。
    parts = [(i, os.path.join(part_dir, 'p%02d' % i), min(size - 1, i * chunk + chunk - 1) - i * chunk + 1)
             for i in range(args.conn) if i * chunk < size]
    while procs:
        time.sleep(1.0)
        done = 0
        for _, pf, want in parts:
            if os.path.exists(pf):
                done += min(want, os.path.getsize(pf))
        el = max(0.001, time.time() - t0)
        sys.stdout.write('\r        已下 %s / %s   %.1f MB/s      '
                         % (fmt(done), fmt(size), done / el / 1048576))
        sys.stdout.flush()
        procs = [t for t in procs if t[3].poll() is None]
    # 收尾再报一次真实的全部大小
    done = sum(min(want, os.path.getsize(pf)) for _, pf, want in parts if os.path.exists(pf))
    el = max(0.001, time.time() - t0)
    sys.stdout.write('\r        已下 %s / %s   %.1f MB/s      \n'
                     % (fmt(done), fmt(size), done / el / 1048576))

    # 拼装
    print('  正在拼装…')
    with open(args.out, 'wb') as out:
        for i in range(args.conn):
            pf = os.path.join(part_dir, 'p%02d' % i)
            if not os.path.exists(pf):
                continue
            with open(pf, 'rb') as f:
                while True:
                    b = f.read(8 << 20)
                    if not b:
                        break
                    out.write(b)

    got = os.path.getsize(args.out)
    el = time.time() - t0
    print('  实际大小 %s（期望 %s）· 用时 %.0f 秒 · 平均 %.1f MB/s'
          % (fmt(got), fmt(size), el, got / max(0.001, el) / 1048576))

    if got != size:
        print('  ❌ 大小对不上，别用这个文件。删掉 %s 重跑。' % part_dir)
        sys.exit(1)

    # 清理分段
    for i in range(args.conn):
        pf = os.path.join(part_dir, 'p%02d' % i)
        try:
            os.remove(pf)
        except OSError:
            pass
    try:
        os.rmdir(part_dir)
    except OSError:
        pass

    print('  ✅ 完成：%s' % args.out)


if __name__ == '__main__':
    main()
