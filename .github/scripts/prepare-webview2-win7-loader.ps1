[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# The Windows 7 / Server 2012 R2 bundle links the static loader from WebView2 SDK
# 1.0.902.49. Loaders >= 1.0.1054.31 import EventSetInformation, which Win7 and
# Server 2012 R2 do not provide, and fail with "Could not find the WebView2
# Runtime". The loader lives in vendor/webview2-com-sys/win7/x64/ and Cargo links
# it through the [patch.crates-io] entry. This script verifies the committed
# loader and stages the loader DLL for the runtime probe. It does not modify the
# Cargo registry, so compile caches stay correct.
$sdkVersion = "1.0.902.49"
$loaderSha256 = "aa5c26670f1b18d0fa2a56ac3f1ae30110c332a8bfbd555a7be3e548d1b0da3d"
$loaderDllSha256 = "fdf978ba706578b05967d7f0181f462147864a5aa74f36016a62cb3d3dbe6909"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$loaderDirectory = Join-Path $repositoryRoot "vendor/webview2-com-sys/win7/x64"
$loaderPath = Join-Path $loaderDirectory "WebView2LoaderStatic.lib"
$loaderDllPath = Join-Path $loaderDirectory "WebView2Loader.dll"

function Assert-FileHash {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Expected
  )
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Vendored Windows 7 WebView2 loader is missing: $Path"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) {
    throw "Unexpected Windows 7 WebView2 loader SHA256 for ${Path}: $actual"
  }
}

Assert-FileHash -Path $loaderPath -Expected $loaderSha256
Assert-FileHash -Path $loaderDllPath -Expected $loaderDllSha256

$probeDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-webview2-loader-probe"
New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
$probeLoader = Join-Path $probeDirectory "WebView2Loader.dll"
Copy-Item -LiteralPath $loaderDllPath -Destination $probeLoader -Force

Write-Host "Verified vendored WebView2 SDK $sdkVersion static loader: $loaderPath"
Write-Host "Staged WebView2 SDK $sdkVersion loader probe DLL: $probeLoader"
