@echo off
chcp 936 >nul 2>&1
setlocal
title 三角洲行动动画编辑器
cd /d "%~dp0"

for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "APPVER=%%v"

set "UNPACKED=release\win-unpacked\三角洲行动动画编辑器.exe"
if exist "%UNPACKED%" (
    echo  正在启动免安装版...
    start "" "%UNPACKED%"
    exit /b 0
)

set "PORTABLE=release\DeltaForceAnimationEditor-Portable-%APPVER%.exe"
if not exist "%PORTABLE%" (
    set "PORTABLE="
    for %%f in ("release\DeltaForceAnimationEditor-Portable-*.exe") do set "PORTABLE=%%~ff"
)
if defined PORTABLE (
    echo  正在启动便携版(首次启动需解压,请稍等)...
    start "" "%PORTABLE%"
    exit /b 0
)

echo.
echo  [!] 还没有打包好的应用。
echo      先双击「构建应用.bat」生成免安装版与便携版 exe;
echo      或者双击「开发模式.bat」跳过打包直接运行。
echo.
pause
exit /b 1
