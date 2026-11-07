<#
录一个窗口的屏幕 GIF（零依赖：PowerShell + 系统 GDI 抓帧，ffmpeg 压制）。

用法（先摆好 DSH 窗口，然后跑）：
  pwsh -File tools\record-demo.ps1
  pwsh -File tools\record-demo.ps1 -Seconds 40 -StartDelay 8 -Out docs\img\demo.gif

默认录 30 秒、10 fps、前台窗口；输出 docs\img\demo.gif，自动压到 ≤3 MB。
#>
[CmdletBinding()]
param(
    [int]$Seconds = 30,
    [int]$Fps = 10,
    [int]$StartDelay = 5,
    [int]$MaxWidth = 1000,
    [double]$MaxMB = 3,
    [string]$WindowTitle = "",
    [string]$Out = "docs\img\demo.gif",
    [string]$Ffmpeg = "",
    [switch]$KeepFrames
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
}
"@

try { [void][Win32Cap]::SetProcessDpiAwareness(2) } catch { }   # 每显示器 DPI 感知，避免缩放糊

function Find-Ffmpeg {
    param([string]$Hint)
    if ($Hint -and (Test-Path $Hint)) { return (Resolve-Path $Hint).Path }
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        'D:\tools\ffmpeg\bin\ffmpeg.exe',
        'D:\RVC\RVC20260718Nvidia\ffmpeg.exe',
        'D:\deepseek harness\work area\muse\tools\package\ffmpeg.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    throw "找不到 ffmpeg。用 -Ffmpeg <路径> 指定，或 winget install --id Gyan.FFmpeg -e"
}

$ff = Find-Ffmpeg -Hint $Ffmpeg
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repoRoot $Out }
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ---------- 选窗口 ----------
Write-Host ""
Write-Host "== 录屏准备 ==" -ForegroundColor Cyan
for ($i = $StartDelay; $i -gt 0; $i--) {
    Write-Host ("`r请在 {0} 秒内切换到你<要录的窗口>……  " -f $i) -NoNewline
    Start-Sleep -Seconds 1
}
Write-Host "`r开始录制。                          " -ForegroundColor Green

$hwnd = [IntPtr]::Zero
if ($WindowTitle) {
    $m = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $WindowTitle } |
        Sort-Object { $_.MainWindowTitle.Length } | Select-Object -First 1
    if (-not $m) { throw "没有标题匹配 '$WindowTitle' 的窗口" }
    $hwnd = [IntPtr]$m.MainWindowHandle
    Write-Host ("按标题锁定: {0}" -f $m.MainWindowTitle)
}
else {
    $hwnd = [Win32Cap]::GetForegroundWindow()
}
if ($hwnd -eq [IntPtr]::Zero) { throw "拿不到目标窗口" }
$sb = New-Object System.Text.StringBuilder 256
[void][Win32Cap]::GetWindowText($hwnd, $sb, 256)
Write-Host ("目标窗口: {0} (0x{1:X})" -f $sb.ToString(), $hwnd.ToInt64())

function Get-ClientBox {
    param([IntPtr]$h)
    $cr = New-Object Win32Cap+RECT
    if (-not [Win32Cap]::GetClientRect($h, [ref]$cr)) { throw "GetClientRect 失败" }
    $pt = New-Object Win32Cap+POINT
    [void][Win32Cap]::ClientToScreen($h, [ref]$pt)
    [pscustomobject]@{
        X = $pt.X; Y = $pt.Y
        W = ($cr.Right - $cr.Left); H = ($cr.Bottom - $cr.Top)
    }
}

$box = Get-ClientBox $hwnd
if ($box.W -lt 200 -or $box.H -lt 150) { throw ("窗口太小: {0}x{1}" -f $box.W, $box.H) }
Write-Host ("画面 {0}x{1}，录 {2} 秒 @ {3} fps" -f $box.W, $box.H, $Seconds, $Fps)

$framesDir = Join-Path $env:TEMP ("dsh-demo-frames-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null

# ---------- 抓帧 ----------
$intervalMs = [int](1000 / $Fps)
$total = $Seconds * $Fps
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0
$bmp = $null
$gfx = $null

try {
    while ($n -lt $total) {
        $targetMs = $n * $intervalMs
        $wait = $targetMs - $sw.ElapsedMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }

        if (-not [Win32Cap]::IsWindow($hwnd)) { Write-Warning "窗口已关闭，提前结束"; break }

        $b = Get-ClientBox $hwnd
        if ($b.W -ne $box.W -or $b.H -ne $box.H -or $b.X -ne $box.X -or $b.Y -ne $box.Y) { $box = $b }

        if ($null -eq $bmp -or $bmp.Width -ne $box.W -or $bmp.Height -ne $box.H) {
            if ($gfx) { $gfx.Dispose(); $bmp.Dispose() }
            $bmp = New-Object System.Drawing.Bitmap $box.W, $box.H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        }
        $gfx.CopyFromScreen($box.X, $box.Y, 0, 0, (New-Object System.Drawing.Size $box.W, $box.H))
        $n++
        $bmp.Save((Join-Path $framesDir ("{0:D6}.png" -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)
        if ($n % ($Fps * 5) -eq 0) { Write-Host ("  已录 {0}/{1} 帧" -f $n, $total) }
    }
}
finally {
    if ($gfx) { $gfx.Dispose() }
    if ($bmp) { $bmp.Dispose() }
}

$got = (Get-ChildItem $framesDir -Filter *.png).Count
Write-Host ("抓帧完成: {0} 帧 → {1}" -f $got, $framesDir)
if ($got -lt 5) { throw "帧数太少（$got），录制失败" }

# ---------- 压制 ----------
$srcW = $box.W
$variants = @(
    @{ Fps = [Math]::Min($Fps, 12); W = [Math]::Min($MaxWidth, $srcW) },
    @{ Fps = 10; W = [Math]::Min(900, $srcW) },
    @{ Fps = 8;  W = [Math]::Min(800, $srcW) },
    @{ Fps = 6;  W = [Math]::Min(700, $srcW) }
)

$palette = Join-Path $framesDir 'palette.png'
$finalMB = 0
foreach ($v in $variants) {
    $filter = "fps=$($v.Fps),scale=$($v.W):-1:flags=lanczos"
    & $ff -y -hide_banner -loglevel error -framerate $Fps -i (Join-Path $framesDir '%06d.png') -vf "$filter,palettegen=stats_mode=diff" $palette
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg palettegen 失败 ($LASTEXITCODE)" }
    & $ff -y -hide_banner -loglevel error -framerate $Fps -i (Join-Path $framesDir '%06d.png') -i $palette `
        -lavfi "$filter[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 $outPath
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg paletteuse 失败 ($LASTEXITCODE)" }
    $finalMB = (Get-Item $outPath).Length / 1MB
    Write-Host ("  试 {0}fps / {1}px → {2:N2} MB" -f $v.Fps, $v.W, $finalMB)
    if ($finalMB -le $MaxMB) { break }
}

Write-Host ""
Write-Host ("完成: {0}  ({1:N2} MB)" -f $outPath, $finalMB) -ForegroundColor Green
if ($finalMB -gt $MaxMB) {
    Write-Warning ("仍超过 {0} MB —— 把 -Seconds 改短（比如 24），或换更小的窗口再录。" -f $MaxMB)
}
if (-not $KeepFrames) { Remove-Item $framesDir -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "帧保留在: $framesDir" }
