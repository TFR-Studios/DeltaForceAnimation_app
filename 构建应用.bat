@echo off
chcp 936 >nul 2>&1
setlocal EnableDelayedExpansion
title 三角洲行动动画编辑器 · 构建应用
cd /d "%~dp0"
set "ROOT=%~dp0"
if "!ROOT:~-1!"=="\" set "ROOT=!ROOT:~0,-1!"
set "RULE=  ================================================================"
set "THIN=  ----------------------------------------------------------------"

rem  说明:%ERRORLEVEL% 在 call 之后会被 call 内部任何一条成功命令清零,
rem  所以这里的判定一律用显式变量 RC（由子程序自己 set），不用 if errorlevel。

set "TOTAL=5"
call :BANNER
call :CHECK_ENV
if not "!RC!"=="0" goto :STOP

rem ---------- 探明这一次到底构建什么 ----------
set "DO_ANDROID=0"
set "DO_WIN=1"
set "MODE="
goto :ASK
:ASK
if not defined ASK_TRIES set "ASK_TRIES=0"
set /a ASK_TRIES+=1
echo   接下来要做什么?
echo.
echo      1  只打 Windows            免安装目录 + 便携版 + 一键安装包 ^(约 2~4 分钟^)
echo      2  Windows + Android APK   多加一个 arm64 release 包 ^(约 6~10 分钟^)
echo      3  只打 Android APK        只出 arm64 release APK,不动 Windows 包 ^(约 3~6 分钟^)
echo.
echo      直接回车 = 1 ^(只管 Windows^)
echo.
set "MODE="
set /p "MODE=  请输入 1、2 或 3 后回车: "
if "!MODE!"=="" goto :ASK_DEFAULT
if "!MODE!"=="1" goto :MODE_WIN
if "!MODE!"=="2" goto :MODE_BOTH
if "!MODE!"=="3" goto :MODE_ANDROID_ONLY
if /i "!MODE!"=="a" goto :MODE_ANDROID_ONLY
if /i "!MODE!"=="w" goto :MODE_WIN
echo   [i] 只认 1、2 或 3 ^(你输的是 "!MODE!"^).
echo.
if !ASK_TRIES! GEQ 3 goto :ASK_DEFAULT
goto :ASK
:ASK_DEFAULT
if not defined MODE set "MODE="
if "!MODE!"=="" echo   [i] 直接回车按默认:只打 Windows。
set "MODE=1"
goto :MODE_WIN
:MODE_ANDROID_ONLY
set "DO_WIN=0"
set "DO_ANDROID=1"
set "TOTAL=3"
goto :MODE_GO
:MODE_BOTH
set "DO_WIN=1"
set "DO_ANDROID=1"
set "TOTAL=6"
goto :MODE_GO
:MODE_WIN
set "DO_WIN=1"
set "TOTAL=5"
:MODE_GO
echo.

rem ---------- 依赖 ----------
if exist "node_modules\vite\bin\vite.js" goto :DEPS_SKIP
set "N=1"
echo.
echo   准备 · 安装依赖   首次需要联网下载,可能要几分钟...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call :RUN_LOG npm install --no-audit --no-fund
if not "!RC!"=="0" goto :DEPS_FAIL
echo       OK 依赖已安装
goto :BUILD_FRONTEND
:DEPS_SKIP
set "N=1"
echo   准备 · 依赖       OK 已就绪
goto :BUILD_FRONTEND
:DEPS_FAIL
echo.
echo   [X] 依赖安装失败
echo       常见原因:网络不通,或卡在从 GitHub 下载 Electron。
echo       对策:确认本目录下的 .npmrc 镜像配置可用后,重跑本脚本。
goto :FAIL

