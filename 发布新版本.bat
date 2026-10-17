@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title DFAE - Release

where node >nul 2>&1
if errorlevel 1 goto NO_NODE

if not exist "scripts\dfae-cli.mjs" goto NO_CLI

node "scripts\dfae-cli.mjs" release

pause >nul
exit /b 0

:NO_NODE
echo.
echo   [X] Node.js was not found on PATH.
echo       Install Node.js 20 or newer, then run this again.
echo.
pause
exit /b 1

:NO_CLI
echo.
echo   [X] scripts\dfae-cli.mjs is missing.
echo       Run this launcher from the project root folder.
echo.
pause
exit /b 1
