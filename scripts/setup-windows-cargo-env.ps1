# One-time setup: persist OpenSSL env vars for Cargo on Windows.
# Writes to %USERPROFILE%\.cargo\config.toml (does not touch the repo config).

$ErrorActionPreference = "Stop"

$opensslRoot = if ($env:OPENSSL_DIR) { $env:OPENSSL_DIR } else { "C:/OpenSSL-Win64/OpenSSL-Win64" }
$opensslRoot = $opensslRoot -replace '\\', '/'
$includeDir = "$opensslRoot/include"

if (-not (Test-Path "$includeDir/openssl/sha.h")) {
    throw @"
OpenSSL not found at $opensslRoot.
Install Shining Light OpenSSL (Win64) to C:\OpenSSL-Win64\OpenSSL-Win64
https://slproweb.com/products/Win32OpenSSL.html
"@
}

$cargoDir = Join-Path $env:USERPROFILE ".cargo"
$configPath = Join-Path $cargoDir "config.toml"
$markerStart = "# >>> dbx Windows Kafka/OpenSSL >>>"
$markerEnd = "# <<< dbx Windows Kafka/OpenSSL <<<"

$block = @"
$markerStart
[env]
OPENSSL_DIR = "$opensslRoot"
OPENSSL_LIB_DIR = "$opensslRoot/lib/VC/x64/MD"
OPENSSL_INCLUDE_DIR = "$includeDir"
OPENSSL_NO_VENDOR = "1"
DEP_OPENSSL_ROOT = "$opensslRoot"
OPENSSL_INCLUDE = "$includeDir"
OPENSSL_LIBPATH = "$opensslRoot/lib/VC/x64/MD"
$markerEnd
"@

New-Item -ItemType Directory -Force -Path $cargoDir | Out-Null

$content = if (Test-Path $configPath) { Get-Content $configPath -Raw } else { "" }
if ($content -match [regex]::Escape($markerStart)) {
    $pattern = "(?s)$([regex]::Escape($markerStart)).*?$([regex]::Escape($markerEnd))"
    $content = [regex]::Replace($content, $pattern, $block.TrimEnd())
} else {
    if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
        $content += "`n"
    }
    $content += "`n$block`n"
}

Set-Content -Path $configPath -Value $content -Encoding utf8
Write-Host "Updated $configPath"
Write-Host "OpenSSL root: $opensslRoot"
Write-Host "You still need MSVC (cl/nmake) in PATH — use 'x64 Native Tools Command Prompt' or run scripts/windows-build-env.ps1 before building."
