$ErrorActionPreference = 'Stop'
$bundleScript = Join-Path $PSScriptRoot 'bundle-win7-installer.ps1'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ('dbx-win7-bundle-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$originalLocation = Get-Location

function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function pnpm {
    $global:DbxBundleTestState.Attempts++
    $global:DbxBundleTestState.Commands += ($args -join ' ')
    $global:LASTEXITCODE = if ($global:DbxBundleTestState.Attempts -le $global:DbxBundleTestState.Failures) { 1 } else { 0 }
    if ($LASTEXITCODE -eq 0 -and $global:DbxBundleTestState.EmitInstaller) {
        [IO.Directory]::CreateDirectory($global:DbxBundleTestState.BundleDir) | Out-Null
        [IO.File]::WriteAllText((Join-Path $global:DbxBundleTestState.BundleDir 'dbx-test.exe'), 'fixture installer')
    }
}
function New-Fixture([int]$Failures, [bool]$EmitInstaller = $true) {
    $directory = Join-Path $testRoot ([Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Set-Location -LiteralPath $directory
    $global:DbxBundleTestState = @{
        BundleDir = Join-Path $directory 'target/x86_64-win7-windows-msvc/release/bundle/nsis'
        Attempts = 0
        Commands = @()
        Failures = $Failures
        EmitInstaller = $EmitInstaller
    }
    $global:LASTEXITCODE = 0
}

try {
    foreach ($failures in @(0, 2)) {
        New-Fixture $failures
        $hash = & $bundleScript -RetryDelaySeconds 0
        Assert-True ($global:DbxBundleTestState.Attempts -eq ($failures + 1)) 'Unexpected retry count'
        Assert-True ($hash.Algorithm -eq 'SHA256' -and $hash.Hash.Length -eq 64) 'Installer hash missing'
        foreach ($command in $global:DbxBundleTestState.Commands) {
            Assert-True ($command -eq 'tauri bundle --bundles nsis --target x86_64-win7-windows-msvc --config src-tauri/tauri.webview2-win7-fixed.conf.json --config .github/fixtures/win7-nsis-zlib-config.json') 'Bundle command changed'
        }
    }

    New-Fixture 99
    [IO.Directory]::CreateDirectory($global:DbxBundleTestState.BundleDir) | Out-Null
    [IO.File]::WriteAllText((Join-Path $global:DbxBundleTestState.BundleDir 'old.exe'), 'stale installer')
    $failure = $null
    try { & $bundleScript -RetryDelaySeconds 0 } catch { $failure = $_ }
    Assert-True ($global:DbxBundleTestState.Attempts -eq 3) 'Persistent failure was not bounded'
    Assert-True ($failure -and $failure.ToString().Contains('failed after 3 attempts')) 'A stale installer hid the failed bundle'

    New-Fixture 0 $false
    [IO.Directory]::CreateDirectory($global:DbxBundleTestState.BundleDir) | Out-Null
    $failure = $null
    try { & $bundleScript -RetryDelaySeconds 0 } catch { $failure = $_ }
    Assert-True ($failure -and $failure.ToString().Contains('Missing Windows 7 fixed-runtime installer')) 'Missing installer was accepted'
    Assert-True ($global:DbxBundleTestState.Attempts -eq 1) 'Successful bundling was retried'
    Write-Host 'Windows 7 bundling retry tests passed (4 scenarios).'
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    $resolvedRoot = (Resolve-Path -LiteralPath $testRoot).ProviderPath
    if ($resolvedRoot -ne $testRoot -or !$resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to remove a fixture outside the temporary directory.'
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
