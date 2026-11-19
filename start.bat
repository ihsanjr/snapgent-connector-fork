@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Snapgent Bridge
cd /d "%~dp0"

if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul
set "LOGFILE=%~dp0logs\start.log"

if not exist "%~dp0bridge.exe" (
    echo.
    echo   ERROR: bridge.exe not found next to start.bat.
    echo   Extract the whole download, then run start.bat from that folder.
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

REM Terminate any lingering bridge.exe instances to prevent port/session collisions.
tasklist /FI "IMAGENAME eq bridge.exe" /NH 2>nul | find /I "bridge.exe" >nul
if not errorlevel 1 (
    echo   Stopping previous bridge instance^(s^)...
    taskkill /F /T /IM bridge.exe >nul 2>nul
    timeout /t 1 /nobreak >nul
)

echo.
echo   +--------------------------------------------------+
echo   ^| Snapgent is now running.                         ^
echo   ^| Keep this window open while you use the agent.   ^
echo   ^| Minimise it freely - closing it stops the bridge.^
echo   +--------------------------------------------------+
echo.

"%~dp0bridge.exe"
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
