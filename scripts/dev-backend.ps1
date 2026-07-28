param(
  [string]$RustLog = "info",
  [string]$DbxPassword = "test",
  [switch]$NoWatch,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $repoRoot

$env:RUST_LOG = $RustLog
$env:DBX_PASSWORD = $DbxPassword

Write-Host "[dbx-backend] repo: $repoRoot" -ForegroundColor Cyan
Write-Host "[dbx-backend] RUST_LOG=$env:RUST_LOG DBX_PASSWORD=$env:DBX_PASSWORD" -ForegroundColor DarkCyan

if ($DryRun) {
  if ($NoWatch) {
    Write-Host "[dbx-backend] dry run: cargo run -p dbx-web" -ForegroundColor Yellow
  } else {
    Write-Host "[dbx-backend] dry run: cargo watch -x 'run -p dbx-web' (fallback: cargo run -p dbx-web)" -ForegroundColor Yellow
  }
  exit 0
}

$watchAvailable = $false
if (-not $NoWatch) {
  try {
    & cargo watch --version *> $null
    $watchAvailable = ($LASTEXITCODE -eq 0)
  } catch {
    $watchAvailable = $false
  }
}

if ($watchAvailable) {
  Write-Host "[dbx-backend] starting: cargo watch -x 'run -p dbx-web'" -ForegroundColor Green
  & cargo watch -x "run -p dbx-web"
  exit $LASTEXITCODE
}

if (-not $NoWatch) {
  Write-Warning "cargo-watch is unavailable; falling back to cargo run -p dbx-web. Install with: cargo install cargo-watch"
}

Write-Host "[dbx-backend] starting: cargo run -p dbx-web" -ForegroundColor Green
& cargo run -p dbx-web
exit $LASTEXITCODE
