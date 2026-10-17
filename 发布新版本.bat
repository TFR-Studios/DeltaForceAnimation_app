@echo off
rem Chcp 65001 -- UTF8 code page for Chinese text
chcp 65001 >nul 2>&1
setlocal EnableExtensions EnableDelayedExpansion
title DFAE - Release
cd /d "%~dp0"
echo.
echo ============================================================
echo    Release a new version (auto build + GitHub + GitCode)
echo ============================================================
echo.
where node >nul 2>&1
if errorlevel 1 goto NO_NODE
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto NO_GIT
for /f "delims=" %%v in ('node -p "require(\"./package.json\").version"') do set "CUR=%%v"
echo    Current version: v!CUR!
echo.
echo    1 = patch  (bug fix)      last digit +1
echo    2 = minor  (new feature)  middle digit +1, last = 0
echo    3 = major  (breaking)     first digit +1, rest = 0
echo    4 = custom version
echo.
set "CH="
set /p "CH= Choose 1-4: "
set "BUMP=patch"
if "!CH!"=="1" set "BUMP=patch"
if "!CH!"=="2" set "BUMP=minor"
if "!CH!"=="3" set "BUMP=major"
if not "!CH!"=="4" goto HAVE_BUMP
set "BUMP="
set /p "BUMP= Version (x.y.z): "
if not defined BUMP goto NO_BUMP
:HAVE_BUMP
echo.
echo ------------------------------------------------------------
echo    1. bump version in 3 files
echo    2. draft release notes
echo    3. commit + push + tag + push tag
echo    4. GitHub builds and publishes (~10 min), syncs to GitCode
echo ------------------------------------------------------------
echo.
set "GO="
set /p "GO= Start? (y = yes, Enter = cancel): "
if /i "!GO!"=="y" goto DO_IT
echo    Cancelled.
pause & exit /b 0
:DO_IT
echo.
echo == [1/4] Bump version ==
node scripts\bump-version.mjs !BUMP! --notes
if errorlevel 1 goto FAIL_BUMP
for /f "delims=" %%v in ('node -p "require(\"./package.json\").version"') do set "NEW=%%v"
set "TAG=v!NEW!"
echo.
echo    Release notes: docs\RELEASE_NOTES_!TAG!.md
echo.
set "EDIT="
set /p "EDIT= Open it in Notepad now? (y = yes, Enter = skip): "
if /i not "!EDIT!"=="y" goto SKIP_EDIT
start "" notepad "docs\RELEASE_NOTES_!TAG!.md"
echo    Save it, then press any key here to continue...
pause >nul
:SKIP_EDIT
echo.
echo == [2/4] Commit ==
git add -A
if errorlevel 1 goto FAIL_ADD
git commit -m "chore: !TAG!"
if errorlevel 1 goto FAIL_COMMIT
echo.
echo == [3/4] Push to GitHub ==
git push
if errorlevel 1 goto FAIL_PUSH
echo.
echo == [4/4] Tag and push tag (this triggers the build) ==
set "TFORCE="
git rev-parse -q --verify "refs/tags/!TAG!" >nul 2>&1
if not errorlevel 1 set "TFORCE=-f"
git tag -f !TAG!
if errorlevel 1 goto FAIL_TAG
git push !TFORCE! origin !TAG!
if errorlevel 1 goto FAIL_TAG_PUSH
echo.
echo ------------------------------------------------------------
echo    Done. Tag !TAG! pushed.
echo.
echo    GitHub will now: verify version, build Windows + Android,
echo    create the GitHub release, and sync assets to GitCode.
echo.
echo    Actions : https://github.com/TFR-Studios/DeltaForceAnimation_app/actions
echo    Releases: https://github.com/TFR-Studios/DeltaForceAnimation_app/releases
echo              https://gitcode.com/TFR-Studios/DeltaForceAnimation_app/releases
echo ------------------------------------------------------------
echo.
set "OPEN="
set /p "OPEN= Open the Actions page? (y = yes): "
if /i "!OPEN!"=="y" start "" https://github.com/TFR-Studios/DeltaForceAnimation_app/actions
pause
exit /b 0
:NO_NODE
echo [X] Node.js not found.
pause & exit /b 1
:NO_GIT
echo [X] Not a git repository.
pause & exit /b 1
:NO_BUMP
echo [X] No version given.
pause & exit /b 1
:FAIL_BUMP
echo [X] Version bump failed.
pause & exit /b 1
:FAIL_ADD
echo [X] git add failed.
pause & exit /b 1
:FAIL_COMMIT
echo [X] git commit failed.
pause & exit /b 1
:FAIL_PUSH
echo [X] git push failed (network or credentials).
pause & exit /b 1
:FAIL_TAG
echo [X] git tag failed.
pause & exit /b 1
:FAIL_TAG_PUSH
echo [X] git push tag failed. Retry with: git push -f origin %TAG%
pause & exit /b 1
