# Publish a GitHub release for dsh-session-rotate using the git credential helper token.
# Usage: pwsh -File tools\release.ps1 -Version 1.4.1
# Requires: Nano TUN up (direct 443), git credential helper already storing the GitHub password.
param(
  [string]$Version = '1.4.1',
  [string]$Repo = 'cry-flu/dsh-session-rotate',
  [string]$NotesFile = '',
  [switch]$SkipTagCheck
)

$ErrorActionPreference = 'Stop'
$tag = "v$Version"
$tgz = "dsh-session-rotate-$Version.tgz"

# --- tag pre-check: never let the API create the tag for us ---
# If the tag is missing on origin, POST /releases defaults target_commitish=main and
# GitHub creates the tag at the remote HEAD, so the release silently points at an
# unrelated commit. Refuse instead of publishing that.
if (-not $SkipTagCheck) {
  $remoteTag = @(git ls-remote --tags origin "refs/tags/$tag" 2>$null) | Where-Object { $_ }
  if ($LASTEXITCODE -ne 0) { throw "git ls-remote failed: cannot verify $tag on origin (check network / Nano TUN)" }
  if (-not $remoteTag) {
    $localTag = git rev-parse -q --verify "refs/tags/$tag" 2>$null
    $hint = if ($localTag) {
      "tag exists locally but is not pushed - run: git push origin refs/tags/$tag"
    } else {
      "tag does not exist locally either - create it and push: git tag -a $tag -m $tag; git push origin refs/tags/$tag"
    }
    throw "tag $tag not found on origin; $hint. (override with -SkipTagCheck)"
  }
  Write-Host ("tag on origin: " + ($remoteTag -join ' | '))
}

if (-not (Test-Path $tgz)) { throw "missing package: $tgz (run npm pack first)" }
if ($NotesFile -eq '') {
  $cand = "release-notes-$tag.md"
  if (Test-Path $cand) { $NotesFile = $cand } else { $NotesFile = 'CHANGELOG.md' }
}
if (-not (Test-Path $NotesFile)) { throw "missing notes: $NotesFile" }

# --- token from git credential helper (never printed) ---
$credInput = "protocol=https`nhost=github.com`n`n"
$raw = ($credInput | git credential fill 2>$null) -join "`n"
$m = [regex]::Match($raw, '(?m)^password=(.+)$')
if (-not $m.Success) { throw 'no password from git credential fill for github.com' }
$token = $m.Groups[1].Value.Trim()
Write-Host ("token length: " + $token.Length)

$headers = @{
  Authorization          = "token $token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'dsh-session-rotate-release'
}

# --- create or reuse the release ---
$rel = $null
try {
  $rel = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $headers
  Write-Host "release $tag already exists (id $($rel.id))"
} catch {
  $notes = Get-Content $NotesFile -Raw -Encoding UTF8
  $payload = @{
    tag_name   = $tag
    name       = $tag
    body       = $notes
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json -Depth 4
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" `
    -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8'
  Write-Host "created release $tag (id $($rel.id))"
}

# --- upload the tarball (skip when present) ---
$existing = @($rel.assets) | Where-Object { $_.name -eq $tgz }
if ($existing) {
  Write-Host "asset already uploaded: $($existing.browser_download_url)"
} else {
  $uploadBase = ($rel.upload_url -replace '\{.*$', '')
  $uploadUri = "$uploadBase?name=$tgz"
  $up = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $headers -InFile $tgz -ContentType 'application/gzip'
  Write-Host "uploaded: $($up.browser_download_url)"
}

Write-Host "release page: https://github.com/$Repo/releases/tag/$tag"
