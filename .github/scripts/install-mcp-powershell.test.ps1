$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../docs/public/install-mcp.ps1') -Raw
. ([scriptblock]::Create(($source -replace '(?m)^Install-DbxMcp\s*$', '')))
$originalHome = $HOME
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dbx-mcp-ps-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$realTar = (Get-Command tar).Source
$script:count = 0

function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function Get-McpPlatform { return $script:platform }
function Set-InstallPath([string]$Directory) { $script:configuredPath = $Directory }
function tar.exe { & $realTar @args }
function Get-Download([string]$Url, [string]$Destination) {
    $script:requests += $Url
    if ($script:mode -eq 'offline') { return $false }
    if ($script:mode -in 'mirror', 'github' -and $Url.Contains('registry.npmjs.org')) { return $false }
    if ($script:mode -eq 'github' -and $Url.Contains('registry.npmmirror.com')) { return $false }
    $file = switch -Regex ($Url) {
        '/latest$' { 'latest.json'; break }
        '/matching-refs/' { 'refs.json'; break }
        '/0\.4\.96$' { 'metadata.json'; break }
        '\.tgz$' { 'npm.tgz'; break }
        '/SHA256SUMS$' { 'SHA256SUMS'; break }
        '\.zip$' { 'github.zip'; break }
        default { throw "Unexpected URL: $Url" }
    }
    Copy-Item -LiteralPath (Join-Path $script:fixture $file) -Destination $Destination -Force
    return $true
}
function New-Fixture([string]$Platform, [string]$Mode) {
    $script:platform = $Platform
    $script:mode = $Mode
    $script:requests = @()
    $script:fixture = Join-Path $testRoot ([Guid]::NewGuid().ToString('N'))
    $homePath = Join-Path $script:fixture "DBX User's home"
    [IO.Directory]::CreateDirectory($homePath) | Out-Null
    Set-Variable HOME -Scope Global -Force -Value $homePath
    $packageBin = Join-Path $script:fixture 'source/package/bin'
    [IO.Directory]::CreateDirectory($packageBin) | Out-Null
    [IO.File]::WriteAllText((Join-Path $packageBin 'dbx-mcp.exe'), 'fixture binary')
    & $realTar -czf (Join-Path $script:fixture 'npm.tgz') -C (Join-Path $script:fixture 'source') 'package/bin/dbx-mcp.exe'
    if ($LASTEXITCODE) { throw 'Fixture tar failed' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($packageBin, (Join-Path $script:fixture 'github.zip'))
    $stream = [IO.File]::OpenRead((Join-Path $script:fixture 'npm.tgz'))
    $hasher = [Security.Cryptography.SHA512]::Create()
    try { $integrity = 'sha512-' + [Convert]::ToBase64String($hasher.ComputeHash($stream)) }
    finally { $stream.Dispose(); $hasher.Dispose() }
    @{ version = '0.4.96' } | ConvertTo-Json | Set-Content (Join-Path $script:fixture 'latest.json')
    @{ version = '0.4.96'; dist = @{ integrity = $integrity } } | ConvertTo-Json | Set-Content (Join-Path $script:fixture 'metadata.json')
    @(@{ ref = 'refs/tags/packages-v0.4.9' }, @{ ref = 'refs/tags/packages-v0.4.96' }, @{ ref = 'refs/tags/packages-v9.0.0-beta' }) | ConvertTo-Json | Set-Content (Join-Path $script:fixture 'refs.json')
    $hash = (Get-FileHash (Join-Path $script:fixture 'github.zip') -Algorithm SHA256).Hash
    "$hash  dbx-mcp-$Platform.zip" | Set-Content (Join-Path $script:fixture 'SHA256SUMS')
    $script:binary = Join-Path $HOME '.dbx/bin/dbx-mcp.exe'
    $script:marker = Join-Path $HOME '.dbx/bin/.dbx-mcp-version'
}
function Expect-Failure([string]$Pattern) {
    try { Install-DbxMcp | Out-Null } catch {
        Assert-True ($_.Exception.Message -match $Pattern) "Unexpected error: $_"
        return
    }
    throw 'Expected installation to fail'
}

try {
    foreach ($platformName in @('win32-arm64', 'win32-x64')) {
        foreach ($sourceMode in @('npm', 'mirror', 'github')) {
            New-Fixture $platformName $sourceMode
            $output = Install-DbxMcp | Out-String
            Assert-True ((Get-Content -LiteralPath $binary -Raw) -eq 'fixture binary') 'First install binary differs'
            Assert-True ((Get-Content -LiteralPath $marker -Raw).Trim() -eq '0.4.96') 'Marker differs'
            Assert-True ($output.Contains((ConvertTo-Json -InputObject $binary -Compress))) 'Config is not the escaped absolute path'
            Assert-True ($configuredPath -eq (Split-Path $binary)) 'PATH target differs'
            Assert-True (!(Get-ChildItem -LiteralPath (Split-Path $binary) -Directory -Force)) 'Temporary install directory leaked'
            $stale = Join-Path (Split-Path $binary) 'dbx-mcp.exe~RF8c73e4f.TMP'
            [IO.File]::WriteAllText($stale, 'old executable')
            $rerun = Install-DbxMcp | Out-String
            Assert-True ($rerun.Contains('dbx-mcp 0.4.96 already up to date')) 'Rerun not idempotent'
            Assert-True (!(Test-Path -LiteralPath $stale)) 'Up-to-date install left replacement temp file'
            [IO.File]::WriteAllText($stale, 'old executable')
            '0.4.95' | Set-Content -LiteralPath $marker
            $updated = Install-DbxMcp | Out-String
            Assert-True ($updated.Contains('Installed dbx-mcp 0.4.96')) 'Marker-based upgrade failed'
            Assert-True (!(Test-Path -LiteralPath $stale)) 'Upgrade left replacement temp file'
            Remove-Item -LiteralPath $binary
            $repaired = Install-DbxMcp | Out-String
            Assert-True ($repaired.Contains('Installed dbx-mcp 0.4.96')) 'Orphan marker prevented installation'
            $script:count++
            Write-Output "PASS $platformName $sourceMode install/rerun/update/configs"
        }
    }
    foreach ($sourceMode in @('npm', 'github', 'offline')) {
        New-Fixture 'win32-x64' 'npm'
        Install-DbxMcp | Out-Null
        '0.4.95' | Set-Content -LiteralPath $marker
        $script:mode = $sourceMode
        if ($sourceMode -eq 'npm') { 'corrupted' | Set-Content (Join-Path $fixture 'npm.tgz') }
        if ($sourceMode -eq 'github') { 'corrupted' | Set-Content (Join-Path $fixture 'github.zip') }
        Expect-Failure $(if ($sourceMode -eq 'offline') { 'Unable to resolve' } else { 'verification failed' })
        Assert-True ((Get-Content -LiteralPath $binary -Raw) -eq 'fixture binary') 'Failure replaced binary'
        Assert-True ((Get-Content -LiteralPath $marker -Raw).Trim() -eq '0.4.95') 'Failure replaced marker'
        $script:count++
        Write-Output "PASS $sourceMode failure preserves installation"
    }
    New-Fixture 'win32-x64' 'npm'
    Install-DbxMcp | Out-Null
    '0.4.97' | Set-Content -LiteralPath $marker
    $script:mode = 'mirror'
    $newer = Install-DbxMcp | Out-String
    Assert-True ($newer.Contains('keeping current installation')) 'Older mirror downgraded installation'
    Assert-True ((Get-Content -LiteralPath $marker -Raw).Trim() -eq '0.4.97') 'Downgrade changed marker'
    $script:count++
    Write-Output 'PASS older mirror cannot downgrade installation'
    $installDir = Split-Path $binary
    $preservedNames = @('dbx-mcp.exe', '.dbx-mcp-version', 'other.tmp', 'dbx-mcp.exe~RFxyz.TMP', 'dbx-mcp.exe~RF.TMP')
    foreach ($name in $preservedNames | Select-Object -Skip 2) {
        [IO.File]::WriteAllText((Join-Path $installDir $name), 'preserve')
    }
    $nested = Join-Path $installDir 'dbx-mcp.exe~RF123.TMP'
    [IO.Directory]::CreateDirectory($nested) | Out-Null
    $nestedFile = Join-Path $nested 'dbx-mcp.exe~RFabc.TMP'
    [IO.File]::WriteAllText($nestedFile, 'nested')
    $stale = Join-Path $installDir 'DBX-MCP.EXE~rfABC123.tmp'
    [IO.File]::WriteAllText($stale, 'old executable')
    Remove-McpReplacementTempFiles $installDir
    Assert-True (!(Test-Path -LiteralPath $stale)) 'Case-insensitive replacement cleanup failed'
    foreach ($name in $preservedNames) {
        Assert-True (Test-Path -LiteralPath (Join-Path $installDir $name) -PathType Leaf) "Cleanup removed $name"
    }
    Assert-True ((Get-Content -LiteralPath $binary -Raw) -eq 'fixture binary') 'Cleanup changed active binary'
    Assert-True ((Get-Content -LiteralPath $marker -Raw).Trim() -eq '0.4.97') 'Cleanup changed version marker'
    Assert-True ((Get-Content -LiteralPath $nestedFile -Raw) -eq 'nested') 'Cleanup recursed into a directory'
    Remove-McpReplacementTempFiles (Join-Path $testRoot 'missing')
    $script:count++
    Write-Output 'PASS cleanup preserves active binary, marker, unrelated files and directories'
    $linkTarget = Join-Path $testRoot 'linked-target'
    [IO.Directory]::CreateDirectory($linkTarget) | Out-Null
    $targetFile = Join-Path $linkTarget 'dbx-mcp.exe~RF789.TMP'
    [IO.File]::WriteAllText($targetFile, 'preserve link target')
    $directoryLink = Join-Path $installDir 'dbx-mcp.exe~RF789.TMP'
    $linkType = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkType -Path $directoryLink -Target $linkTarget | Out-Null
    Remove-McpReplacementTempFiles $installDir
    Remove-McpReplacementTempFiles $directoryLink
    Assert-True ((Get-Content -LiteralPath $targetFile -Raw) -eq 'preserve link target') 'Cleanup followed directory link'
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        $fileLink = Join-Path $installDir 'dbx-mcp.exe~RFabc.TMP'
        New-Item -ItemType SymbolicLink -Path $fileLink -Target $targetFile | Out-Null
        Remove-McpReplacementTempFiles $installDir
        Assert-True ((Get-Item -LiteralPath $fileLink).Attributes -band [IO.FileAttributes]::ReparsePoint) 'Cleanup removed file link'
    }
    $script:count++
    Write-Output 'PASS cleanup skips links'
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        $lockedPath = Join-Path $installDir 'dbx-mcp.exe~RF456.TMP'
        [IO.File]::WriteAllText($lockedPath, 'locked')
        $locked = [IO.File]::Open($lockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        try {
            [IO.File]::WriteAllText($stale, 'old executable')
            Remove-McpReplacementTempFiles $installDir
            Assert-True (Test-Path -LiteralPath $lockedPath) 'Cleanup removed locked file'
            Assert-True (!(Test-Path -LiteralPath $stale)) 'Locked file prevented cleanup of other files'
        } finally { $locked.Dispose() }
        Remove-McpReplacementTempFiles $installDir
        Assert-True (!(Test-Path -LiteralPath $lockedPath)) 'Cleanup did not retry released file'
        $script:count++
        Write-Output 'PASS cleanup skips locked files and retries after release'
    }
    Write-Output "PowerShell installer scenarios passed: $script:count"
} finally {
    Set-Variable HOME -Scope Global -Force -Value $originalHome
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
