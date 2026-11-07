<#
Record the "Session rotate" settings demo as a GIF, fully headless (CDP).

Why this exists: tools\record-demo.ps1 grabs the screen (GDI), so any window that
overlaps the target gets recorded too - including the real workspace names and
session titles of whoever runs it. This script never looks at the screen: it boots
an isolated dsh web instance on a throwaway DSH_HOME, drives headless Chrome over
the CDP screenshot API, and only that page is captured.

Requirements: Node 22+ (built-in WebSocket, no npm install), ffmpeg, Chrome or Edge,
and `dsh` on PATH.

Usage:
  pwsh -File tools\record-cdp.ps1
  pwsh -File tools\record-cdp.ps1 -Out docs\img\demo.gif -Port 3399 -Keep
  pwsh -File tools\record-cdp.ps1 -DshHome D:\tmp\demo-home   # reuse a prepared HOME

First run installs the plugin into the throwaway HOME (needs network; pass
-SkipPluginInstall to skip) and writes that HOME's profile patch.
#>
[CmdletBinding()]
param(
    [int]$Port = 3399,
    [int]$CdpPort = 9222,
    [string]$Out = "docs\img\demo.gif",
    [Alias('Home')][string]$DshHome = "",
    [string]$PluginRef = "github:cry-flu/dsh-session-rotate",
    [string]$Chrome = "",
    [string]$Ffmpeg = "",
    [int]$Fps = 14,
    [switch]$Keep,
    [switch]$SkipPluginInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
# Default HOME deliberately sits outside the user profile: the settings page prints
# the config path in its "recent log" panel, and that path ends up in the GIF. No
# username, no repo path -> nothing personal on screen.
if (-not $DshHome) { $DshHome = Join-Path $env:ProgramData 'dsh-rotate-demo-home' }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$parentDir = Split-Path -Parent $DshHome
$leaf = Split-Path -Leaf $DshHome
$work = Join-Path $parentDir ($leaf + '-work')
$chromeProf = Join-Path $parentDir ($leaf + '-chrome')
New-Item -ItemType Directory -Force -Path $DshHome | Out-Null

function Find-Dsh {
    $c = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $c) { throw "dsh not found on PATH; install DeepSeek Harness or add dsh.cmd to PATH" }
    return $c.Source
}
function Find-Chrome {
    if ($Chrome) { return $Chrome }
    $cands = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($p in $cands) { if (Test-Path $p) { return $p } }
    throw "Chrome/Edge not found; pass -Chrome <path to chrome.exe>"
}
function Stop-Tree([int]$procId) {
    if ($procId -le 0) { return }
    try { & taskkill /PID $procId /T /F 2>&1 | Out-Null } catch {}
}
function Start-DshServer([string]$logBase) {
    $o = "$logBase.out.log"; $e = "$logBase.err.log"
    Remove-Item $o, $e -Force -ErrorAction SilentlyContinue
    $p = Start-Process -FilePath $dsh -ArgumentList @('web', '--port', "$Port", '--no-open') `
        -PassThru -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if ($p.HasExited) { break }
        if (Test-Path $o) {
            $hit = Select-String -Path $o -Pattern 'http://127\.0\.0\.1:\d+/\?token=\S+' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { return @{ Proc = $p; Url = $hit.Matches[0].Value; Out = $o } }
        }
        Start-Sleep -Milliseconds 300
    }
    Stop-Tree $p.Id
    $tail = if (Test-Path $e) { (Get-Content $e -Tail 8) -join "`n" } else { '' }
    throw "dsh web did not print a url within 60s. stderr:`n$tail"
}

$dsh = Find-Dsh
$chromeExe = Find-Chrome
$env:DSH_HOME = $DshHome
Write-Host "DSH_HOME : $DshHome"
Write-Host "dsh      : $dsh"
Write-Host "chrome   : $chromeExe"

# 1) one throwaway boot so storages\workspace.json exists
if (-not (Test-Path (Join-Path $DshHome 'storages\workspace.json'))) {
    Write-Host "[1/6] first boot to create storages..."
    $boot = Start-DshServer (Join-Path $DshHome 'boot')
    Stop-Tree $boot.Proc.Id
    Start-Sleep -Seconds 2
}

