[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
  throw "Windows 7 PE audit target does not exist: $BinaryPath"
}

$dumpbinCommand = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
$dumpbinPath = if ($null -ne $dumpbinCommand) { $dumpbinCommand.Source } else { $null }
if ($null -eq $dumpbinPath) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $visualStudio = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($visualStudio) {
      $dumpbin = Get-ChildItem (Join-Path $visualStudio "VC\Tools\MSVC") -Filter dumpbin.exe -Recurse |
        Where-Object { $_.FullName -match '\\bin\\Hostx64\\x64\\dumpbin\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
      if ($null -ne $dumpbin) {
        $dumpbinPath = $dumpbin.FullName
      }
    }
  }
}

if ($null -eq $dumpbinPath) {
  throw "Unable to find dumpbin.exe for the Windows 7 PE compatibility audit."
}

$imports = (& $dumpbinPath /nologo /imports $BinaryPath 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "dumpbin failed while auditing ${BinaryPath}:`n$imports"
}

$forbiddenImports = [ordered]@{
  "combase.dll" = "COMBASE is only available starting with Windows 8; use OLE32 imports."
  "api-ms-win-core-winrt-" = "WinRT API sets are unavailable on Windows 7."
  "CoIncrementMTAUsage" = "CoIncrementMTAUsage is unavailable on Windows 7."
  "EventSetInformation" = "EventSetInformation is unavailable on Windows 7. Use the legacy WebView2 loader."
  "GetSystemTimePreciseAsFileTime" = "GetSystemTimePreciseAsFileTime is unavailable on Windows 7."
  "GetDpiForWindow" = "GetDpiForWindow is unavailable on Windows 7."
  "GetSystemMetricsForDpi" = "GetSystemMetricsForDpi is unavailable on Windows 7."
  "SetThreadDpiAwarenessContext" = "SetThreadDpiAwarenessContext is unavailable on Windows 7."
  "VCRUNTIME140.dll" = "The Windows 7 package must not require a separately installed VC++ Runtime."
  "VCRUNTIME140_1.dll" = "The Windows 7 package must not require a separately installed VC++ Runtime."
  "MSVCP140.dll" = "The Windows 7 package must not require a separately installed VC++ Runtime."
  "ucrtbase.dll" = "The Windows 7 package must link the Universal CRT statically."
  "api-ms-win-crt-" = "The Windows 7 package must not require separately installed Universal CRT API sets."
}

$violations = @()
foreach ($entry in $forbiddenImports.GetEnumerator()) {
  if ($imports -match [regex]::Escape($entry.Key)) {
    $violations += "$($entry.Key): $($entry.Value)"
  }
}

if ($violations.Count -gt 0) {
  $summary = $violations -join "`n"
  Write-Host "Full PE import table for diagnosis:"
  Write-Host $imports
  throw "Windows 7 incompatible PE imports detected in ${BinaryPath}:`n$summary"
}

Write-Host "Windows 7 PE import audit passed: $BinaryPath"
