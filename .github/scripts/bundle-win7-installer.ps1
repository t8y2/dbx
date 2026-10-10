param(
    [ValidateRange(1, 5)][int]$MaxAttempts = 3,
    [ValidateRange(0, 120)][int]$RetryDelaySeconds = 10
)

$ErrorActionPreference = 'Stop'
# Native failures are checked explicitly so transient downloads can be retried.
$PSNativeCommandUseErrorActionPreference = $false
$bundleDir = 'target/x86_64-win7-windows-msvc/release/bundle/nsis'

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    pnpm tauri bundle --bundles nsis --target x86_64-win7-windows-msvc --config src-tauri/tauri.webview2-win7-fixed.conf.json --config .github/fixtures/win7-nsis-zlib-config.json
    $bundleExitCode = $LASTEXITCODE
    if ($bundleExitCode -eq 0) { break }
    if ($attempt -eq $MaxAttempts) {
        throw "Windows 7 installer bundling failed after $MaxAttempts attempts (exit code $bundleExitCode)."
    }
    Write-Warning "Installer bundling attempt $attempt failed (exit code $bundleExitCode); retrying in $RetryDelaySeconds seconds."
    Start-Sleep -Seconds $RetryDelaySeconds
}

$installer = Get-ChildItem -LiteralPath $bundleDir -Filter '*.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (!$installer) {
    throw "Missing Windows 7 fixed-runtime installer in ${bundleDir}"
}
Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