rem ---------- 前端:两个变体不能混用,各建一次 ----------
:BUILD_FRONTEND
if not "!DO_ANDROID!"=="1" goto :FRONTEND_WIN
echo.
set "N=1"
echo.
if not "!DO_WIN!"=="1" echo   准备 · 构建 Android 前端   tauri 变体...
if "!DO_WIN!"=="1" echo   准备 · 构建 Android 前端   tauri 变体,稍后会重建 Windows 变体...
call :RUN_LOG_TAURI npm run build
if not "!RC!"=="0" goto :A_FRONT_FAIL
echo       OK Android 前端已构建
if not "!DO_WIN!"=="1" goto :ICONS
goto :FRONTEND_WIN
:A_FRONT_FAIL
echo.
if not "!DO_WIN!"=="1" goto :A_FRONT_ABORT
echo   [!] Android 前端构建失败,本次自动跳过 APK,继续打 Windows 包。
set "DO_ANDROID=0"
goto :FRONTEND_WIN
:A_FRONT_ABORT
echo   [X] Android 前端构建失败。
echo       往上翻,看 tsc / vite 报的第一条错误。
goto :FAIL

:FRONTEND_WIN
echo.
set "N=1"
echo.
echo   [!N!/!TOTAL!] 构建 Windows 前端   类型检查 + Vite 打包...
call :RUN_LOG npm run build
if not "!RC!"=="0" goto :FRONTEND_FAIL
echo       OK Windows 前端已构建
goto :ICONS
:FRONTEND_FAIL
echo.
echo   [X] 前端构建失败
echo       往上翻,看 tsc / vite 报的第一条错误 ^(通常是某个类型不匹配^)。
echo       改完代码重跑本脚本即可,依赖不会重装。
goto :FAIL

rem ---------- 图标 ----------
:ICONS
if not "!DO_WIN!"=="1" goto :ICONS_SKIP
if exist "build\icon.ico" goto :ICONS_SKIP
echo.
set "N=2"
echo.
echo   [!N!/!TOTAL!] 生成应用图标   只在第一次需要...
call :RUN_LOG npm run icons
if not "!RC!"=="0" goto :ICONS_SOFTFAIL
echo       OK 图标已生成
goto :ANDROID_STEP
:ICONS_SKIP
set "N=2"
echo   [!N!/!TOTAL!] 图标       OK 已就绪
goto :ANDROID_STEP
:ICONS_SOFTFAIL
echo   [!] 图标生成失败,本次用 Electron 自带图标,不影响功能。

rem ---------- Android ----------
:ANDROID_STEP
if not "!DO_ANDROID!"=="1" goto :ANDROID_SKIP
echo.
set "N=3"
echo.
echo   [!N!/!TOTAL!] 打包 Android APK   arm64 release,首次编译较慢,别关窗口...
call :BUILD_ANDROID
if not "!RC!"=="0" goto :ANDROID_FAIL
echo       OK APK 已就绪
if not "!DO_WIN!"=="1" goto :CLEAN
goto :ANDROID_RESTORE
:ANDROID_FAIL
echo.
if not "!DO_WIN!"=="1" goto :ANDROID_ONLY_FAIL
echo   [!] Android APK 没打出来,本次只出 Windows 包。
echo       排查:在项目根目录执行  powershell -File scripts\verify-android.ps1
set "DO_ANDROID=0"
goto :ANDROID_RESTORE
:ANDROID_ONLY_FAIL
echo   [!] Android APK 没打出来 ^(本次只打了 Android,没有 Windows 包^)。
echo       排查:在项目根目录执行  powershell -File scripts\verify-android.ps1
goto :FAIL
:ANDROID_RESTORE
echo.
echo   -> 恢复 Windows 前端产物   刚被 Android 变体覆盖过...
call :RUN_LOG npm run build
if not "!RC!"=="0" goto :RESTORE_FAIL
echo       OK Windows 前端已恢复
goto :WIN_PACK
:RESTORE_FAIL
echo.
echo   [X] Windows 前端重建失败,已停止 ^(不会拿 tauri 变体去打 Windows 包^)。
goto :FAIL
:ANDROID_SKIP
set "N=3"
echo   [!N!/!TOTAL!] Android    · 本次跳过 ^(需要 APK 就重跑选 2 或 3^)

