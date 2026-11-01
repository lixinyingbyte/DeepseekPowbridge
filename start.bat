@echo off
setlocal
cd /d "%~dp0"
title DSX Proxy

rem ============================================================
rem  One-click launcher (Windows)
rem  First run: copies config.example.json to config.json and
rem  opens it in Notepad so you can fill bearer / deviceId.
rem ============================================================

echo.
echo  ================================================
echo    DSX Proxy - DeepSeek local OpenAI endpoint
echo  ================================================
echo.

rem 1. check node
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo  [OK] Node.js %NODEVER%

rem 2. check config
if not exist "config.json" goto MAKE_CONFIG
if not exist "config.example.json" goto NO_TEMPLATE
echo  [OK] config.json found
goto CHECK_BEARER

:MAKE_CONFIG
copy "config.example.json" "config.json" >nul
echo  [OK] created config.json
echo.
echo  Next step: fill in these two fields in config.json
echo      creds.bearer    - Authorization header without the 'Bearer ' prefix
echo      creds.deviceId  - value of x-device-id
echo.
echo  Opening Notepad now. Save, then run start.bat again.
echo.
notepad "config.json"
pause
exit /b 0

:NO_TEMPLATE
echo  [X] config.example.json is missing - folder is incomplete
pause
exit /b 1

:NO_NODE
echo  [X] Node.js not found. Please install Node.js 18 or newer
echo      https://nodejs.org/
echo.
pause
exit /b 1

:CHECK_BEARER
findstr /c:"\"bearer\": \"\"" "config.json" >nul
if not errorlevel 1 goto BEARER_EMPTY
goto SELFTEST

:BEARER_EMPTY
echo.
echo  [!] creds.bearer in config.json is still empty
echo      Capture Authorization and x-device-id first, then fill them in.
echo      Opening config.json now...
notepad "config.json"
pause
exit /b 0

:SELFTEST
echo.
echo  Running self-test...
node src\index.js --self-test
if errorlevel 1 goto SELFTEST_FAIL
goto CHECK_ADB

rem ------------------------------------------------------------
rem  Auto-setup PoW oracle tunnel via adb
rem  oracle mode needs: adb forward tcp:17381 tcp:17381
rem  USB disconnect breaks the tunnel, re-establish each launch.
rem ------------------------------------------------------------
:CHECK_ADB
findstr /c:"\"mode\": \"oracle\"" "config.json" >nul
if errorlevel 1 goto START

set "ADB="
where adb >nul 2>nul
if not errorlevel 1 set "ADB=adb"
if defined ADB goto ADB_READY

rem fallback: probe common install locations
if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if defined ADB goto ADB_READY
if exist "%USERPROFILE%\AppData\Local\Android\Sdk\platform-tools\adb.exe" set "ADB=%USERPROFILE%\AppData\Local\Android\Sdk\platform-tools\adb.exe"
if defined ADB goto ADB_READY
if exist "C:\Android\platform-tools\adb.exe" set "ADB=C:\Android\platform-tools\adb.exe"
if defined ADB goto ADB_READY
goto ADB_NO_PATH

:ADB_READY
echo  [OK] adb: %ADB%

"%ADB%" devices | findstr /r /c:"device$" >nul
if errorlevel 1 goto ADB_NO_DEVICE

echo  [OK] adb device detected, setting up PoW tunnel...
"%ADB%" forward --remove tcp:17381 >nul 2>nul
"%ADB%" forward tcp:17381 tcp:17381 >nul
"%ADB%" forward --list | findstr 17381 >nul
if errorlevel 1 goto ADB_FWD_FAIL
echo  [OK] tunnel ready: tcp:17381 to device:17381
goto START

:ADB_NO_PATH
echo.
echo  [!] pow.mode=oracle but adb not found in PATH.
echo      Either add platform-tools to PATH, or run manually:
echo          adb forward tcp:17381 tcp:17381
echo      Or switch pow.mode to "manual" (one-shot header).
echo.
pause
goto START

:ADB_NO_DEVICE
echo.
echo  [!] pow.mode=oracle but no adb device connected.
echo      1) connect phone via USB, enable USB debugging
echo      2) make sure DeepSeek app is running (PowServer listens inside it)
echo      3) then run: adb forward tcp:17381 tcp:17381
echo.
pause
goto START

:ADB_FWD_FAIL
echo.
echo  [X] adb forward failed. Check that adb is authorized on the phone.
pause
goto START

:START
echo.
echo  ================================================
echo    Starting... press Ctrl+C to stop
echo  ================================================
echo.
node src\index.js
echo.
echo  [X] service exited unexpectedly, see log above
pause
exit /b 0

:SELFTEST_FAIL
echo.
echo  [X] self-test failed, see messages above
pause
exit /b 1
