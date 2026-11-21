@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
setlocal EnableDelayedExpansion
title 三角洲行动动画编辑器 · 管理工具

rem  ============================================================
rem   这个批处理只做一件事:确认环境、把控制权交给 scripts\dfae-cli.mjs。
rem   界面文字全在 Node 脚本里(cmd 的代码页会撕裂中文,写在这里不可靠)。
rem   ============================================================

set "RULE=  ================================================================"
set "THIN=  ----------------------------------------------------------------"

where node >nul 2>&1
if errorlevel 1 goto :NO_NODE

if not exist "package.json" goto :NO_PROJECT
if not exist "scripts\dfae-cli.mjs" goto :NO_CLI

rem ---------- 环境提示(不拦路,只把话说在前面) ----------
set "NODEV="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
if not defined NODEV set "NODEV=(未知)"
set "NODEMAJOR="
for /f "tokens=1 delims=." %%a in ("!NODEV:v=!") do set "NODEMAJOR=%%a"
set "APPVER="
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "%~dp0package.json" 2^>nul') do set "APPVER=%%v"
if not defined APPVER set "APPVER=(未知)"

echo.
echo !RULE!
echo    三角洲行动动画编辑器  ·  管理工具
echo    版本 v!APPVER!    Node.js !NODEV!
echo !THIN!
echo    1  提交代码              改完东西,一键提交并推到 GitHub + GitCode
echo    2  发布新版本            改版本号 → 提交 → 打标签 → 双端出包
echo    3  上传安装包到 GitCode   本地已打好的包,补传到某个版本的发行版
echo    4  检查发布状态          对比 GitHub 与 GitCode 两边的安装包是否一致
echo    5  从 GitHub 补同步      某个版本只在 GitHub 发过时,一键补齐 GitCode
echo    0  退出
echo !THIN!

rem  下面这段是给第一次用的人:告诉他还有什么别的入口。
echo   还不会打包? 先双击「构建应用.bat」,再用「启动应用.bat」试跑。
echo   完整菜单与命令说明请在工具里看,这里只是快捷提示。
echo.

echo   即将进入交互菜单 ^(在工具里按 0 退出^)...
echo.

call node "scripts\dfae-cli.mjs" %*
set "RC=!errorlevel!"

if "!RC!"=="0" goto :EXIT_OK
echo.
echo !THIN!
echo   [X] 工具异常退出 ^(退出码 !RC!^)。
echo       常见原因:网络/凭据问题、GitCode 令牌失效,或仓库里有冲突。
echo       按任意键关闭窗口...
pause >nul
exit /b !RC!

:EXIT_OK
echo.
echo   已退出管理工具。按任意键关闭窗口...
pause >nul
exit /b 0

rem ===============================================================
rem  出错分支:每条都给「怎么办」,而不只是「出错了」
rem ===============================================================
:NO_NODE
echo.
echo !RULE!
echo   [X] 没有找到 Node.js
echo !THIN!
echo    这个管理工具依赖 Node.js 才能跑。请先安装:
echo.
echo      1. 打开 https://nodejs.org/   ^(选 LTS 版本,20 或更高^)
echo      2. 一路「下一步」装完
echo      3. 关掉这个窗口,重新双击「管理工具.bat」
echo.
echo    如果已经装了却还是这个提示,说明没有重启终端,PATH 还没生效。
echo !RULE!
echo.
echo   按任意键关闭窗口...
pause >nul
exit /b 1

:NO_PROJECT
echo.
echo !RULE!
echo   [X] 当前目录不是项目根目录
echo !THIN!
echo    找不到 package.json。请确认:
echo      · 整个项目文件夹是完整拷贝的 ^(不要只拷 .bat^)
echo      · 「管理工具.bat」和 package.json 在同一层目录
echo.
echo    当前目录: %CD%
echo !RULE!
echo.
echo   按任意键关闭窗口...
pause >nul
exit /b 1

:NO_CLI
echo.
echo !RULE!
echo   [X] 缺少 scripts\dfae-cli.mjs
echo !THIN!
echo    这是管理工具的核心脚本,不在项目里就无法工作。
echo    处理办法:
echo      · 重新完整解压/克隆一次项目
echo      · 或从 GitHub 仓库把 scripts\ 目录补回来
echo.
echo    当前目录: %CD%
echo !RULE!
echo.
echo   按任意键关闭窗口...
pause >nul
exit /b 1