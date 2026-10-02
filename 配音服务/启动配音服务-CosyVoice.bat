@echo off
rem ※ 本文件必须保存为 ANSI/GBK + CRLF 行尾。cmd.exe 不认 LF 行尾，改成 UTF-8 或 LF 会让中文变乱码并报「不是内部或外部命令」。
chcp 936 >nul
cd /d "%~dp0"
title 德州扑克 - 配音服务（CosyVoice 2 本地）

set COSY_ROOT=%USERPROFILE%\.workbuddy\binaries\cosyvoice
set ENV_PY=C:\ProgramData\miniconda3\envs\cosyvoice\python.exe

echo.
echo    ============================================================
echo      配音服务 —— CosyVoice 2 本地 GPU
echo    ============================================================
echo.

if not exist "%ENV_PY%" (
  echo    [X] 找不到 CosyVoice 环境：%ENV_PY%
  echo.
  echo        先跑一次「安装CosyVoice环境.bat」把环境装好。
  echo        或者：只是想用配音但不想折腾 GPU，就双击「启动配音服务.bat」
  echo              （那个用 edge 后端，免费、不需要显卡，代价是文本要发到微软那边）。
  echo.
  goto END
)

rem 检查模型和音色是否就绪 —— 缺了就直接说清楚缺什么，别让用户在启动日志里猜
if not exist "%COSY_ROOT%\pretrained_models\CosyVoice2-0.5B\llm.pt" (
  echo    [X] 模型权重还没下全。
  echo        跑：  "%ENV_PY%" 下载模型.py
  echo.
  goto END
)

if not exist "%COSY_ROOT%\pretrained_models\CosyVoice2-0.5B\spk2info.pt" (
  echo    [!] 还没给角色建音色，先跑一次（约 1-2 分钟）：
  echo          "%ENV_PY%" 准备音色.py
  echo.
  goto END
)

echo    用 CosyVoice 2 后端启动（首次加载模型要 30~60 秒，请耐心等一下）
echo    这个窗口别关 —— 关了配音就不出声了。用完按 Ctrl+C 停掉。
echo.

"%ENV_PY%" server.py --backend cosy --port 9880

echo.
echo    服务已退出（错误码：%ERRORLEVEL%）。

:END
echo.
echo    按任意键关闭窗口...
pause >nul