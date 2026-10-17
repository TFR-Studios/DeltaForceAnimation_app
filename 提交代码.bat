@echo off
rem Chcp 65001 -- UTF8 code page for Chinese text
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
title DFAE - Commit code
cd /d "%~dp0"
echo.
echo ============================================================
echo    Submit code (code only, no packaging)
echo ============================================================
echo.
where node >nul 2>&1
if errorlevel 1 goto NO_NODE
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto NO_GIT
echo == Pending changes ==
git status --short
echo.
set "CHANGED="
for /f "delims=" %%i in ('git status --porcelain') do set "CHANGED=1"
if not defined CHANGED goto NOTHING
:ASK_MSG
echo.
set "MSG="
set /p "MSG= Commit message (required): "
if defined MSG goto GOT_MSG
echo    [X] Message cannot be empty.
goto ASK_MSG
:GOT_MSG
echo.
echo == Committing ==
git add -A
if errorlevel 1 goto FAIL_ADD
git commit -m "!MSG!"
if errorlevel 1 goto FAIL_COMMIT
echo.
echo == Pushing to GitHub ==
git push
if errorlevel 1 goto FAIL_PUSH
echo.
echo ------------------------------------------------------------
echo    Done. GitHub updated. GitCode mirror follows with a delay.
echo    Nothing was packaged - use release.bat to cut a release.
echo ------------------------------------------------------------
echo.
pause
exit /b 0
:NO_NODE
echo [X] Node.js not found.
pause & exit /b 1
:NO_GIT
echo [X] Not a git repository.
pause & exit /b 1
:NOTHING
echo    Nothing to commit.
pause & exit /b 0
:FAIL_ADD
echo [X] git add failed.
pause & exit /b 1
:FAIL_COMMIT
echo [X] git commit failed.
pause & exit /b 1
:FAIL_PUSH
echo [X] git push failed (network or credentials).
pause & exit /b 1
