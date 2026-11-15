@echo off
chcp 936 >nul 2>&1
setlocal EnableDelayedExpansion
title 构建三角洲行动动画编辑器
cd /d "%~dp0"
set "ROOT=%~dp0"
if "!ROOT:~-1!"=="\" set "ROOT=!ROOT:~0,-1!"

echo.
echo  ================================================================
echo    三角洲行动动画编辑器
echo      A. Windows 应用 ^(免安装目录 + 便携版 + 一键安装包^)
echo      B. Android APK ^(arm64 release,可选,默认不打包^)
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
for /f "delims=" %%v in ('node -v 2^>nul') do echo  [0/6] Node.js %%v  OK
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "!ROOT!\package.json"') do set "APPVER=%%v"
if not defined APPVER set "APPVER=(unknown)"
echo  [0/6] 当前版本 v!APPVER!

rem ---------------------------------------------------------------
rem  询问是否顺带打安卓包。默认 N:安卓构建要 3~5 分钟且依赖 JDK/SDK/NDK,
rem  失败时不应该影响 Windows 包,所以放在最前面一次问清。
rem ---------------------------------------------------------------
set "ASK_ANDROID=N"
set "DO_ANDROID=0"
set /p "ASK_ANDROID=  另外打包 Android APK 吗?(输入 y 打包;直接回车只打 Windows): "
if /i "!ASK_ANDROID!"=="y" set "DO_ANDROID=1"
echo.
rem  空回车时 set /p 会把退出码留成 1，先清零，否则后面的 if errorlevel 1 会误判
cd /d "%~dp0"

if not exist "node_modules\vite\bin\vite.js" (
    echo  [1/6] 安装依赖 ^(首次需要联网,可能要几分钟^)...
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
    rem  前面命令可能留下非 0 退出码，这里清零，避免下面的 if errorlevel 误判
    ver >nul
    echo  [1/6] 依赖已就绪
)

echo  [2/6] 类型检查 + 构建前端产物...
call npx tsc
if errorlevel 1 (
    echo.
    echo  [X] 类型检查失败,请查看上面的错误信息。
    pause
    exit /b 1
)
rem  Android 的 Tauri 前端产物要按 tauri.conf.json 里的 tauri:xxxx 环境变量构建,
rem  Windows 的 Electron 产物不能带这些变量,所以在同一步里按需各构建一次。
set "TAURI_ENV=set TAURI_ENV_PLATFORM=android&& set TAURI_ENV_ARCH=aarch64&& set TAURI_ENV_FAMILY=unix&& set TAURI_ENV_PLATFORM_VERSION=24&& set TAURI_ENV_TARGET_TRIPLE=aarch64-linux-android"
set "SKIP_ANDROID_BUILD=0"
if "!DO_ANDROID!"=="1" (
    echo        Android 前端 ^(tauri 变体^)...
    cmd /c "set TAURI_ENV_PLATFORM=android&& set TAURI_ENV_ARCH=aarch64&& set TAURI_ENV_FAMILY=unix&& set TAURI_ENV_PLATFORM_VERSION=24&& set TAURI_ENV_TARGET_TRIPLE=aarch64-linux-android&& call npm run build"
    if errorlevel 1 (
        echo  [!] Android 前端构建失败,本次跳过 APK,继续打 Windows 包。
        set "DO_ANDROID=0"
    )
)
echo        Windows 前端 ^(electron 变体^)...
call npm run build
if errorlevel 1 (
    echo.
    echo  [X] 构建失败,请查看上面的错误信息。
    pause
    exit /b 1
)

if not exist "buildicon.ico" (
    echo  [3/6] 生成应用图标...
    call npm run icons
    if errorlevel 1 echo  [!] 图标生成失败,将使用 Electron 自带的默认图标。
) else (
    echo  [3/6] 图标已就绪
)

if "!DO_ANDROID!"=="1" (
    echo  [4/6] 打包 Android APK ^(arm64 release,约 3~5 分钟,首次更久^)...
    call :BUILD_ANDROID
    if errorlevel 1 (
        rem  安卓失败只提示,不中断:Windows 包才是必须出的那一个。
        echo  [!] Android APK 未生成,继续打 Windows 包。
    )
    rem  安卓之后前端产物已被换成 tauri 变体,再按 electron 变体重建一次,
    rem  否则 Windows 包会带上 tauri:xxxx 特性开关,行为与平时不一致。
    echo        恢复 Windows 前端产物...
    if errorlevel 1 (
        echo.
        echo  [X] Windows 前端重建失败,已停止。
        pause
        exit /b 1
    )
) else (
    echo  [4/6] 跳过 Android APK ^(需要时重跑本脚本并输入 y^)
)

echo  [5/6] 打包 Windows ^(免安装目录 + 便携版单文件 + 一键安装包,约 1~3 分钟^)...
call npx electron-builder --win --x64
if errorlevel 1 (
    echo.
    echo  [X] 打包失败,请查看上面的错误信息。
    pause
    exit /b 1
)

