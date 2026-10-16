<#
  Tauri 侧本地校验脚本(只读式:编译 + 静态检查,不打包、不动 electron/src/animations)。
  用法(在工程根目录):
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-tauri.ps1
  依次做四件事:
      1) Rust / cargo / MSVC 环境自检;
      2) cargo check 编译整套 Rust 代码(含 httpd.rs / downloads.rs / ipc.rs);
      3) tauri info 打印解析后的配置(端口、入口、前端来源);
      4) cargo test 跑内置单元测试(文件名收敛 / 唯一落点 / 时间戳等纯函数)。
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host '=== 1/4 环境自检 ===' -ForegroundColor Cyan
foreach ($cmd in @('rustc', 'cargo')) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host ("  [OK]   " + $cmd + "  " + (& $cmd --version))
  } else {
    Write-Host ("  [缺失] " + $cmd + "  —— 请先安装 https://win.rustup.rs 并重开终端") -ForegroundColor Red
    exit 1
  }
}
Write-Host '  (MSVC 链接器由 cargo check 阶段间接验证)'

Write-Host '=== 2/4 cargo check ===' -ForegroundColor Cyan
Push-Location (Join-Path $root 'src-tauri')
try {
  cargo check --all-targets
  if ($LASTEXITCODE -ne 0) { throw "cargo check 失败(exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host '=== 3/4 tauri info ===' -ForegroundColor Cyan
npm run tauri -- info

Write-Host '=== 4/4 cargo test(纯函数单测) ===' -ForegroundColor Cyan
Push-Location (Join-Path $root 'src-tauri')
try {
  cargo test --lib
  if ($LASTEXITCODE -ne 0) { throw "cargo test 失败(exit $LASTEXITCODE)" }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '全部通过:接下来直接 npm run tauri dev 起窗口。' -ForegroundColor Green