rem ---------- Windows 打包 ----------
:WIN_PACK
if not "!DO_WIN!"=="1" goto :CLEAN
echo.
set "N=4"
echo.
echo   [!N!/!TOTAL!] 打包 Windows   免安装目录 + 便携版 + 一键安装包...
call :RUN_LOG npx electron-builder --win --x64
if not "!RC!"=="0" goto :WINPACK_FAIL
echo       OK Windows 包已生成
goto :CLEAN
:WINPACK_FAIL
echo.
echo   [X] Windows 打包失败
echo       常见原因:release\win-unpacked 里的应用还开着 ^(先关掉应用^),或磁盘空间不足。
goto :FAIL

rem ---------- 清理 ----------
:CLEAN
echo.
if "!DO_WIN!"=="1" (set "N=5" & echo   [5/!TOTAL!] 清理旧版本安装包   release\ 里只保留当前版本...)
if not "!DO_WIN!"=="1" echo   清理旧版本安装包   release\ 里只保留当前版本...
call :RUN_LOG node scripts\clean-release.mjs
if not "!RC!"=="0" goto :CLEAN_SOFTFAIL
goto :DONE
:CLEAN_SOFTFAIL
echo   [!] 旧包清理失败,不影响本次产物;可手动删掉 release\ 下的旧版本 exe。

:DONE
call :SUMMARIZE
echo.
set "OPEN_IT="
set /p "OPEN_IT=  现在打开 release 文件夹看看产物吗?(y 打开,直接回车退出): "
if /i not "!OPEN_IT!"=="y" goto :BYE
start "" "!ROOT!\release"
:BYE
echo.
echo   构建结束,窗口可以关掉了(按任意键)。
pause >nul
exit /b 0

rem ===============================================================
rem  公共子程序
rem ===============================================================
:RC_OF
set "RC=%ERRORLEVEL%"
goto :EOF


rem  执行命令并把输出写进日志文件,失败时再整段回放。
rem  不能用「命令 2>&1 | more」:管道会走 cmd 的子进程,errorlevel 永远是 more 的 0,
rem  等于把所有失败都当成成功吞掉。
:RUN_LOG
set "RUN_LOG=release\.build-last.log"
if not exist "release" mkdir "release" >nul 2>&1
call %* >"!RUN_LOG!" 2>&1
set "RC=!ERRORLEVEL!"
chcp 936 >nul 2>&1
if "!RC!"=="0" del "!RUN_LOG!" >nul 2>&1
if "!RC!"=="0" goto :EOF
type "!RUN_LOG!"
goto :EOF

rem  同上,但先设好 tauri 的 android 前端构建环境变量。
:RUN_LOG_TAURI
set "TAURI_ENV_PLATFORM=android"
set "TAURI_ENV_ARCH=aarch64"
set "TAURI_ENV_FAMILY=unix"
set "TAURI_ENV_PLATFORM_VERSION=24"
set "TAURI_ENV_TARGET_TRIPLE=aarch64-linux-android"
call :RUN_LOG %*
set "TAURI_ENV_PLATFORM="
set "TAURI_ENV_ARCH="
set "TAURI_ENV_FAMILY="
set "TAURI_ENV_PLATFORM_VERSION="
set "TAURI_ENV_TARGET_TRIPLE="
goto :EOF
:BANNER
echo.
echo !RULE!
echo    三角洲行动动画编辑器  ·  构建应用
echo    Windows: 免安装目录 + 便携版单文件 + 一键安装包
echo    Android: arm64 release APK ^(可选,默认不打^)
echo !RULE!
set "RC=0"
goto :EOF

