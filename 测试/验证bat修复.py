# 验证修复后的三个 .bat：静态 + 用真实 cmd 跑副本 + 真实启动一次
# 口径说明：
#  · 三个 bat 内部都 chcp 936，所以批处理 echo 出去的字节是 GBK —— 一律按 GBK 解码；
#  · Python 子进程的输出编码不等于控制台编码，所以中文传参用 ascii() 打，纯 ASCII 才可比；
#  · 副本里只改「set 变量」和「pause」，命令行一个字不动，保证测的还是原结构。
import os
import re
import shutil
import subprocess
import sys

WS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(WS, '配音服务')
TMP = os.path.join(WS, '测试', '_batcheck')
STUB = os.path.join(TMP, 'stub')
PYEXE = sys.executable
ARG_TARGET = '准备音色.py'
ARG_ASCII = ascii(ARG_TARGET)

PASS = []
FAIL = []


def check(ok, msg):
    (PASS if ok else FAIL).append(msg)
    print(('  [OK]   ' if ok else '  [FAIL] ') + msg)


def errs(txt):
    return (txt.count('不是内部或外部命令') + txt.count('is not recognized')
            + txt.count('文件名、目录名') + txt.count('系统找不到')
            + txt.count('命令语法不正确') + txt.count('is not recognized as an internal'))


def run_copy(name, patches, console_cp, extra_path=None, timeout=120, regex_patches=None):
    src = open(os.path.join(BASE, name), 'rb').read().decode('gbk')
    for pat, rep in (regex_patches or []):
        src, n = re.subn(pat, rep, src)
        if n == 0:
            raise SystemExit('正则补丁没命中：%r in %s' % (pat, name))
        print('    正则补丁命中 %d 处：%s' % (n, pat))
    for old, new in patches:
        n = src.count(old)
        if n == 0:
            raise SystemExit('补丁没命中：%r in %s' % (old, name))
        src = src.replace(old, new)
    lines = src.split('\r\n')
    hits = [i for i, l in enumerate(lines) if l.strip() in ('pause', 'pause >nul')]
    if not hits:
        raise SystemExit('副本里没找到单独成行的 pause：' + name)
    for i in hits:
        lines[i] = 'rem ' + lines[i]
    cp = os.path.join(TMP, '_run_' + name)
    open(cp, 'wb').write('\r\n'.join(lines).encode('gbk'))
    env = dict(os.environ)
    env['PATH'] = os.pathsep.join([STUB] + [p for p in (extra_path,) if p] + [env['PATH']])
    r = subprocess.run('chcp %d >nul && "%s"' % (console_cp, cp), shell=True,
                       capture_output=True, env=env, timeout=timeout)
    return (r.stdout + r.stderr).decode('gbk', 'replace')


# ---------------------------------------------------------------- 准备桩
os.makedirs(STUB, exist_ok=True)
STUB_BAT = b'@echo off\r\necho    [stub] %*\r\nexit /b 0\r\n'
open(os.path.join(STUB, 'stub.bat'), 'wb').write(STUB_BAT)
open(os.path.join(STUB, 'git.bat'), 'wb').write(STUB_BAT)
print('桩: stub.bat / git.bat（回显参数，exit /b 0），调用处会被加上 call 才拿得回控制权')

# ---------------------------------------------------------------- 1. 静态
print('\n== 1. 静态检查（BOM / 行尾 / 编码）==')
for name in sorted(os.listdir(BASE)):
    if not name.endswith('.bat'):
        continue
    raw = open(os.path.join(BASE, name), 'rb').read()
    crlf = raw.count(b'\r\n')
    lf = raw.count(b'\n') - crlf
    check(raw[:3] != b'\xef\xbb\xbf', '%s：无 BOM' % name)
    check(lf == 0, '%s：全部 CRLF（裸 LF=%d）' % (name, lf))
    try:
        txt = raw.decode('gbk')
    except UnicodeDecodeError as e:
        check(False, '%s：GBK 解码失败 %s' % (name, e))
        continue
    check(True, '%s：可按 GBK 解码' % name)
    check('chcp 65001' not in txt, '%s：不再有 chcp 65001' % name)
    check(txt.count('chcp 936 >nul') == 1, '%s：有且仅有一处 chcp 936' % name)

PYDIR = os.path.dirname(PYEXE)

# ---------------------------------------------------------------- 2a
print('\n== 2a. 启动配音服务-CosyVoice.bat：真跑（只换掉最后启动服务那行）==')
BANNER = ['配音服务 —— CosyVoice 2 本地 GPU', '这个窗口别关', 'Ctrl+C 停掉', '服务已退出']
for cp in (936, 65001):
    txt = run_copy('启动配音服务-CosyVoice.bat',
                   [('"%ENV_PY%" server.py --backend cosy --port 9880',
                     '"%ENV_PY%" -c "import sys;print(\'ARG\', ascii(sys.argv[1]))" ' + ARG_TARGET)],
                   cp)
    n = errs(txt)
    check(n == 0, '控制台 CP=%d：解析错误 0（实测 %d）' % (cp, n))
    miss = [b for b in BANNER if b not in txt]
    check(not miss, '控制台 CP=%d：横幅/流程中文全对%s' % (cp, '' if not miss else ' 缺' + str(miss)))
    check(('ARG ' + ARG_ASCII) in txt, '控制台 CP=%d：中文文件名 %s 原样传到子进程' % (cp, ARG_TARGET))
    check('按任意键关闭窗口' in txt, '控制台 CP=%d：流程走到结尾' % cp)

