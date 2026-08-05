[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$installerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-installer-audit"
if (Test-Path -LiteralPath $installDirectory) {
  Remove-Item -LiteralPath $installDirectory -Recurse -Force
}

$installer = Start-Process -FilePath $installerPath -ArgumentList @("/S", "/D=$installDirectory") -Wait -PassThru
if ($installer.ExitCode -ne 0) {
  throw "Windows 7 test installer failed with exit code $($installer.ExitCode)."
}

$expectedFiles = @(
  (Join-Path $installDirectory "dbx.exe"),
  (Join-Path $installDirectory "webview2-fixed-runtime\msedgewebview2.exe"),
  (Join-Path $installDirectory "uninstall.exe")
)
foreach ($path in $expectedFiles) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Windows 7 test installer omitted required file: $path"
  }
}

Write-Host "Windows 7 installer content audit passed: $installerPath"

$uninstallerPath = Join-Path $installDirectory "uninstall.exe"
$uninstaller = Start-Process -FilePath $uninstallerPath -ArgumentList @("/S", "_?=$installDirectory") -Wait -PassThru
if ($uninstaller.ExitCode -ne 0) {
  Write-Warning "Windows 7 test uninstaller returned exit code $($uninstaller.ExitCode)."
}
