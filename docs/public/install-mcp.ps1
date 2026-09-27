$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-Download([string]$Url, [string]$Destination) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 120 | Out-Null
        return $true
    } catch { return $false }
}
function Test-Version([string]$Value) { return $Value -cmatch '^[0-9]+\.[0-9]+\.[0-9]+$' }
function Read-Json([string]$Path) {
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}
function Get-InstalledVersion([string]$Binary, [string]$Marker) {
    if (!(Test-Path -LiteralPath $Binary -PathType Leaf)) { return '' }
    $process = New-Object System.Diagnostics.Process
    try {
        $process.StartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $process.StartInfo.FileName = $Binary
        $process.StartInfo.Arguments = '--version'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardInput = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        [void]$process.Start()
        $process.StandardInput.Close()
        if (!$process.WaitForExit(3000)) { $process.Kill(); $process.WaitForExit() }
        if ($process.ExitCode -eq 0) {
            $reported = $process.StandardOutput.ReadToEnd().Trim() -replace '^dbx-mcp ', ''
            if (Test-Version $reported) { return $reported }
        }
    } catch {} finally { $process.Dispose() }
    if (Test-Path -LiteralPath $Marker -PathType Leaf) {
        $reported = (Get-Content -LiteralPath $Marker -Raw).Trim()
        if (Test-Version $reported) { return $reported }
    }
    return ''
}
function Move-Atomic([string]$Source, [string]$Destination) {
    if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source, $Destination, [NullString]::Value) }
    else { [IO.File]::Move($Source, $Destination) }
}
function Set-InstallPath([string]$Directory) {
    try {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (($userPath -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $Directory.TrimEnd('\')) {
            [Environment]::SetEnvironmentVariable('Path', "$Directory;$userPath", 'User')
        }
        if (($env:Path -split ';') -notcontains $Directory) { $env:Path = "$Directory;$env:Path" }
    } catch { Write-Warning "Could not update user PATH. Client configs use the absolute path: $Directory" }
}
function Show-Configs([string]$Binary) {
    Write-Output "`nClaude Code (.mcp.json), Cursor (.cursor/mcp.json), ZCode config, generic JSON:"
    @{ mcpServers = @{ dbx = @{ command = $Binary } } } | ConvertTo-Json -Depth 5
    $quoted = ConvertTo-Json -InputObject $Binary -Compress
    Write-Output "`nCodex (~/.codex/config.toml):`n[mcp_servers.dbx]`ncommand = $quoted"
    $launcher = Get-Command dbx-mcp-server -ErrorAction SilentlyContinue
    if ($launcher) {
        Write-Output "`nExisting npm launcher: $($launcher.Source)"
        Write-Output "Replace its command with $quoted and remove Node/npx arguments; preserve env."
        Write-Output 'Optional cleanup: npm rm -g @dbx-app/mcp-server'
    }
}

function Get-McpPlatform {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use install-mcp on macOS or Linux.' }
    try { $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
    catch { $architecture = $env:PROCESSOR_ARCHITEW6432; if (!$architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE } }
    switch ($architecture) {
        { $_ -in 'Arm64', 'ARM64' } { return 'win32-arm64' }
        { $_ -in 'X64', 'AMD64' } { return 'win32-x64' }
        default { throw 'Unsupported CPU architecture; Windows x64 or ARM64 is required.' }
    }
}

function Install-DbxMcp {
    $platform = Get-McpPlatform
    $installDir = [IO.Path]::GetFullPath((Join-Path $HOME '.dbx\bin'))
    [IO.Directory]::CreateDirectory($installDir) | Out-Null
    $binary = Join-Path $installDir 'dbx-mcp.exe'
    $marker = Join-Path $installDir '.dbx-mcp-version'
    $workDir = Join-Path $installDir ('.dbx-mcp-install.' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($workDir) | Out-Null
    try {
        $metadataFile = Join-Path $workDir 'metadata.json'
        $registries = @('https://registry.npmjs.org', 'https://registry.npmmirror.com')
        $version = ''
        foreach ($registry in $registries) {
            if (Get-Download "$registry/@dbx-app/mcp-server/latest" $metadataFile) {
                $candidate = (Read-Json $metadataFile).version
                if (Test-Version $candidate) { $version = $candidate; break }
            }
        }
        if (!$version -and (Get-Download 'https://api.github.com/repos/t8y2/dbx/git/matching-refs/tags/packages-v' $metadataFile)) {
            $versions = @(Read-Json $metadataFile) | ForEach-Object {
                if ($_.ref -cmatch '^refs/tags/packages-v([0-9]+\.[0-9]+\.[0-9]+)$') { [version]$Matches[1] }
            } | Sort-Object -Descending
            if ($versions) { $version = [string]@($versions)[0] }
        }
        if (!(Test-Version $version)) { throw 'Unable to resolve a release (offline or registries unavailable); existing installation unchanged.' }
        $current = Get-InstalledVersion $binary $marker
        if ($current -eq $version) {
            Write-Output "dbx-mcp $version already up to date"
            Set-InstallPath $installDir
            Show-Configs $binary
            return
        }
        if ((Test-Version $current) -and [version]$current -gt [version]$version) {
            Write-Output "dbx-mcp $current is newer than available $version; keeping current installation"
            Set-InstallPath $installDir
            Show-Configs $binary
            return
        }
        $archive = Join-Path $workDir 'archive.tgz'
        $stagedBinary = Join-Path $workDir 'dbx-mcp.exe'
        $downloaded = $false
        foreach ($registry in $registries) {
            if (!(Get-Command tar.exe -ErrorAction SilentlyContinue)) { break }
            if (!(Get-Download "$registry/@dbx-app/mcp-$platform/$version" $metadataFile)) { continue }
            $integrity = (Read-Json $metadataFile).dist.integrity
            if ($integrity -cnotmatch '^sha512-[A-Za-z0-9+/]{86}==$') { continue }
            if (!(Get-Download "$registry/@dbx-app/mcp-$platform/-/mcp-$platform-$version.tgz" $archive)) { continue }
            $stream = [IO.File]::OpenRead($archive)
            $hasher = [Security.Cryptography.SHA512]::Create()
            try { $actual = 'sha512-' + [Convert]::ToBase64String($hasher.ComputeHash($stream)) }
            finally { $stream.Dispose(); $hasher.Dispose() }
            if ($actual -cne $integrity) { throw "Integrity verification failed for $registry; refusing to install." }
            & tar.exe -xzf $archive -C $workDir 'package/bin/dbx-mcp.exe' 2>$null
            if ($LASTEXITCODE -ne 0) { throw 'Binary missing from npm archive.' }
            [IO.File]::Move((Join-Path $workDir 'package\bin\dbx-mcp.exe'), $stagedBinary)
            $downloaded = $true
            break
        }
        if (!$downloaded) {
            $asset = "dbx-mcp-$platform.zip"
            $release = "https://github.com/t8y2/dbx/releases/download/packages-v$version"
            $checksums = Join-Path $workDir 'SHA256SUMS'
            if (!(Get-Download "$release/SHA256SUMS" $checksums) -or !(Get-Download "$release/$asset" $archive)) {
                throw 'All download sources unavailable; existing installation unchanged.'
            }
            $hashes = @(Get-Content -LiteralPath $checksums | ForEach-Object {
                if ($_ -match ('^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($asset) + '$')) { $Matches[1] }
            })
            if ($hashes.Count -ne 1 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $hashes[0]) {
                throw 'SHA256 verification failed; refusing to install.'
            }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [IO.Compression.ZipFile]::OpenRead($archive)
            try {
                $entry = $zip.GetEntry('dbx-mcp.exe')
                if (!$entry) { throw 'Binary missing from Release archive.' }
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $stagedBinary)
            } finally { $zip.Dispose() }
        }
        $staged = Get-Item -LiteralPath $stagedBinary
        if (!$staged.Length -or ($staged.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Downloaded binary is empty or a link.' }
        $stagedMarker = Join-Path $workDir 'version'
        [IO.File]::WriteAllText($stagedMarker, "$version`n", (New-Object Text.UTF8Encoding($false)))
        Move-Atomic $stagedBinary $binary
        Move-Atomic $stagedMarker $marker
        Set-InstallPath $installDir
        Write-Output "Installed dbx-mcp $version at $binary"
        Show-Configs $binary
    } finally { Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue }
}

Install-DbxMcp
