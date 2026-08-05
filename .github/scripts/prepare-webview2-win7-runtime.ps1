[CmdletBinding()]
param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot "..\..\src-tauri\webview2-fixed-runtime"),
  [string]$DownloadDirectory = $env:RUNNER_TEMP
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runtimeVersion = "109.0.1518.78"
$runtimeFolderName = "Microsoft.WebView2.FixedVersionRuntime.$runtimeVersion.x64"
$archiveName = "$runtimeFolderName.cab"
$runtimeUrl = "https://github.com/westinyang/WebView2RuntimeArchive/releases/download/$runtimeVersion/$archiveName"
$runtimeSha256 = "7622281cf83de1a35e3a471f432f7a897d65f0a7d3975df08512b7b253dd45c7"

if ([string]::IsNullOrWhiteSpace($RuntimeDirectory)) {
  throw "A WebView2 fixed runtime directory is required."
}
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
  $DownloadDirectory = [System.IO.Path]::GetTempPath()
}

New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null
$archivePath = Join-Path $DownloadDirectory $archiveName

if (Test-Path $archivePath) {
  $downloadHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadHash -ne $runtimeSha256) {
    Remove-Item -LiteralPath $archivePath -Force
  }
}

if (!(Test-Path $archivePath)) {
  Write-Host "Downloading WebView2 fixed runtime $runtimeVersion for Windows 7..."
  Invoke-WebRequest -Uri $runtimeUrl -OutFile $archivePath
}

$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $runtimeSha256) {
  throw "WebView2 fixed runtime SHA-256 mismatch. Expected $runtimeSha256, got $actualHash."
}

# Microsoft no longer publishes old Fixed Version downloads. The archive is
# accepted only when both its pinned hash and original Microsoft signature match.
$signature = Get-AuthenticodeSignature -LiteralPath $archivePath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
  throw "WebView2 fixed runtime does not have a valid Microsoft signature."
}

$extractDirectory = Join-Path $DownloadDirectory "dbx-webview2-fixed-runtime-$runtimeVersion"
if (Test-Path $extractDirectory) {
  Remove-Item -LiteralPath $extractDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $extractDirectory | Out-Null

$expand = Join-Path $env:SystemRoot "System32\expand.exe"
& $expand $archivePath "-F:*" $extractDirectory
if ($LASTEXITCODE -ne 0) {
  throw "Failed to extract WebView2 fixed runtime archive (exit code $LASTEXITCODE)."
}

$extractedRuntime = Join-Path $extractDirectory $runtimeFolderName
$runtimeExecutable = Join-Path $extractedRuntime "msedgewebview2.exe"
if (!(Test-Path $runtimeExecutable)) {
  throw "Extracted WebView2 runtime is missing msedgewebview2.exe."
}

if (Test-Path $RuntimeDirectory) {
  Remove-Item -LiteralPath $RuntimeDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RuntimeDirectory) | Out-Null
Move-Item -LiteralPath $extractedRuntime -Destination $RuntimeDirectory

Write-Host "Prepared WebView2 fixed runtime $runtimeVersion at $RuntimeDirectory"