rem ===============================================================
rem  环境检查:Node、package.json、版本号一致性
rem ===============================================================
:CHECK_ENV
where node >nul 2>&1
if errorlevel 1 goto :NO_NODE
set "NODEV="
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODEV=%%v"
if not defined NODEV set "NODEV=(未知)"
if not exist "package.json" goto :NO_PKG
set "APPVER="
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "!ROOT!\package.json" 2^>nul') do set "APPVER=%%v"
if not defined APPVER set "APPVER=(未知)"
set "TAURIVER="
for /f "delims=" %%v in ('node -p "require(process.argv[1]).version" "!ROOT!\src-tauri\tauri.conf.json" 2^>nul') do set "TAURIVER=%%v"
echo.
echo   Node.js !NODEV!    版本 v!APPVER!
if not defined TAURIVER goto :ENV_OK
if "!TAURIVER!"=="!APPVER!" goto :ENV_OK
echo.
echo   [!] 版本号不一致: package.json = !APPVER!  tauri.conf.json = !TAURIVER!
echo       Windows 包用 package.json,Android 包用 tauri.conf.json。
echo       要发版请用「管理工具.bat -> 发布新版本」把两处对齐。
:ENV_OK
set "RC=0"
goto :EOF
:NO_NODE
echo.
echo   [X] 没有找到 Node.js
echo       本项目的构建脚本由 Node 驱动,必须先装:
echo         https://nodejs.org/   ^(选 LTS,20 或更高^)
echo       装完请重开一个新的命令行窗口,让 PATH 生效。
set "RC=1"
goto :EOF
:NO_PKG
echo.
echo   [X] 这个目录里没有 package.json
echo       请把本脚本放在项目根目录 ^(和 package.json 同级^) 再双击。
set "RC=1"
goto :EOF

rem ===============================================================
rem  Android 打包:挑 JDK 17 + NDK,构建后把 APK 复制到 release\
rem  结果写进 RC;主流程据此降级为「只出 Windows 包」。
rem ===============================================================
:BUILD_ANDROID
call :PREP_ANDROID
if not "!RC!"=="0" goto :BUILD_ANDROID_END
rem  首次跑安卓会先下载 Gradle,国内网络容易卡住,提前说清。
if exist "%USERPROFILE%\.gradle\wrapper\dists" goto :ANDROID_RUN
echo.
echo   [提示] 第一次打 Android 包要先下载 Gradle ^(约 140 MB^)。
echo          网络慢时会长时间停在 Downloading gradle-...zip,属正常现象,别急着关窗口。
echo.
:ANDROID_RUN
call :RUN_LOG npm run tauri android build -- --apk -t aarch64
if not "!RC!"=="0" goto :ANDROID_BUILD_FAIL
set "APKSRC=src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release.apk"
if not exist "!APKSRC!" goto :ANDROID_NO_APK
if not exist "release" mkdir "release" >nul 2>&1
set "APKDST=release\dfae-!APPVER!-arm64-v8a.apk"
copy /y "!APKSRC!" "!APKDST!" >nul
call :RC_OF
if not "!RC!"=="0" goto :ANDROID_COPY_FAIL
echo       APK: !APKDST!
goto :BUILD_ANDROID_END
:ANDROID_BUILD_FAIL
echo.
echo   [X] Android APK 打包失败
echo       NDK / 签名 / JDK 问题可执行 scripts\verify-android.ps1 排查。
goto :BUILD_ANDROID_END
:ANDROID_NO_APK
echo.
echo   [X] 没找到构建出的 APK
echo       预期位置: !APKSRC!
echo       去上面日志里找「Finished N APK at」,看 Gradle 实际写到了哪里。
set "RC=1"
goto :BUILD_ANDROID_END
:ANDROID_COPY_FAIL
echo.
echo   [X] 复制 APK 到 release\ 失败 ^(文件被占用或磁盘满^)。
set "RC=1"
:BUILD_ANDROID_END
goto :EOF

