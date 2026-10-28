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

# Main-thread stack reserve audit. The app needs the 8 MiB stack that
# .cargo/config.toml applies to the standard Windows target; the legacy target is
# built with an explicit env RUSTFLAGS (static CRT), which replaces the config
# rustflags, so the workflow repeats `-C link-arg=/STACK:8388608`. Without it the
# PE keeps the 1 MiB linker default and deep connect/serde call stacks abort with
# 0xC00000FD ("DBX 已停止工作"), which users reported on Windows 7 / Server 2012 R2.
$minimumStackReserve = 8 * 1024 * 1024
$image = [System.IO.File]::ReadAllBytes($BinaryPath)
if ($image.Length -lt 0x100) {
  throw "Windows 7 PE audit target is truncated: $BinaryPath"
}
$peOffset = [System.BitConverter]::ToInt32($image, 0x3C)
if ($peOffset -le 0 -or $peOffset + 24 -gt $image.Length) {
  throw "Invalid PE header offset in ${BinaryPath}"
}
$peSignature = [System.BitConverter]::ToUInt32($image, $peOffset)
if ($peSignature -ne 0x00004550) {
  throw "Invalid PE signature in ${BinaryPath}"
}
$optionalHeaderOffset = $peOffset + 24
$optionalHeaderMagic = [System.BitConverter]::ToUInt16($image, $optionalHeaderOffset)
$stackReserveOffset = $optionalHeaderOffset + 72
$stackReserve = if ($optionalHeaderMagic -eq 0x20B) {
  [System.BitConverter]::ToUInt64($image, $stackReserveOffset)
} elseif ($optionalHeaderMagic -eq 0x10B) {
  [System.BitConverter]::ToUInt32($image, $stackReserveOffset)
} else {
  throw ("Unsupported PE optional header magic 0x{0:X4} in {1}" -f $optionalHeaderMagic, $BinaryPath)
}
if ($stackReserve -lt $minimumStackReserve) {
  throw ("Windows 7 main-thread stack reserve is {0} bytes, below the {1}-byte minimum. Add -C link-arg=/STACK:8388608 to the build RUSTFLAGS. Binary: {2}" -f $stackReserve, $minimumStackReserve, $BinaryPath)
}

Write-Host "Windows 7 PE stack reserve audit passed: $stackReserve bytes ($BinaryPath)"
