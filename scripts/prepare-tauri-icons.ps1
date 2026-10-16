<#
  Prepare Tauri icon files (Windows PowerShell 5.1 safe: ASCII only).
  Source : build/icon.png (256x256, already in repo) + build/icon.ico  -> electron assets untouched.
  Output : src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.png,icon.ico,icon.icns}
  Note   : icon.icns is only needed for macOS bundling; a PNG stand-in is fine for Windows dev preview.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$srcPng = Join-Path $root 'build/icon.png'
$srcIco = Join-Path $root 'build/icon.ico'
$outDir = Join-Path $root 'src-tauri/icons'

if (-not (Test-Path $srcPng)) { throw "missing: $srcPng" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

Add-Type -AssemblyName System.Drawing
function New-ResizedPng([string]$src, [string]$dst, [int]$size) {
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($img, 0, 0, $size, $size)
    $g.Dispose()
    $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $img.Dispose() }
  Write-Host "generated $dst"
}

New-ResizedPng $srcPng (Join-Path $outDir '32x32.png') 32
New-ResizedPng $srcPng (Join-Path $outDir '128x128.png') 128
New-ResizedPng $srcPng (Join-Path $outDir '128x128@2x.png') 256
New-ResizedPng $srcPng (Join-Path $outDir 'icon.png') 256
if (Test-Path $srcIco) {
  Copy-Item $srcIco (Join-Path $outDir 'icon.ico') -Force
  Write-Host "generated $(Join-Path $outDir 'icon.ico') (copied from build/icon.ico)"
}
# macOS placeholder; never read on Windows.
Copy-Item (Join-Path $outDir 'icon.png') (Join-Path $outDir 'icon.icns') -Force
Write-Host 'icons ready.'
