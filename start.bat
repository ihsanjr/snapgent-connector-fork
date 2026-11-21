@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Snapgent Bridge
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"

set "USE_PYTHON=0"
if exist "%~dp0bridge.py" (
    where python >nul 2>nul
    if not errorlevel 1 set "USE_PYTHON=1"
)

if "%USE_PYTHON%"=="0" if not exist "%~dp0bridge.exe" (
    echo.
    echo   ERROR: Neither Python + bridge.py nor bridge.exe was found next to start.bat.
    echo   Install Python 3 or extract the full release next to start.bat.
    echo.
    pause
    exit /b 1
)

echo.
echo   Configuring MCP servers and detecting installed apps...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-config.ps1"
if errorlevel 1 (
    echo.
    echo   ERROR: Could not configure the MCP connections.
    echo   Check the message above, then run start.bat again.
    echo.
    pause
    exit /b 1
)

REM Terminate any lingering bridge.exe or python bridge.py instances to prevent port/session collisions.
tasklist /FI "IMAGENAME eq bridge.exe" /NH 2>nul | find /I "bridge.exe" >nul
if not errorlevel 1 (
    echo   Stopping previous bridge.exe instance^(s^)...
    taskkill /F /T /IM bridge.exe >nul 2>nul
    timeout /t 1 /nobreak >nul
)
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like '*bridge.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo.
echo   +--------------------------------------------------+
echo   ^| Snapgent is now running.                         ^|
echo   ^| Keep this window open while you use the agent.   ^|
echo   ^| Minimise it freely - closing it stops the bridge.^|
echo   +--------------------------------------------------+
echo.

if "%USE_PYTHON%"=="1" (
    echo   Mode: Python ^(bridge.py^)
    echo.
    python "%~dp0bridge.py"
) else (
    echo   Mode: Binary ^(bridge.exe^)
    echo.
    "%~dp0bridge.exe"
)
set "BRIDGE_EXIT=%errorlevel%"

echo.
if not "%BRIDGE_EXIT%"=="0" (
    echo   Bridge stopped with ERROR code %BRIDGE_EXIT%.
) else (
    echo   Bridge stopped normally.
)
echo   Press any key to close.
pause >nul
exit /b 0