echo  [6/6] 清理旧版本安装包...
call node scripts\clean-release.mjs
if errorlevel 1 echo  [!] 旧包清理失败,不影响本次产物;可手动删除 release\ 下的旧版本 exe。

call :SUMMARIZE

echo.
pause
exit /b 0

rem ===============================================================
rem  Android 打包:挑 JDK 17、设好 NDK,构建后把 APK 复制到 release\
rem  任何一步失败都返回 1,由主流程降级为"只出 Windows 包"。
rem ===============================================================
:BUILD_ANDROID
set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined LOCALAPPDATA set "SDK=%USERPROFILE%\AppData\Local\Android\Sdk"
if not exist "!SDK!" if defined ANDROID_HOME set "SDK=%ANDROID_HOME%"
if not exist "!SDK!" if defined ANDROID_SDK_ROOT set "SDK=%ANDROID_SDK_ROOT%"
set "ANDROID_HOME=!SDK!"
set "ANDROID_SDK_ROOT=!SDK!"

set "NDKPATH="
for %%d in ("25.2.9519653") do if exist "!SDK!\ndk\%%~d" set "NDKPATH=!SDK!\ndk\%%~d"
if not defined NDKPATH for /d %%d in ("!SDK!\ndk\*") do set "NDKPATH=%%~fd"
if not defined NDKPATH (
    echo  [X] 找不到 Android NDK ^(!SDK!\ndk^)。
    echo      用 Android Studio SDK Manager 安装 NDK,或先跑 scripts\verify-android.ps1 看缺什么。
    exit /b 1
)
set "NDK_HOME=!NDKPATH!"
set "ANDROID_NDK_HOME=!NDKPATH!"

if not exist "src-tauri\gen\android" (
    echo  [X] 缺少 src-tauri\gen\android,先执行: npm run tauri android init
    exit /b 1
)
if not exist "src-tauri\gen\android\keystore.properties" (
    echo  [X] 缺少 Android 签名配置 src-tauri\gen\android\keystore.properties,打出来的包无法安装/升级。
    exit /b 1
)
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "!ROOT!\src-tauri\tauri.conf.json"') do set "TAURIVER=%%v"
if not "!TAURIVER!"=="!APPVER!" (
    echo  [X] 版本号不一致: package.json=!APPVER!  tauri.conf.json=!TAURIVER!  先跑 发布新版本.bat 对齐。
    exit /b 1
)
rem  Gradle 建议用 JDK 17;本机 JAVA_HOME 可能指向 21/8,这里单独挑一个 17。
set "JAVA17="
if exist "C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot\bin\java.exe" set "JAVA17=C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot"
if not defined JAVA17 for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-17*") do if not defined JAVA17 set "JAVA17=%%~fd"
if not defined JAVA17 for /d %%d in ("C:\Program Files\Java\jdk-17*") do if not defined JAVA17 set "JAVA17=%%~fd"
if not defined JAVA17 if defined JAVA_HOME echo "!JAVA_HOME!" | findstr /i "17" >nul && set "JAVA17=!JAVA_HOME!"
if not defined JAVA17 (
    echo  [X] 没有找到 JDK 17 ^(Android Gradle 推荐^)。
    echo      安装: winget install EclipseAdoptium.Temurin.17.JDK
    exit /b 1
)
set "JAVA_HOME=!JAVA17!"
echo        JDK:  !JAVA17!
echo        NDK:  !NDKPATH!

call npm run tauri android build -- --apk -t aarch64
if errorlevel 1 (
    echo  [X] Android APK 打包失败 ^(NDK/签名/JDK 问题可跑 scripts\verify-android.ps1 排查^)。
    exit /b 1
)

set "APKSRC=src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
if not exist "!APKSRC!" (
    echo  [X] 没找到构建出的 APK: !APKSRC!
    exit /b 1
)
if not exist "release" mkdir "release"
set "APKDST=release\dfae-!APPVER!-arm64-v8a.apk"
copy /y "!APKSRC!" "!APKDST!" >nul
if errorlevel 1 (
    echo  [X] 复制 APK 到 release\ 失败。
    exit /b 1
)
echo        APK:  !APKDST!
exit /b 0

rem ===============================================================
rem  产物汇总
rem ===============================================================
:SUMMARIZE
echo.
echo  ----------------------------------------------------------------
echo   完成!产物:
echo.
echo     Windows 一键安装包: release\DeltaForceAnimationEditor-Setup-!APPVER!.exe   ^(推荐,启动快^)
echo     Windows 便携版:     release\DeltaForceAnimationEditor-Portable-!APPVER!.exe
echo     Windows 免安装:     release\win-unpacked\   ^(整个文件夹拷走即可用^)
if exist "release\dfae-!APPVER!-arm64-v8a.apk" (
    echo     Android APK:        release\dfae-!APPVER!-arm64-v8a.apk   ^(仅 arm64^)
) else (
    echo     Android APK:        本次未打包 ^(重跑本脚本并输入 y^)
)
echo.
echo   版本: v!APPVER!   ^(旧版本安装包已自动清理^)
echo   双击「启动应用.bat」可直接运行 Windows 版。
echo  ----------------------------------------------------------------
exit /b 0
