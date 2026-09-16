[CmdletBinding()]
param(
  [string]$RuntimeDirectory = (Join-Path $PSScriptRoot "..\..\src-tauri\webview2-fixed-runtime"),
  [string]$LoaderPath = (Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-webview2-loader-probe\WebView2Loader.dll"),
  [string]$ExpectedVersion = "109.0.1518.78"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$os = [System.Environment]::OSVersion.Version
if ($os.Major -ne 6 -or ($os.Minor -ne 1 -and $os.Minor -ne 3)) {
  throw "The offline runtime probe requires Windows 7 or Server 2012 R2 (kernel 6.1/6.3), detected $($os.ToString())."
}

$runtimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
$loaderPath = (Resolve-Path -LiteralPath $LoaderPath).Path
$runtimeExecutable = Join-Path $runtimeDirectory "msedgewebview2.exe"
if (!(Test-Path -LiteralPath $runtimeExecutable -PathType Leaf)) {
  throw "WebView2 fixed runtime executable does not exist: $runtimeExecutable"
}

$escapedLoaderPath = $loaderPath.Replace('"', '""')
$source = @"
using System;
using System.Runtime.InteropServices;

public static class DbxServer2012WebView2Probe
{
    [DllImport(@"$escapedLoaderPath", CharSet = CharSet.Unicode, ExactSpelling = true)]
    public static extern int GetAvailableCoreWebView2BrowserVersionString(
        string browserExecutableFolder,
        out IntPtr versionInfo);
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$versionPointer = [IntPtr]::Zero
$result = [DbxServer2012WebView2Probe]::GetAvailableCoreWebView2BrowserVersionString(
  $runtimeDirectory,
  [ref]$versionPointer
)

$resultHex = [System.BitConverter]::ToUInt32(
  [System.BitConverter]::GetBytes([int32]$result),
  0
)
$hresult = "0x{0:X8}" -f $resultHex
if ($result -ne 0) {
  throw "Server 2012 R2 WebView2 loader rejected the fixed runtime with HRESULT $hresult."
}
if ($versionPointer -eq [IntPtr]::Zero) {
  throw "Server 2012 R2 WebView2 loader returned an empty version pointer."
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

Write-Host "Server 2012 R2 WebView2 runtime probe passed: loader=$loaderPath runtime=$runtimeDirectory version=$version"
