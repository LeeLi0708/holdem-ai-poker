@echo off
rem ※ 本文件必须保存为 ANSI/GBK + CRLF 行尾。cmd.exe 不认 LF 行尾，改成 UTF-8 或 LF 会让中文变乱码并报「不是内部或外部命令」。
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 德州扑克 - 安装 CosyVoice 2 环境

set CONDA_ROOT=C:\ProgramData\miniconda3
set ENV_NAME=cosyvoice
set ENV_PY=%CONDA_ROOT%\envs\%ENV_NAME%\python.exe
set COSY_ROOT=%USERPROFILE%\.workbuddy\binaries\cosyvoice
set WHL_DIR=%USERPROFILE%\.workbuddy\binaries\_dl\whl
set MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple
set PYTORCH_SRC=https://download.pytorch.org/whl/cu121

echo.
echo   ============================================================
echo     CosyVoice 2 本地配音环境安装（Windows）
echo   ============================================================
echo.
echo     全程约 15-25 分钟（大头是 torch 的 2.3GB）。
echo     按下面 9 步走，每一步的顺序都是踩坑踩出来的，别调换。
echo.
echo       1. 建 Python 3.10 环境
echo       2. 装 setuptools^<81      （whisper 的 setup.py 要 pkg_resources）
echo       3. 并发下载 torch 的 wheel  （单线程会被限速到 1MB/s 以下）
echo       4. 从本地装 torch / torchaudio
echo       5. 装 whisper            （必须 --no-build-isolation）
echo       6. 装其余依赖
echo       7. 拉 CosyVoice 源码 + Matcha-TTS（走 gh-proxy）
echo       8. 打 Windows 适配补丁
echo       9. 下载模型权重 3.8GB
echo.
echo     装完之后还要单独跑一次「准备音色.py」给 7 个角色建音色。
echo.
pause

rem ---------------------------------------------------------- 1. conda 环境
echo.
echo   [1/9] Python 3.10 环境
if exist "%ENV_PY%" (
  echo        已存在，跳过。
) else (
  if not exist "%CONDA_ROOT%\Scripts\conda.exe" (
    echo        [X] 没找到 conda：%CONDA_ROOT%
    echo            先装 Miniconda（选 "Install for all users"，路径用 C:\ProgramData\miniconda3）：
    echo              https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-latest-Windows-x86_64.exe
    pause
    exit /b 1
  )
  "%CONDA_ROOT%\Scripts\conda.exe" create -n %ENV_NAME% python=3.10 -y ^
       -c https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge --override-channels
  if errorlevel 1 ( echo        [X] 建环境失败 & pause & exit /b 1 )
)
"%ENV_PY%" --version
if errorlevel 1 ( echo        [X] 环境里的 python 跑不起来 & pause & exit /b 1 )

rem ---------------------------------------------------------- 2. setuptools
echo.
echo   [2/9] setuptools ^< 81（新版删了 pkg_resources，whisper 构建会挂）
"%ENV_PY%" -m pip install -q "setuptools<81" -i %MIRROR%
if errorlevel 1 ( echo        [X] 失败 & pause & exit /b 1 )

rem ---------------------------------------------------------- 3. 下 torch
echo.
echo   [3/9] 下载 torch / torchaudio（并发，约 1-3 分钟）
if not exist "%WHL_DIR%" mkdir "%WHL_DIR%"
if not exist "%WHL_DIR%\torch-2.3.1+cu121-cp310-cp310-win_amd64.whl" (
  "%ENV_PY%" 并发下载.py "%PYTORCH_SRC%/torch-2.3.1%%2Bcu121-cp310-cp310-win_amd64.whl" ^
      "%WHL_DIR%\torch-2.3.1+cu121-cp310-cp310-win_amd64.whl" -n 8
  if errorlevel 1 ( echo        [X] torch 下载失败 & pause & exit /b 1 )
)
if not exist "%WHL_DIR%\torchaudio-2.3.1+cu121-cp310-cp310-win_amd64.whl" (
  "%ENV_PY%" 并发下载.py "%PYTORCH_SRC%/torchaudio-2.3.1%%2Bcu121-cp310-cp310-win_amd64.whl" ^
      "%WHL_DIR%\torchaudio-2.3.1+cu121-cp310-cp310-win_amd64.whl" -n 4
  if errorlevel 1 ( echo        [X] torchaudio 下载失败 & pause & exit /b 1 )
)

