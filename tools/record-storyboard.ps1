<#
录一段带自动操作分镜的 GIF（零依赖：GDI 抓帧 + User32 输入 + UIAutomation 定位控件 + ffmpeg 压制）。

分镜（秒，可改脚本里 $actions）：
  2.6  点头像 → 3.6 点「设置」→ 5.0 点「会话换新」→ 6.4~10.8 面板滚动 → 11.6 Esc 关闭

用法：
  pwsh -File tools\record-storyboard.ps1                  # 16 秒
  pwsh -File tools\record-storyboard.ps1 -Seconds 24 -NoActions   # 只录不操作

输出 docs\img\demo.gif，自动压到 <=3 MB。
#>
[CmdletBinding()]
param(
    [int]$Seconds = 16,
    [int]$Fps = 10,
    [int]$StartDelay = 3,
    [int]$MaxWidth = 1000,
    [double]$MaxMB = 3,
    [string]$Out = "docs\img\demo.gif",
    [string]$Ffmpeg = "",
    [string]$WindowTitle = "DeepSeek Harness",
    [switch]$NoActions,
    [switch]$KeepFrames
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DemoWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr e);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
}
"@
try { [void][DemoWin]::SetProcessDpiAwareness(2) } catch { }

function Find-Ffmpeg {
    param([string]$Hint)
    if ($Hint -and (Test-Path $Hint)) { return (Resolve-Path $Hint).Path }
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($c in @('D:\tools\ffmpeg\bin\ffmpeg.exe',
                     'D:\RVC\RVC20260718Nvidia\ffmpeg.exe',
                     'D:\deepseek harness\work area\muse\tools\package\ffmpeg.exe')) {
        if (Test-Path $c) { return $c }
    }
    throw "找不到 ffmpeg，用 -Ffmpeg <路径> 指定"
}

$ff = Find-Ffmpeg -Hint $Ffmpeg
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repoRoot $Out }
$outDir = Split-Path -Parent $outPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

# ---------- 找窗口 ----------
$proc = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $WindowTitle } |
    Sort-Object { $_.MainWindowTitle.Length } | Select-Object -First 1
if (-not $proc) { throw "没有标题匹配 '$WindowTitle' 的窗口" }
$hwnd = [IntPtr]$proc.MainWindowHandle
Write-Host ("目标窗口: {0} (PID {1})" -f $proc.MainWindowTitle, $proc.Id) -ForegroundColor Cyan

function Get-ClientBox {
    $cr = New-Object DemoWin+RECT
    if (-not [DemoWin]::GetClientRect($hwnd, [ref]$cr)) { throw "GetClientRect 失败" }
    $pt = New-Object DemoWin+POINT
    [void][DemoWin]::ClientToScreen($hwnd, [ref]$pt)
    [pscustomobject]@{ X = $pt.X; Y = $pt.Y; W = ($cr.Right - $cr.Left); H = ($cr.Bottom - $cr.Top) }
}

# 清场：把可能开着的弹层关掉，并把窗口拉到前台
[void][DemoWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 300
[DemoWin]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[DemoWin]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
Start-Sleep -Milliseconds 700

for ($i = $StartDelay; $i -gt 0; $i--) {
    Write-Host ("`r{0} 秒后开始录制……  " -f $i) -NoNewline
    Start-Sleep -Seconds 1
}
[void][DemoWin]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 300
Write-Host "`r录制中。                " -ForegroundColor Green

$box = Get-ClientBox
if ($box.W -lt 400 -or $box.H -lt 300) { throw ("窗口太小: {0}x{1}" -f $box.W, $box.H) }
$ox = $box.X; $oy = $box.Y

# ---------- 操作分镜 ----------
function Click-Name([string]$name) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $e = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if (-not $e) { Write-Warning ("找不到控件: " + $name); return }
    $r = $e.Current.BoundingRectangle
    if ($r.Width -le 0) { Write-Warning ("控件没有矩形: " + $name); return }
    $cx = [int]($r.X + $r.Width / 2); $cy = [int]($r.Y + $r.Height / 2)
    [void][DemoWin]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 140
    [DemoWin]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    [DemoWin]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Write-Host ("  点击 " + $name + " @ " + $cx + "," + $cy)
}

