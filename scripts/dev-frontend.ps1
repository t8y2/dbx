param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $repoRoot

Write-Host "[dbx-frontend] repo: $repoRoot" -ForegroundColor Cyan

if ($DryRun) {
  Write-Host "[dbx-frontend] dry run: pnpm.cmd run dev:web" -ForegroundColor Yellow
  exit 0
}

Write-Host "[dbx-frontend] starting: pnpm.cmd run dev:web" -ForegroundColor Green
& pnpm.cmd run dev:web
exit $LASTEXITCODE
