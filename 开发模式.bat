@echo off
chcp 936 >nul 2>&1
setlocal
title 三角洲行动动画编辑器 · 开发模式
cd /d "%~dp0"

if not exist "node_modules\vite\bin\vite.js" (
    echo  首次运行,正在安装依赖...
        set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo  [X] 依赖安装失败。
        pause
        exit /b 1
    )
)

echo.
echo  开发模式:改 src\ 里的代码会热更新,不用重新打包。
echo  关掉应用窗口即停止;本窗口按 Ctrl+C 也可以。
echo.
call npm run app:dev
pause
exit /b 0
