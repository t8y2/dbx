param(
  [Parameter(Mandatory = $true)]
  [string] $Label,

  [switch] $ResetStats
)

$ErrorActionPreference = "Stop"

function Get-TotalCount($counts) {
  if ($null -eq $counts) {
    return 0
  }

  $sum = ($counts.PSObject.Properties | Measure-Object -Property Value -Sum).Sum
  if ($null -eq $sum) {
    return 0
  }
  return [long] $sum
}

function Get-SccacheStats {
  $json = sccache --show-stats --stats-format json | Out-String
  if ($LASTEXITCODE -ne 0) {
    throw "sccache failed to return JSON statistics."
  }

  $info = $json | ConvertFrom-Json
  return [pscustomobject]@{
    Hits = Get-TotalCount $info.stats.cache_hits.counts
    Misses = Get-TotalCount $info.stats.cache_misses.counts
    Writes = [long] $info.stats.cache_writes
    WriteErrors = [long] $info.stats.cache_write_errors
  }
}

if ($ResetStats) {
  sccache --zero-stats
  if ($LASTEXITCODE -ne 0) {
    throw "sccache failed to clear its statistics."
  }

  "## Win7 sccache retention probe" >> $env:GITHUB_STEP_SUMMARY
  "Runner image: $env:ImageOS $env:ImageVersion" >> $env:GITHUB_STEP_SUMMARY
  "" >> $env:GITHUB_STEP_SUMMARY
  "| Observation | Hits | Misses | Writes | Write errors |" >> $env:GITHUB_STEP_SUMMARY
  "| --- | ---: | ---: | ---: | ---: |" >> $env:GITHUB_STEP_SUMMARY
}

$before = Get-SccacheStats
$sourcePath = Join-Path $env:GITHUB_WORKSPACE ".sccache-win7-retention-probe.rs"
$outputDir = Join-Path $env:RUNNER_TEMP "sccache-win7-retention-probe"

Set-Content -LiteralPath $sourcePath -Encoding utf8NoBOM -Value @"
pub fn answer() -> u32 {
    42
}
"@
Remove-Item -LiteralPath $outputDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

sccache rustc `
  --crate-name dbx_sccache_retention_probe `
  --crate-type rlib `
  --edition 2021 `
  $sourcePath `
  --out-dir $outputDir
if ($LASTEXITCODE -ne 0) {
  throw "The Win7 sccache retention probe failed to compile."
}

$after = Get-SccacheStats
$hits = $after.Hits - $before.Hits
$misses = $after.Misses - $before.Misses
$writes = $after.Writes - $before.Writes
$writeErrors = $after.WriteErrors - $before.WriteErrors

"[WIN7-SCCACHE-PROBE] ${Label}: hits=$hits misses=$misses writes=$writes write_errors=$writeErrors"
"| $Label | $hits | $misses | $writes | $writeErrors |" >> $env:GITHUB_STEP_SUMMARY