function Invoke-Wheel([int]$notches) {
    $cx = $ox + [int]($box.W / 2); $cy = $oy + [int]($box.H * 0.62)
    [void][DemoWin]::SetCursorPos($cx, $cy)
    Start-Sleep -Milliseconds 120
    for ($k = 0; $k -lt [Math]::Abs($notches); $k++) {
        $delta = if ($notches -lt 0) { -120 } else { 120 }
        $wheelData = [System.BitConverter]::ToUInt32([System.BitConverter]::GetBytes([int]$delta), 0)
        [DemoWin]::mouse_event(0x0800, 0, 0, $wheelData, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 90
    }
}

function Invoke-Esc {
    [DemoWin]::keybd_event(0x1B, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [DemoWin]::keybd_event(0x1B, 0, 2, [IntPtr]::Zero)
}

$actions = @(
    @{ T = 2.6;  Do = { Click-Name "账号菜单" } },
    @{ T = 3.7;  Do = { Click-Name "设置" } },
    @{ T = 5.1;  Do = { Click-Name "会话换新" } },
    @{ T = 6.6;  Do = { Invoke-Wheel -3 } },
    @{ T = 7.6;  Do = { Invoke-Wheel -3 } },
    @{ T = 8.6;  Do = { Invoke-Wheel -3 } },
    @{ T = 9.6;  Do = { Invoke-Wheel -3 } },
    @{ T = 11.0; Do = { Invoke-Esc } },
    @{ T = 11.7; Do = { Invoke-Esc } }
)
if ($NoActions) { $actions = @() }

# ---------- 抓帧 ----------
$framesDir = Join-Path $env:TEMP ("dsh-story-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $framesDir | Out-Null

$intervalMs = [int](1000 / $Fps)
$total = $Seconds * $Fps
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$n = 0
$ai = 0
$bmp = $null
$gfx = $null
try {
    while ($n -lt $total) {
        $targetMs = $n * $intervalMs
        $wait = $targetMs - $sw.ElapsedMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }

        if (-not [DemoWin]::IsWindow($hwnd)) { Write-Warning "窗口已关闭，提前结束"; break }

        $b = Get-ClientBox
        if ($b.W -ne $box.W -or $b.H -ne $box.H -or $b.X -ne $box.X -or $b.Y -ne $box.Y) { $box = $b; $ox = $b.X; $oy = $b.Y }

        if ($null -eq $bmp -or $bmp.Width -ne $box.W -or $bmp.Height -ne $box.H) {
            if ($gfx) { $gfx.Dispose(); $bmp.Dispose() }
            $bmp = New-Object System.Drawing.Bitmap $box.W, $box.H, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        }
        $gfx.CopyFromScreen($box.X, $box.Y, 0, 0, (New-Object System.Drawing.Size $box.W, $box.H))
        $n++
        $bmp.Save((Join-Path $framesDir ("{0:D6}.png" -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)

        if ($n % ($Fps * 5) -eq 0) { Write-Host ("  已录 {0}/{1} 帧" -f $n, $total) }

        # 动作放在抓帧之后，尽量少掉帧
        $now = $sw.Elapsed.TotalSeconds
        while ($ai -lt $actions.Count -and $now -ge $actions[$ai].T) {
            & $actions[$ai].Do
            $ai++
            $now = $sw.Elapsed.TotalSeconds
        }
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
        -lavfi "$filter[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 $outPath
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg paletteuse 失败 ($LASTEXITCODE)" }
    $finalMB = (Get-Item $outPath).Length / 1MB
    Write-Host ("  试 {0}fps / {1}px → {2:N2} MB" -f $v.Fps, $v.W, $finalMB)
    if ($finalMB -le $MaxMB) { break }
}

Write-Host ""
Write-Host ("完成: {0}  ({1:N2} MB)" -f $outPath, $finalMB) -ForegroundColor Green
if (-not $KeepFrames) { Remove-Item $framesDir -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host "帧保留在: $framesDir" }

