@echo off
rem ※ 本文件必须保存为 ANSI/GBK + CRLF 行尾。cmd.exe 不认 LF 行尾，改成 UTF-8 或 LF 会让中文变乱码并报「不是内部或外部命令」。
chcp 936 >nul
cd /d "%~dp0"
title 德州扑克 - 本地配音服务

echo.
echo   ========================================
echo    德州扑克 - 本地配音服务
echo   ========================================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 python。
  echo.
  echo       先装一个 Python 3.9 或更高版本：
  echo         https://www.python.org/downloads/
  echo       安装时记得勾上 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)

python -c "import edge_tts" >nul 2>nul
if errorlevel 1 (
  echo   [!] 还没装 edge-tts，现在装上（只需要装这一次，约 20 秒）...
  echo.
  python -m pip install edge-tts
  if errorlevel 1 (
    echo.
    echo   [X] 装失败了。多半是网络或 pip 源的问题，可以试试：
    echo         python -m pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo   正在启动...
echo.
python server.py --port 9880

echo.
echo   服务已退出。按任意键关闭窗口。
pause >nul
