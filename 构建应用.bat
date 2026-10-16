@echo off
chcp 936 >nul 2>&1
setlocal EnableDelayedExpansion
title 构建三角洲行动动画编辑器
cd /d "%~dp0"

echo.
echo  ================================================================
echo    三角洲行动动画编辑器 · 构建 Windows 应用
echo  ================================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [X] 没有找到 Node.js。请先安装 Node.js 20 或更高版本:
    echo      https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node -v 2^>nul') do echo  [0/4] Node.js %%v  OK

if not exist "node_modules\electron\dist\electron.exe" (
    echo  [1/4] 安装依赖 ^(首次需要联网,可能要几分钟^)...
        set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  [X] 依赖安装失败。若卡在 GitHub 下载 Electron,请确认本目录下的 .npmrc 镜像配置可用。
        pause
        exit /b 1
    )
) else (
    echo  [1/4] 依赖已就绪
)

echo  [2/4] 类型检查 + 构建前端产物...
call npm run build
if errorlevel 1 (
    echo.
    echo  [X] 构建失败,请查看上面的错误信息。
    pause
    exit /b 1
)

if not exist "build\icon.ico" (
    echo  [3/4] 生成应用图标...
    call npm run icons
    if errorlevel 1 echo  [!] 图标生成失败,将使用 Electron 自带的默认图标。
) else (
    echo  [3/4] 图标已就绪
)

echo  [4/4] 打包 ^(免安装目录 + 便携版单文件,约 1~3 分钟^)...
call npx electron-builder --win --x64
if errorlevel 1 (
    echo.
    echo  [X] 打包失败,请查看上面的错误信息。
    pause
    exit /b 1
)

echo.
echo  ----------------------------------------------------------------
echo   完成!产物在 release\ 目录下:
echo.
echo     免安装版:  release\win-unpacked\   ^(整个文件夹拷走即可用^)
echo     便携版:    release\DeltaForceAnimationEditor-Portable-1.0.0.exe
echo.
echo   双击「启动应用.bat」可直接运行。
echo  ----------------------------------------------------------------
echo.
pause
exit /b 0
