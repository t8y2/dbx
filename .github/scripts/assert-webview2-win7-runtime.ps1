[CmdletBinding()]
param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot "..\..\src-tauri\webview2-fixed-runtime"),
  [string]$LoaderPath = (Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-webview2-loader-probe\WebView2Loader.dll"),
  [string]$ExpectedVersion = "109.0.1518.78"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runtimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$runtimeExecutable = Join-Path $runtimeDirectory "msedgewebview2.exe"
if (!(Test-Path -LiteralPath $runtimeExecutable -PathType Leaf)) {
  throw "WebView2 fixed runtime executable does not exist: $runtimeExecutable"
}

$loaderPath = (Resolve-Path -LiteralPath $LoaderPath).Path
$escapedLoaderPath = $loaderPath.Replace('"', '""')
$source = @"
using System;
using System.Runtime.InteropServices;

public static class DbxWebView2LoaderProbe
{
    [DllImport(@"$escapedLoaderPath", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int GetAvailableCoreWebView2BrowserVersionString(
        string browserExecutableFolder,
        out IntPtr versionInfo);
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$versionPointer = [IntPtr]::Zero
$result = [DbxWebView2LoaderProbe]::GetAvailableCoreWebView2BrowserVersionString(
  $runtimeDirectory,
  [ref]$versionPointer
)
if ($result -ne 0) {
  throw "WebView2 loader failed to recognize fixed runtime at $runtimeDirectory (HRESULT 0x$($result.ToString('X8')))."
}
if ($versionPointer -eq [IntPtr]::Zero) {
  throw "WebView2 loader returned an empty version pointer for $runtimeDirectory."
}

try {
  $version = [Runtime.InteropServices.Marshal]::PtrToStringUni($versionPointer)
}
finally {
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($versionPointer)
}

if ([string]::IsNullOrWhiteSpace($version) -or !$version.StartsWith($ExpectedVersion)) {
  throw "Expected WebView2 fixed runtime $ExpectedVersion, detected '$version'."
}

Write-Host "WebView2 fixed runtime probe passed: loader=$loaderPath runtime=$runtimeDirectory version=$version"
