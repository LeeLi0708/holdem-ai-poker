# 【一次性脚本，2026-10-02 已执行完】修复三个 .bat：LF+UTF-8(无BOM) → CRLF+GBK，chcp 65001 → chcp 936
# 前置条件：文件当前是 UTF-8 且含 chcp 65001（已修好的文件会直接 sys.exit，防误跑）
# 以后要动 .bat，请用「检查bat编码.py」查、别再用这个。
# 每一处替换都做唯一命中校验，任何一项不满足就整份不写盘
import os
import sys

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '配音服务')
FILES = ['启动配音服务.bat', '启动配音服务-CosyVoice.bat', '安装CosyVoice环境.bat']

NOTE = ('rem ※ 本文件必须保存为 ANSI/GBK + CRLF 行尾。cmd.exe 不认 LF 行尾，'
        '改成 UTF-8 或 LF 会让中文变乱码并报「不是内部或外部命令」。')

plan = []
for name in FILES:
    p = os.path.join(BASE, name)
    raw = open(p, 'rb').read()
    src = raw.decode('utf-8')                     # 现状是 UTF-8
    if raw[:3] == b'\xef\xbb\xbf':
        sys.exit('有 BOM，人工看一眼：' + name)
    if src.count('chcp 65001 >nul') != 1:
        sys.exit('chcp 行不是唯一命中，中止：' + name)
    if src.count('@echo off\n') != 1:
        sys.exit('@echo off 不是唯一命中，中止：' + name)
    if '\r\n' in src:
        sys.exit('已经是 CRLF，逻辑要重看：' + name)
    out = src.replace('chcp 65001 >nul', 'chcp 936 >nul')
    out = out.replace('@echo off\n', '@echo off\n' + NOTE + '\n')
    try:
        data = out.replace('\n', '\r\n').encode('gbk')
    except UnicodeEncodeError as e:
        sys.exit('有字符编不进 GBK：%s -> %r' % (name, e.object[e.start:e.end]))
    plan.append((name, p, raw, data))

for name, p, raw, data in plan:
    open(p, 'wb').write(data)
    print('%-30s %6d -> %6d bytes  CRLF+GBK ok  chcp=936' % (name, len(raw), len(data)))
print('\n全部写盘完成。')
