@echo off
chcp 936 >nul 2>&1
setlocal
title 三角洲行动动画编辑器 · 自检
cd /d "%~dp0"

if not exist "dist\index.html" (
    echo  没有构建产物,先执行 npm run build...
    call npm run build
    if errorlevel 1 (
        echo  [X] 构建失败。
        pause
        exit /b 1
    )
)

echo.
echo  正在自检:环境 / 编码能力 / 资源加载 / 界面截图。
echo  窗口会短暂弹出,跑完自动关闭。
echo.
call npx electron . --smoke --smoke-out=release\smoke
set "CODE=%errorlevel%"

echo.
echo  报告: release\smoke\smoke-report.json
echo  截图: release\smoke\smoke-ui.png
if not "%CODE%"=="0" echo  [!] 自检未全部通过,请看上面的失败项。
echo.
pause
exit /b %CODE%