# 2) seed fake workspaces
Write-Host "[2/6] seeding demo workspaces..."
& node (Join-Path $PSScriptRoot 'seed-workspaces.cjs') --home $DshHome --work $work
if ($LASTEXITCODE -ne 0) { throw "seed-workspaces.cjs failed ($LASTEXITCODE)" }

# 3) plugin package for this throwaway HOME
$pluginDir = Join-Path $DshHome 'profiles\web\node_modules\dsh-session-rotate'
if (-not (Test-Path $pluginDir)) {
    if ($SkipPluginInstall) { throw "plugin not installed in $DshHome and -SkipPluginInstall was passed" }
    Write-Host "[3/6] installing plugin: $PluginRef ..."
    & $dsh plugin --profile web add $PluginRef
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin add failed ($LASTEXITCODE)" }
}

# 4) mount entry: the plugin ships an intentionally empty bundle patch, so the
#    insert has to live in the profile patch (same as a real user's setup).
$patchFile = Join-Path $DshHome 'profiles\web\cordis.patch.yml'
$patchBody = @'
# Written by tools\record-cdp.ps1 for a throwaway demo HOME.
- insert:
    - id: dsh-session-rotate
      name: dsh-session-rotate
      config:
        defaultMaxSteps: 40
        workspaces:
          - name: demo-app
            maxSteps: 20
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
'@
if (-not (Test-Path $patchFile) -or -not (Select-String -Path $patchFile -Pattern 'dsh-session-rotate' -Quiet)) {
    Set-Content -Path $patchFile -Value $patchBody -Encoding utf8
    Write-Host "[4/6] wrote mount entry -> $patchFile"
} else {
    Write-Host "[4/6] mount entry already present"
}

# 5) real boot; fail fast if the plugin did not mount (otherwise the settings tab
#    is missing and the recording silently captures the wrong page)
Write-Host "[5/6] starting dsh web on :$Port ..."
$srv = Start-DshServer (Join-Path $DshHome 'server')
if (-not (Select-String -Path $srv.Out -Pattern '\[session-rotate\]' -Quiet)) {
    $tail = (Get-Content $srv.Out -Tail 10) -join "`n"
    Stop-Tree $srv.Proc.Id
    throw "plugin did not load in $DshHome (settings tab would be missing). server log:`n$tail"
}
Write-Host "      url: $($srv.Url)"

# 6) headless Chrome + record
Write-Host "[6/6] starting headless chrome (cdp :$CdpPort) ..."
$chromeArgs = "--headless=new --remote-debugging-port=$CdpPort --user-data-dir=`"$chromeProf`" " +
    "--window-size=1200,900 --force-device-scale-factor=1 --hide-scrollbars --disable-gpu " +
    "--no-first-run --no-default-browser-check --disable-extensions about:blank"
$chr = Start-Process -FilePath $chromeExe -ArgumentList $chromeArgs -PassThru
$ok = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CdpPort/json/version" -UseBasicParsing -TimeoutSec 2
        $ok = $true; break
    } catch { Start-Sleep -Milliseconds 400 }
}
if (-not $ok) { Stop-Tree $chr.Id; Stop-Tree $srv.Proc.Id; throw "chrome CDP did not come up on :$CdpPort" }

try {
    Write-Host "      recording ..."
    Push-Location $repoRoot
    try {
        $nodeArgs = @((Join-Path $PSScriptRoot 'record-cdp.cjs'),
            '--url', $srv.Url, '--home', $DshHome, '--out', $Out,
            '--cdp-port', "$CdpPort", '--fps', "$Fps")
        if ($Ffmpeg) { $nodeArgs += @('--ffmpeg', $Ffmpeg) }
        if ($Keep) { $nodeArgs += '--keep' }
        & node @nodeArgs
        if ($LASTEXITCODE -ne 0) { throw "record-cdp.cjs failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
} finally {
    Stop-Tree $chr.Id
    Stop-Tree $srv.Proc.Id
}

$full = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repoRoot $Out }
if (Test-Path $full) {
    $mb = [math]::Round((Get-Item $full).Length / 1MB, 2)
    Write-Host ""
    Write-Host "done: $full ($mb MB)"
    Write-Host "check it before publishing: open the gif and look for real names/paths."
} else {
    Write-Host "recorded, but output not found at $full"
}