rem  Android 前置检查:SDK / NDK / 工程目录 / 签名 / 版本号 / JDK 17
:PREP_ANDROID
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;!PATH!"
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" echo       Rust: %USERPROFILE%\.cargo\bin
set "SDK=%LOCALAPPDATA%\Android\Sdk"
if defined LOCALAPPDATA goto :SDK_3
set "SDK=%USERPROFILE%\AppData\Local\Android\Sdk"
:SDK_3
if exist "!SDK!" goto :SDK_2
if not defined ANDROID_HOME goto :SDK_4
set "SDK=%ANDROID_HOME%"
:SDK_4
if exist "!SDK!" goto :SDK_2
if not defined ANDROID_SDK_ROOT goto :SDK_2
set "SDK=%ANDROID_SDK_ROOT%"
:SDK_2
if not exist "!SDK!" goto :NO_SDK
set "ANDROID_HOME=!SDK!"
set "ANDROID_SDK_ROOT=!SDK!"
set "NDKPATH="
if not exist "!SDK!\ndk\25.2.9519653" goto :NDK_ANY
set "NDKPATH=!SDK!\ndk\25.2.9519653"
:NDK_ANY
if not defined NDKPATH for /d %%d in ("!SDK!\ndk\*") do set "NDKPATH=%%~fd"
if not defined NDKPATH goto :NO_NDK
set "NDK_HOME=!NDKPATH!"
set "ANDROID_NDK_HOME=!NDKPATH!"
if not exist "src-tauri\gen\android" goto :NO_PROJ
if not exist "src-tauri\gen\android\keystore.properties" goto :NO_KEY
if not "!TAURIVER!"=="!APPVER!" goto :VER_MISMATCH
set "JAVA17="
if not exist "C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot\bin\java.exe" goto :JDK_2
set "JAVA17=C:\Program Files\Eclipse Adoptium\jdk-17.0.15.6-hotspot"
:JDK_2
if defined JAVA17 goto :JDK_OK
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-17*") do if not defined JAVA17 set "JAVA17=%%~fd"
:JDK_3
if defined JAVA17 goto :JDK_OK
for /d %%d in ("C:\Program Files\Java\jdk-17*") do if not defined JAVA17 set "JAVA17=%%~fd"
:JDK_4
if defined JAVA17 goto :JDK_OK
if not defined JAVA_HOME goto :JDK_OK
echo "!JAVA_HOME!" | findstr /i "17" >nul && set "JAVA17=!JAVA_HOME!"
:JDK_OK
if defined JAVA17 goto :JDK_USE
echo.
echo   [X] 没有找到 JDK 17 ^(Android Gradle 需要^)
echo       安装: winget install EclipseAdoptium.Temurin.17.JDK
set "RC=1"
goto :EOF
:JDK_USE
set "JAVA_HOME=!JAVA17!"
echo       JDK: !JAVA17!
echo       NDK: !NDKPATH!
set "RC=0"
goto :EOF
:NO_SDK
echo.
echo   [X] 找不到 Android SDK
echo       装好 Android Studio 并打开一次 SDK Manager,或设环境变量 ANDROID_HOME。
set "RC=1"
goto :EOF
:NO_NDK
echo.
echo   [X] 找不到 Android NDK
echo       位置: !SDK!\ndk
echo       Android Studio -> SDK Manager -> SDK Tools 里勾选 NDK 安装。
set "RC=1"
goto :EOF
:NO_PROJ
echo.
echo   [X] 缺少 src-tauri\gen\android 工程目录
echo       先在项目根目录执行: npm run tauri android init
set "RC=1"
goto :EOF
:NO_KEY
echo.
echo   [X] 缺少 Android 签名配置 src-tauri\gen\android\keystore.properties
echo       没有它打出来的包装不上、也升级不了。
set "RC=1"
goto :EOF
:VER_MISMATCH
echo.
echo   [X] 版本号不一致: package.json=!APPVER!  tauri.conf.json=!TAURIVER!
echo       先跑「管理工具.bat -> 发布新版本」对齐版本号,再回来构建。
set "RC=1"
goto :EOF

