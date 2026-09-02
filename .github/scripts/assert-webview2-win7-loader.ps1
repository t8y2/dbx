[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The Win7 / Server 2012 R2 bundle must statically link the WebView2 loader from
# SDK 1.0.902.49, the last one verified to work on kernel 6.1/6.3. Loader
# 1.0.1054.31 and everything newer fail on Server 2012 R2 with
# ERROR_NOT_SUPPORTED (0x80070032, MicrosoftEdge/WebView2Feedback#2025) and make
# the app show "Could not find the WebView2 Runtime". Those loaders carry error
# strings that 1.0.902.49 does not, so any of the markers below appearing in
# dbx.exe proves the pinned loader was not the one linked. The PE import audit
# cannot catch this: 1.0.1054.31 imports nothing newer than 1.0.902.49.
$loaderMarkers = @(
  "WebView2: Failed to find the app exe path.",
  "WebView2: Failed to find the WebView2 client dll at:",
  "WebView2: Failed to find an installed WebView2 runtime or non-stable Microsoft Edge installation."
)

if (!(Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
  throw "Win7 WebView2 loader audit target does not exist: $BinaryPath"
}

$resolvedPath = (Resolve-Path -LiteralPath $BinaryPath).Path
# Map every byte to one character so the ASCII needle search cannot miss on
# arbitrary binary content.
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$content = $latin1.GetString([System.IO.File]::ReadAllBytes($resolvedPath))

$violations = @()
foreach ($marker in $loaderMarkers) {
  if ($content.Contains($marker)) {
    $violations += $marker
  }
}

if ($violations.Count -gt 0) {
  $summary = $violations -join "`n"
  throw @"
dbx.exe contains WebView2 loader strings newer than the pinned 1.0.902.49:
$summary

A loader >= 1.0.1054.31 was linked instead of the prepared one and will fail on
Server 2012 R2 with ERROR_NOT_SUPPORTED. Do not ship this binary: rebuild the
win7 target and investigate how the registry loader patch was bypassed.
"@
}

Write-Host "Win7 WebView2 loader audit passed: no post-1.0.902.49 loader markers in $resolvedPath"
