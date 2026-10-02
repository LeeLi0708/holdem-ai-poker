# 守门脚本：一秒查出 .bat 被存成了 UTF-8 / LF（cmd.exe 只认 GBK + CRLF）
# 用法：python 检查bat编码.py [目录]     退出码 0 = 干净，1 = 有问题
import os
import sys

if len(sys.argv) > 1:
    BASE = os.path.abspath(sys.argv[1])
else:
    BASE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '配音服务'))

problems = []
files = [f for f in sorted(os.listdir(BASE)) if f.lower().endswith(('.bat', '.cmd'))]
if not files:
    print('没有找到 .bat，检查一下路径：' + BASE)
    sys.exit(1)

for name in files:
    p = os.path.join(BASE, name)
    raw = open(p, 'rb').read()
    bad = []
    if raw[:3] == b'\xef\xbb\xbf':
        bad.append('有 UTF-8 BOM（cmd 会把 BOM 当命令名）')
    crlf = raw.count(b'\r\n')
    bare = raw.count(b'\n') - crlf
    if bare:
        bad.append('有 %d 处裸 LF 行尾（必须全是 CRLF）' % bare)
    try:
        txt = raw.decode('gbk')
    except UnicodeDecodeError as e:
        bad.append('不是 GBK，按 GBK 解不出来（%s）' % e)
        txt = raw.decode('gbk', 'replace')
    if 'chcp 65001' in txt:
        bad.append('里面写了 chcp 65001（GBK 文件应该用 chcp 936）')
    if not bad:
        print('  [OK]   %s  GBK/CRLF 正常（%d 行）' % (name, crlf))
    else:
        print('  [BAD]  %s' % name)
        for b in bad:
            print('         - ' + b)
        problems.append(name)

print()
if problems:
    print('有问题的文件：' + '、'.join(problems))
    print('修法：用 Python 按 GBK + CRLF 重写，或跑 测试/修bat编码.py（先看它的注释）')
    sys.exit(1)
print('全部正常。')
