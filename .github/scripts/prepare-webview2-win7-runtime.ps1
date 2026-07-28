[CmdletBinding()]
param(
  [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA "tauri"),
  [string]$DownloadDirectory = $env:RUNNER_TEMP
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runtimeVersion = "109.0.1518.140"
$runtimeUrl = "https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/updt/2023/09/microsoftedgestandaloneinstallerx64_1c890b4b8dd6b7c93da98ebdc08ecdc5e30e50cb.exe"
$runtimeSha256 = "eac95c8095ec5f9971eade9827d8fb67fd251f5c16e702b5312d31067e39119b"
$evergreenUrl = "https://go.microsoft.com/fwlink/?linkid=2124701"

if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
  throw "A Tauri cache root is required."
}
if ([string]::IsNullOrWhiteSpace($DownloadDirectory)) {
  $DownloadDirectory = [System.IO.Path]::GetTempPath()
}

New-Item -ItemType Directory -Force -Path $DownloadDirectory | Out-Null
$downloadPath = Join-Path $DownloadDirectory "MicrosoftEdgeWebView2Runtime-$runtimeVersion-x64.exe"

if (Test-Path $downloadPath) {
  $downloadHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadHash -ne $runtimeSha256) {
    Remove-Item -LiteralPath $downloadPath -Force
  }
}

if (!(Test-Path $downloadPath)) {
  Write-Host "Downloading WebView2 Runtime $runtimeVersion for Windows 7..."
  Invoke-WebRequest -Uri $runtimeUrl -OutFile $downloadPath
}

$actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $runtimeSha256) {
  throw "WebView2 Runtime SHA-256 mismatch. Expected $runtimeSha256, got $actualHash."
}

# Tauri 2.11 does not expose an offline-installer path override. It resolves the
# Evergreen URL and reuses a matching cache entry, so place the verified 109
# installer at that exact location before bundling.
$response = Invoke-WebRequest -Uri $evergreenUrl -Method Head
$resolvedUrl = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
$match = [regex]::Match(
  $resolvedUrl,
  "/filestreamingservice/files/(?<guid>[^/]+)/(?<filename>[^/?]+)"
)
if (!$match.Success) {
  throw "Unexpected Evergreen WebView2 URL: $resolvedUrl"
}

$cacheDirectory = Join-Path $CacheRoot (Join-Path "x64" $match.Groups["guid"].Value)
$cachePath = Join-Path $cacheDirectory $match.Groups["filename"].Value
New-Item -ItemType Directory -Force -Path $cacheDirectory | Out-Null
Copy-Item -LiteralPath $downloadPath -Destination $cachePath -Force

$cacheHash = (Get-FileHash -LiteralPath $cachePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cacheHash -ne $runtimeSha256) {
  throw "Cached WebView2 Runtime SHA-256 mismatch. Expected $runtimeSha256, got $cacheHash."
}

Write-Host "Prepared WebView2 Runtime $runtimeVersion at $cachePath"
