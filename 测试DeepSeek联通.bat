@echo off
rem 本文件必须存成 ANSI/GBK + CRLF 行尾。cmd.exe 只认 CRLF；存成 UTF-8 + LF 会满屏乱码并把命令从中间拆断。
chcp 936 >nul
cd /d "%~dp0"
title 测试 DeepSeek 联通

echo.
echo   ========================================
echo    测试 DeepSeek 联通
echo   ========================================
echo.
echo   三步：先敲门看网络通不通，再验 Key 认不认，最后让它真说一句话。
echo   任何一步红，后面的就不用看了。
echo.

rem ---------- 0. 有没有 curl ----------
where curl >nul 2>nul
if errorlevel 1 (
  echo   [X] 没找到 curl。
  echo.
  echo       Windows 10 1803 以后系统自带。你是更老的系统，或者 PATH 被人改过。
  echo       装一个就行： https://curl.se/windows/
  echo.
  pause
  exit /b 1
)

rem ---------- 1. 接口地址、模型、Key ----------
set "BASE=https://api.deepseek.com"
set "MODEL=deepseek-v4-flash"
if defined DEEPSEEK_BASE_URL set "BASE=%DEEPSEEK_BASE_URL%"
if defined DEEPSEEK_MODEL set "MODEL=%DEEPSEEK_MODEL%"

set "KEY="
if defined DEEPSEEK_API_KEY set "KEY=%DEEPSEEK_API_KEY%"
if not defined KEY (
  if exist "%~dp0deepseek_key.txt" set /p KEY=<"%~dp0deepseek_key.txt"
)
if not defined KEY (
  echo   把 DeepSeek API Key 粘进来（sk- 开头；只在本机用，不会发到别处）：
  set /p "KEY=  > "
  echo.
)
rem 复制时很容易带出空格和引号，一律清掉（DeepSeek 的 Key 里不会有空格）
set "KEY=%KEY: =%"
set "KEY=%KEY:"=%"
if not defined KEY (
  echo   [X] 没拿到 Key，测不了。
  echo.
  pause
  exit /b 1
)

echo   接口 ： %BASE%
echo   模型 ： %MODEL%
echo   Key  ： %KEY:~0,6%****%KEY:~-4%
echo.

echo %KEY% | findstr /B "sk-" >nul
if errorlevel 1 (
  echo   [!] 这个 Key 不是 sk- 开头，多半复制错了。下面照测，但大概率 401。
  echo.
)

set "T=%TEMP%\_dstest"
set "PASS=0"
set "FAIL=0"

rem ---------- 2. 第一步：网络 ----------
echo   [1/3] 网络通不通 —— 不带 Key 敲一下门，最多等 15 秒...
curl -s --max-time 15 -o "%T%_1.txt" -w "%%{http_code} %%{time_total}" "%BASE%/models" > "%T%_1c.txt"
set "R1="
set /p R1=<"%T%_1c.txt"
for /f "tokens=1,2" %%a in ("%R1%") do ( set "C1=%%a" & set "T1=%%b" )
if "%C1%"=="401" goto NET_OK
if "%C1%"=="000" goto NET_FAIL
goto NET_OTHER

:NET_OK
echo         [OK] 通。没带 Key 对方回了 401，这正是「网络通、站点在」的证据（耗时 %T1% 秒）
echo.
goto AUTH

:NET_FAIL
echo         [X] 连不上（curl 返回 000）。
echo.
echo            按顺序自查：
echo            1) 网是不是断了，先开个网页试试；
echo            2) 公司网络 / 代理把 api.deepseek.com 拦了没有；
echo            3) 地址填错没有：只填到域名，别带 /v1、别带 /chat/completions。
echo               现在填的是： %BASE%
echo.
set "FAIL=1"
goto END

:NET_OTHER
echo         [!] 回了 %C1%，不是预期的 401。可能走了代理或者被劫持，接着往下测。
echo.

