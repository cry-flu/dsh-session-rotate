<#
  Recompute one row of the "measured reference" table in README.md / README.en.md
  from a platform usage export (usage_data_<from>_<to>.zip, or an already-extracted folder).

  Usage:
    pwsh -File tools\usage-summary.ps1 -Path E:\download\usage_data_2026-11-07_2026-11-07.zip
    pwsh -File tools\usage-summary.ps1 -Path .\usage-raw\1107

  Inputs (found anywhere under the given folder):
    amount-*.csv : columns type, amount ; types used here are
                   input_cache_hit_tokens / input_cache_miss_tokens / output_tokens / request_count
    cost-*.csv   : column cost, currency (CNY) ; every row is summed

  Definitions:
    requests      = sum(amount where type = request_count)
    total tokens  = sum(hit) + sum(miss) + sum(output)
    cache hit %   = sum(hit) / (sum(hit) + sum(miss)) * 100
    cost          = sum(cost)                      (CNY)
    tokens/req    = total tokens / requests
    cost/100 req  = cost / requests * 100

  Output: one markdown table row, then a diagnostic block (per-type sums, hour buckets, row counts).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'

function Resolve-InputDir {
  param([string]$p)
  if (Test-Path -LiteralPath $p -PathType Container) { return (Resolve-Path -LiteralPath $p).Path }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "path not found: $p" }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('usage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Expand-Archive -LiteralPath $p -DestinationPath $tmp -Force
  return $tmp
}

$dir = Resolve-InputDir $Path
$amountFile = @(Get-ChildItem -LiteralPath $dir -Filter 'amount-*.csv' -Recurse -File) | Select-Object -First 1
$costFile   = @(Get-ChildItem -LiteralPath $dir -Filter 'cost-*.csv'   -Recurse -File) | Select-Object -First 1
if (-not $amountFile) { throw "amount-*.csv not found under $dir" }
if (-not $costFile)   { throw "cost-*.csv not found under $dir" }

$amountRows = Import-Csv -LiteralPath $amountFile.FullName
$costRows   = Import-Csv -LiteralPath $costFile.FullName

function Get-TypeSum {
  param($rows, [string]$type)
  $hit = @($rows | Where-Object { $_.type -eq $type })
  if ($hit.Count -eq 0) { return [double]0 }
  return [double](($hit | Measure-Object -Property amount -Sum).Sum)
}

$hit    = Get-TypeSum $amountRows 'input_cache_hit_tokens'
$miss   = Get-TypeSum $amountRows 'input_cache_miss_tokens'
$output = Get-TypeSum $amountRows 'output_tokens'
$req    = Get-TypeSum $amountRows 'request_count'

$cost = [double]0
foreach ($r in $costRows) { $cost += [double]$r.cost }

if ($req -le 0) { throw "request_count sum is zero - is this the right export?" }

$total      = $hit + $miss + $output
$hitPct     = 100.0 * $hit / ($hit + $miss)
$perReq     = $total / $req
$per100Cost = $cost / $req * 100.0

$day = ''
if ($amountRows.Count -gt 0 -and $amountRows[0].start_time_iso) { $day = $amountRows[0].start_time_iso.Substring(0, 10) }

$n0 = { param($v) ([double]$v).ToString('N0', [System.Globalization.CultureInfo]::InvariantCulture) }
$n4 = { param($v) ([double]$v).ToString('0.####', [System.Globalization.CultureInfo]::InvariantCulture) }
$n3 = { param($v) ([double]$v).ToString('0.000', [System.Globalization.CultureInfo]::InvariantCulture) }
$pct = { param($v) (([double]$v).ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)) + '%' }

$row = '| {0} | {1} | {2} | {3} | {4} | {5} | {6} |' -f `
  $day, (& $n0 $req), (& $n0 $total), (& $pct $hitPct), (& $n4 $cost), (& $n0 $perReq), (& $n3 $per100Cost)

Write-Output $row
Write-Output ''
Write-Output '--- diagnostics ---'
Write-Output ("source        : {0}" -f $dir)
Write-Output ("amount csv    : {0} ({1} rows)" -f $amountFile.Name, $amountRows.Count)
Write-Output ("cost csv      : {0} ({1} rows)" -f $costFile.Name, $costRows.Count)
Write-Output ("input_cache_hit_tokens  : {0}" -f (& $n0 $hit))
Write-Output ("input_cache_miss_tokens : {0}" -f (& $n0 $miss))
Write-Output ("output_tokens           : {0}" -f (& $n0 $output))
Write-Output ("request_count           : {0}" -f (& $n0 $req))
Write-Output ("cost (CNY)              : {0}" -f (& $n4 $cost))
Write-Output ("cache hit rate          : {0}  (hit / (hit + miss))" -f (& $pct $hitPct))
$currencies = @($costRows | Group-Object currency | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join ', '
Write-Output ("cost currencies         : {0}" -f $currencies)
$hours = (($amountRows | Where-Object { $_.type -eq 'request_count' } | ForEach-Object { $_.end_time_iso }) | Sort-Object -Unique).Count
Write-Output ("hour buckets            : {0}" -f $hours)
