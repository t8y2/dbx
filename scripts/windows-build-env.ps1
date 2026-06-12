# Sets build environment for Kafka (rdkafka + sasl2-sys) on Windows.
# Usage:
#   . .\scripts\windows-build-env.ps1
#   cargo build -p dbx-core
#
# Or run a single command:
#   .\scripts\windows-build-env.ps1 -Command @("cargo", "build", "-p", "dbx-core")

param(
    [string[]]$Command = @()
)

$ErrorActionPreference = "Stop"

function Import-VcVars {
    if (Get-Command cl.exe -ErrorAction SilentlyContinue) {
        return
    }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "cl.exe not found. Install Visual Studio 2022 with the 'Desktop development with C++' workload."
    }

    $vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsRoot) {
        throw "Visual Studio C++ build tools not found. Install the 'Desktop development with C++' workload."
    }

    $vcvars = Join-Path $vsRoot "VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path $vcvars)) {
        throw "Missing vcvars64.bat at $vcvars"
    }

    cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
        if ($_ -match "^(?<key>[^=]+?)=(?<value>.*)$") {
            Set-Item -Path "Env:$($Matches.key)" -Value $Matches.value
        }
    }
}

$opensslRoot = if ($env:OPENSSL_DIR) { $env:OPENSSL_DIR } else { "C:/OpenSSL-Win64/OpenSSL-Win64" }
$opensslRoot = $opensslRoot -replace '\\', '/'
$libDir = "$opensslRoot/lib/VC/x64/MD"
$includeDir = "$opensslRoot/include"

if (-not (Test-Path "$includeDir/openssl/sha.h")) {
    throw @"
OpenSSL development files not found at $opensslRoot.

Install Shining Light OpenSSL (Win64) to a path without spaces, e.g. C:\OpenSSL-Win64\OpenSSL-Win64
https://slproweb.com/products/Win32OpenSSL.html

Then re-run this script, or set OPENSSL_DIR to your install path.
"@
}

$env:OPENSSL_DIR = $opensslRoot
$env:OPENSSL_LIB_DIR = $libDir
$env:OPENSSL_INCLUDE_DIR = $includeDir
$env:OPENSSL_NO_VENDOR = "1"
$env:DEP_OPENSSL_ROOT = $opensslRoot
$env:OPENSSL_INCLUDE = $includeDir
$env:OPENSSL_LIBPATH = $libDir

Import-VcVars

if ($Command.Count -eq 0) {
    Write-Host "Windows build environment ready (OpenSSL: $opensslRoot)."
    return
}

$exe = $Command[0]
$tail = @()
if ($Command.Count -gt 1) {
    $tail = $Command[1..($Command.Count - 1)]
}
& $exe @tail
exit $LASTEXITCODE