rem ---------- 3. 第二步：Key 与余额 ----------
:AUTH
echo   [2/3] Key 认不认 —— 查一下账户余额，最多等 20 秒...
curl -s --max-time 20 -o "%T%_2.txt" -w "%%{http_code} %%{time_total}" -H "Authorization: Bearer %KEY%" "%BASE%/user/balance" > "%T%_2c.txt"
set "R2="
set /p R2=<"%T%_2c.txt"
for /f "tokens=1,2" %%a in ("%R2%") do ( set "C2=%%a" & set "T2=%%b" )
echo         HTTP %C2%   耗时 %T2% 秒
echo         返回：
type "%T%_2.txt"
echo.
if "%C2%"=="200" goto AUTH_OK
if "%C2%"=="401" goto AUTH_401
if "%C2%"=="402" goto AUTH_402
if "%C2%"=="000" goto AUTH_TIMEOUT
goto AUTH_OTHER

:AUTH_OK
echo         [OK] Key 有效。看上面 is_available 是不是 true，余额字段是不是 0。
echo.
set "PASS=1"
goto CHAT

:AUTH_401
echo         [X] Key 不被认可（401）。
echo.
echo            1) 重新去平台复制一遍，注意前后别带空格；
echo            2) 是不是复制成了别的平台的 Key；
echo            3) 账户有没有被停用。
echo.
set "FAIL=1"
goto END

:AUTH_402
echo         [X] 余额不够了（402）。充点值再来。
echo.
set "FAIL=1"
goto END

:AUTH_TIMEOUT
echo         [X] 超时没回话（000）。网络通但握手慢，或者被中间设备掐了。过一会再试。
echo.
set "FAIL=1"
goto END

:AUTH_OTHER
echo         [!] 回了 %C2%，不是 200。看上面的返回内容判断。接着试最后一步。
echo.

rem ---------- 4. 第三步：真的说一句话 ----------
:CHAT
echo   [3/3] 能不能说话 —— 发一句最短的，最多等 40 秒...
echo {"model":"%MODEL%","messages":[{"role":"user","content":"ping"}],"max_tokens":16,"stream":false}> "%T%_3.json"
curl -s --max-time 40 -o "%T%_3.txt" -w "%%{http_code} %%{time_total}" -H "Authorization: Bearer %KEY%" -H "Content-Type: application/json" -d @"%T%_3.json" "%BASE%/chat/completions" > "%T%_3c.txt"
set "R3="
set /p R3=<"%T%_3c.txt"
for /f "tokens=1,2" %%a in ("%R3%") do ( set "C3=%%a" & set "T3=%%b" )
echo         HTTP %C3%   耗时 %T3% 秒
echo         返回：
type "%T%_3.txt"
echo.
if "%C3%"=="200" goto CHAT_OK
if "%C3%"=="000" goto CHAT_TIMEOUT
goto CHAT_BAD

:CHAT_OK
echo         [OK] 通了。模型 %MODEL% 能正常对话，%T3% 秒回话。
echo.
echo             这个速度可以粗算一下：牌局里一次决策大概就是这个量级的耗时。
echo.
set "PASS=2"
goto END

:CHAT_TIMEOUT
echo         [X] 40 秒没回话（000）。网络能握手但请求出不去，或者模型在排队。过一会再试。
echo.
set "FAIL=1"
goto END

:CHAT_BAD
echo         [!] 回了 %C3%。最常见的是模型名不对 —— 把你现在能用的模型列出来：
echo.
curl -s --max-time 20 -H "Authorization: Bearer %KEY%" "%BASE%/models"
echo.
echo.
echo             对着上面的 id，把模型名填对再跑一次：
echo                 set DEEPSEEK_MODEL=某个id
echo                 测试DeepSeek联通.bat
echo.
set "FAIL=1"
goto END

rem ---------- 5. 收尾 ----------
:END
del /q "%T%_1.txt" "%T%_1c.txt" "%T%_2.txt" "%T%_2c.txt" "%T%_3.txt" "%T%_3c.txt" "%T%_3.json" >nul 2>nul
echo   ========================================
if "%FAIL%"=="1" (
  echo    结论：没通。按上面红字那条查。
) else (
  echo    结论：三步全过，可以开局了。
)
echo   ========================================
echo.
echo   想换个模型测： set DEEPSEEK_MODEL=模型名  再双击本文件
echo   想换个地址测： set DEEPSEEK_BASE_URL=https://xxx  再双击本文件
echo   不想每次手粘 Key：在本文件旁边放一个 deepseek_key.txt，第一行写 Key
echo.
pause