# ---------------------------------------------------------------- 2b
print('\n== 2b. 启动配音服务-CosyVoice.bat：环境缺失分支（验 if( ) 块与 goto END）==')
txt = run_copy('启动配音服务-CosyVoice.bat',
               [('set ENV_PY=C:\\ProgramData\\miniconda3\\envs\\cosyvoice\\python.exe',
                 'set ENV_PY=C:\\__no_such_env__\\python.exe')], 936)
check(errs(txt) == 0, '解析错误 0（实测 %d）' % errs(txt))
check('找不到 CosyVoice 环境' in txt and '安装CosyVoice环境.bat' in txt, '[X] 提示中文正常')
check('用 CosyVoice 2 后端启动' not in txt, 'goto END 生效（跳过了启动横幅）')

# ---------------------------------------------------------------- 2c
print('\n== 2c. 启动配音服务.bat：真跑（绕开联网装包那两条）==')
EB = ['德州扑克 - 本地配音服务', '正在启动', '服务已退出']
for cp in (936, 65001):
    txt = run_copy('启动配音服务.bat',
                   [('python -c "import edge_tts" >nul 2>nul', 'ver >nul'),
                    ('python server.py --port 9880',
                     'python -c "import sys;print(\'ARG\', ascii(sys.argv[1]))" server.py')],
                   cp, extra_path=PYDIR)
    n = errs(txt)
    check(n == 0, '控制台 CP=%d：解析错误 0（实测 %d）' % (cp, n))
    miss = [b for b in EB if b not in txt]
    check(not miss, '控制台 CP=%d：横幅/流程中文全对%s' % (cp, '' if not miss else ' 缺' + str(miss)))
    check("ARG 'server.py'" in txt, '控制台 CP=%d：走到启动命令' % cp)

# ---------------------------------------------------------------- 2d
print('\n== 2d. 安装CosyVoice环境.bat：真跑（变量换成桩 + 命令前加 call，命令行其余一字未改）==')
COSY = os.path.join(TMP, '_cosyroot')
WHL = os.path.join(TMP, '_whl')
shutil.rmtree(COSY, ignore_errors=True)
shutil.rmtree(WHL, ignore_errors=True)
STUBBAT = os.path.join(STUB, 'stub.bat')
steps = ['[1/9]', '[2/9]', '[3/9]', '[4/9]', '[5/9]', '[6/9]', '[7/9]', '[8/9]', '[9/9]']
real = open(os.path.join(BASE, '安装CosyVoice环境.bat'), 'rb').read().decode('gbk')
src2, n_call_py = re.subn(r'(?m)^([ \t]*)"%ENV_PY%" ', r'\1call "%ENV_PY%" ', real)
print('  %%ENV_PY%% 命令调用点加 call：%d 处' % n_call_py)
assert real.count('if exist "%ENV_PY%" (') == 1
assert 'if exist call' not in src2, 'patch 又误伤了 if exist 行'
for cp in (936, 65001):
    txt = run_copy('安装CosyVoice环境.bat',
                   [('set CONDA_ROOT=C:\\ProgramData\\miniconda3', 'set CONDA_ROOT=' + STUB),
                    ('set ENV_PY=%CONDA_ROOT%\\envs\\%ENV_NAME%\\python.exe', 'set ENV_PY=' + STUBBAT),
                    ('set COSY_ROOT=%USERPROFILE%\\.workbuddy\\binaries\\cosyvoice', 'set COSY_ROOT=' + COSY),
                    ('set WHL_DIR=%USERPROFILE%\\.workbuddy\\binaries\\_dl\\whl', 'set WHL_DIR=' + WHL)],
                   cp, timeout=180,
                   regex_patches=[(r'(?m)^([ \t]*)"%ENV_PY%" ', r'\1call "%ENV_PY%" '),
                                  (r'(?m)^([ \t]*)git clone', r'\1call git clone')])
    n = errs(txt)
    check(n == 0, '控制台 CP=%d：解析错误 0（实测 %d）' % (cp, n))
    miss = [s for s in steps if s not in txt]
    check(not miss, '控制台 CP=%d：9 步全部执行到%s' % (cp, '' if not miss else ' 缺' + str(miss)))
    check('安装结束' in txt and '准备音色.py' in txt, '控制台 CP=%d：跑到收尾说明' % cp)
    check('setuptools<81' in txt, '控制台 CP=%d：引号内的 < 没被当成重定向' % cp)
    check('并发下载.py' in txt, '控制台 CP=%d：脱字符续行的中文脚本名解析正常' % cp)

print('\n' + '=' * 60)
print('通过 %d 项，失败 %d 项' % (len(PASS), len(FAIL)))
for m in FAIL:
    print('  [FAIL] ' + m)
sys.exit(1 if FAIL else 0)