rem ===============================================================
rem  产物汇总
rem ===============================================================
:SUMMARIZE
set "OKCOUNT=0"
set "SETUP=release\DeltaForceAnimationEditor-Setup-!APPVER!.exe"
set "PORTABLE=release\DeltaForceAnimationEditor-Portable-!APPVER!.exe"
set "APK=release\dfae-!APPVER!-arm64-v8a.apk"
echo.
echo !RULE!
if not "!DO_WIN!"=="1" goto :SUM_TITLE_A_ONLY
echo   构建完成   版本 v!APPVER!
goto :SUM_TITLE_DONE
:SUM_TITLE_A_ONLY
echo   构建完成   版本 v!APPVER!   ^(仅 Android^)
:SUM_TITLE_DONE
echo !THIN!
if not "!DO_WIN!"=="1" goto :SUM_ANDROID
echo   Windows
if not exist "!SETUP!" goto :SUM_NO_SETUP
call :SIZE "!SETUP!"
echo     一键安装包    DeltaForceAnimationEditor-Setup-!APPVER!.exe   !SZ!   [推荐]
set /a OKCOUNT+=1
goto :SUM_PORTABLE
:SUM_NO_SETUP
echo     [!] 没找到一键安装包,请看上面的报错
:SUM_PORTABLE
if not exist "!PORTABLE!" goto :SUM_NO_PORTABLE
call :SIZE "!PORTABLE!"
echo     便携版单文件  DeltaForceAnimationEditor-Portable-!APPVER!.exe   !SZ!
set /a OKCOUNT+=1
goto :SUM_UNPACKED
:SUM_NO_PORTABLE
echo     [!] 没找到便携版,请看上面的报错
:SUM_UNPACKED
if not exist "release\win-unpacked" goto :SUM_NO_UNPACKED
echo     免安装目录    release\win-unpacked\   ^(整夹拷走即可,启动最快^)
set /a OKCOUNT+=1
:SUM_NO_UNPACKED
:SUM_ANDROID
echo   Android
if not exist "!APK!" goto :SUM_NO_APK
call :SIZE "!APK!"
echo     arm64 APK     dfae-!APPVER!-arm64-v8a.apk   !SZ!   ^(release 签名^)
set /a OKCOUNT+=1
goto :SUM_NEXT
:SUM_NO_APK
if not "!DO_ANDROID!"=="1" echo     本次未打包    ^(需要 APK 就重跑本脚本并选 2 或 3^)
if "!DO_ANDROID!"=="1" echo     [!] 本次没有产出 APK,请看上面的报错
:SUM_NEXT
echo !THIN!
echo   下一步
echo     运行看看      双击「启动应用.bat」
echo     自检          双击「应用自检.bat」
echo     发到 GitHub   双击「管理工具.bat」-> 选 2「发布新版本」
if not "!OKCOUNT!"=="0" goto :SUM_END
echo   [!] 一个产物都没生成,请按上面的提示排查。
:SUM_END
echo !RULE!
goto :EOF

rem  把 %~1 的大小算成整数 MB,结果放在 SZ
:SIZE
set "SZ_BYTES=0"
for %%F in ("%~1") do set "SZ_BYTES=%%~zF"
set /a SZ_MB=(!SZ_BYTES!+524288)/1048576
set "SZ=!SZ_MB! MB"
goto :EOF

rem ===============================================================
rem  收尾
rem ===============================================================
:STOP
echo.
echo   环境没准备好,已停止。按任意键关闭窗口...
pause >nul
exit /b 1

:FAIL
echo.
if not exist "release" goto :FAIL_LOG_SKIP
(echo    %DATE% %TIME%  构建失败)>> "release\build-log.txt"
:FAIL_LOG_SKIP
echo !THIN!
echo   [X] 构建中止。已经完成的步骤不受影响,修好后重新双击本脚本即可。
echo       日志追加: release\build-log.txt
echo.
echo   按任意键关闭窗口...
pause >nul
exit /b 1