rem ---------------------------------------------------------- 4. 装 torch
echo.
echo   [4/9] 安装 torch / torchaudio
"%ENV_PY%" -m pip install "%WHL_DIR%\torch-2.3.1+cu121-cp310-cp310-win_amd64.whl" ^
                                   "%WHL_DIR%\torchaudio-2.3.1+cu121-cp310-cp310-win_amd64.whl" -i %MIRROR%
if errorlevel 1 ( echo        [X] torch 装失败 & pause & exit /b 1 )
"%ENV_PY%" -c "import torch;print('        torch',torch.__version__,'cuda',torch.cuda.is_available())"

rem ---------------------------------------------------------- 5. whisper
echo.
echo   [5/9] 装 whisper（--no-build-isolation 不能省）
"%ENV_PY%" -m pip install --no-build-isolation "openai-whisper==20231117" -i %MIRROR%
if errorlevel 1 ( echo        [X] whisper 装失败 & pause & exit /b 1 )

rem ---------------------------------------------------------- 6. 其余
echo.
echo   [6/9] 其余依赖（约 5 分钟）
"%ENV_PY%" -m pip install -r requirements-cosy.txt -i %MIRROR%
if errorlevel 1 ( echo        [X] 依赖装失败 & pause & exit /b 1 )
echo        —— 检查一遍关键包 ——
"%ENV_PY%" -c "import torch,lightning,wetext,pyworld,pyarrow,gdown,wget,matplotlib,whisper;print('        全部 import 正常')"

rem ---------------------------------------------------------- 7. 源码
echo.
echo   [7/9] CosyVoice 源码
if exist "%COSY_ROOT%\cosyvoice\cli\cosyvoice.py" (
  echo        已有源码，跳过。
) else (
  if not exist "%COSY_ROOT%" mkdir "%COSY_ROOT%"
  git clone --depth 1 https://gh-proxy.com/https://github.com/FunAudioLLM/CosyVoice.git "%COSY_ROOT%"
  if errorlevel 1 ( echo        [X] 克隆失败 & pause & exit /b 1 )
)
if not exist "%COSY_ROOT%\third_party\Matcha-TTS\matcha" (
  rmdir /s /q "%COSY_ROOT%\third_party\Matcha-TTS" 2>nul
  git clone --depth 1 https://gh-proxy.com/https://github.com/shivammehta25/Matcha-TTS.git ^
      "%COSY_ROOT%\third_party\Matcha-TTS"
  if errorlevel 1 ( echo        [X] Matcha-TTS 拉取失败 & pause & exit /b 1 )
)

rem ---------------------------------------------------------- 8. 补丁
echo.
echo   [8/9] Windows 适配补丁
"%ENV_PY%" 补丁-CosyVoice-Windows.py --repo "%COSY_ROOT%"

rem ---------------------------------------------------------- 9. 模型
echo.
echo   [9/9] 下载模型权重（3.8GB，约 4 分钟）
"%ENV_PY%" 下载模型.py --dir "%COSY_ROOT%\pretrained_models\CosyVoice2-0.5B"
if errorlevel 1 ( echo        [!] 模型没下全，重跑会断点续传 )

echo.
echo   ============================================================
echo     安装结束。还差最后一步 —— 给 7 个角色建音色：
echo.
echo         "%ENV_PY%" 准备音色.py
echo.
echo     然后把 voices.json 里的 "backend" 改成 "cosy"，启动服务：
echo.
echo         "%ENV_PY%" server.py
echo.
echo     （CosyVoice 后端必须用这个环境的 Python，
echo       启动配音服务.bat 用的是系统 Python，只够跑 edge 后端）
echo   ============================================================
echo.
pause
