<#
  Android 侧环境与配置自检(不改任何文件,只读 + 打印)。
  用法(在工程根目录):
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-android.ps1

  设计前提:Android 构建需要 SDK/NDK 与 Rust 的 android 目标,这些东西本机不一定有,
  所以脚本**不因为缺失就退出**,而是把"缺什么、怎么补"逐条列出来。
#>
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Check($name, [bool]$ok, $hint) {
  if ($ok) { Write-Host ("  [OK]   " + $name) -ForegroundColor Green }
  else { Write-Host ("  [缺失] " + $name + "  ->  " + $hint) -ForegroundColor Yellow }
}

Write-Host '=== 1) Java(建议 JDK 17) ===' -ForegroundColor Cyan
$java = Get-Command java -ErrorAction SilentlyContinue
Check 'java' ([bool]$java) 'winget install EclipseAdoptium.Temurin.17.JDK'
if ($java) { & java -version 2>&1 | Select-Object -First 1 }
Write-Host ("  JAVA_HOME = " + $env:JAVA_HOME)

Write-Host '=== 2) Android SDK / NDK ===' -ForegroundColor Cyan
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
Check 'ANDROID_HOME / ANDROID_SDK_ROOT' ([bool]$sdk) '安装 Android Studio 或 cmdline-tools 后设置环境变量'
Check 'NDK_HOME' ([bool]$env:NDK_HOME) 'Android Studio -> SDK Manager -> NDK (Side by side)'
if ($sdk) { Write-Host ("  SDK = " + $sdk + "  存在: " + (Test-Path $sdk)) }
if ($env:NDK_HOME) { Write-Host ("  NDK = " + $env:NDK_HOME + "  存在: " + (Test-Path $env:NDK_HOME)) }

Write-Host '=== 3) adb(真机/模拟器都要) ===' -ForegroundColor Cyan
Check 'adb' ([bool](Get-Command adb -ErrorAction SilentlyContinue)) 'cmdline-tools -> platform-tools,或 Android Studio 自带'

Write-Host '=== 4) Rust android 目标 ===' -ForegroundColor Cyan
$rustup = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
if (Test-Path $rustup) {
  $targets = & $rustup target list --installed 2>$null
  foreach ($t in @('aarch64-linux-android', 'armv7-linux-androideabi', 'i686-linux-android', 'x86_64-linux-android')) {
    Check $t ($targets -contains $t) ("rustup target add " + $t)
  }
} else {
  Write-Host '  [缺失] rustup 未找到' -ForegroundColor Yellow
}

Write-Host '=== 5) 项目 Android 配置 ===' -ForegroundColor Cyan
Check 'src-tauri/tauri.conf.json' (Test-Path 'src-tauri\tauri.conf.json') ''
Check 'src-tauri/capabilities/mobile.json' (Test-Path 'src-tauri\capabilities\mobile.json') ''
Check 'src-tauri/src/main.rs 含 android_binding' ((Get-Content 'src-tauri\src\main.rs' -Raw) -match 'android_binding!') 'Android 入口宏缺失会导致链接失败'
Check 'gen/android 已生成(tauri android init)' (Test-Path 'src-tauri\gen\android') 'npm run tauri android init'

Write-Host '=== 6) 已连接设备 ===' -ForegroundColor Cyan
if (Get-Command adb -ErrorAction SilentlyContinue) {
  & adb devices
} else {
  Write-Host '  跳过(没有 adb)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '以上 [缺失] 项补齐后,依次执行:' -ForegroundColor Cyan
Write-Host '  npm run tauri android init      # 生成 gen/android(需要已连接设备或模拟器)'
Write-Host '  npm run tauri android dev       # 真机/模拟器热重载调试'
Write-Host '  npm run tauri android build -- --apk   # 出 APK'
