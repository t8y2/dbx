<#
.SYNOPSIS
    Manually verify the dbx-mcp stdio handshake paths on Windows.
.DESCRIPTION
    Runs the four paths that matter after the MCP protocol work:
      1. bare `server/discover` (no _meta)  -> -32601, the legacy fallback signal
      2. `initialize` at 2025-11-25          -> legacy stateful session
      3. `server/discover` with _meta        -> advertises 2026-07-28
      4. `tools/call` with no initialize     -> served statelessly
.EXAMPLE
    .\dbx-mcp-check.ps1 -Binary .\target\debug\dbx-mcp.exe
.EXAMPLE
    # against your real DBX connections
    .\dbx-mcp-check.ps1 -Binary .\target\debug\dbx-mcp.exe -DataDir "$env:APPDATA\com.dbx.app"
#>
param(
    [string]$Binary = ".\target\debug\dbx-mcp.exe",
    [string]$DataDir = "",
    [int]$TimeoutMs = 15000
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Binary)) {
    Write-Error "binary not found: $Binary`nBuild it first:`n  cargo build -p dbx-mcp --no-default-features --features sqlite-bundled"
}
$Binary = (Resolve-Path $Binary).Path

$explicitDataDir = [bool]$DataDir
if (-not $DataDir) {
    $DataDir = Join-Path $env:TEMP ("dbx-mcp-check-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}
elseif (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Error "data directory does not exist: $DataDir`nPass -DataDir only with a directory that contains dbx.db, or omit it to test with an empty store."
}
elseif (-not (Test-Path -LiteralPath (Join-Path $DataDir "dbx.db")) -and -not (Test-Path -LiteralPath (Join-Path $DataDir "storage.db"))) {
    Write-Warning "no dbx.db found in $DataDir; dbx_list_connections may report no connections"
}
$DataDir = (Resolve-Path -LiteralPath $DataDir).Path

$env:DBX_DATA_DIR = $DataDir
$env:RUST_LOG = "warn"

$meta = @{
    "io.modelcontextprotocol/protocolVersion"   = "2026-07-28"
    "io.modelcontextprotocol/clientInfo"        = @{ name = "manual-check"; version = "0" }
    "io.modelcontextprotocol/clientCapabilities" = @{}
}

$failures = New-Object System.Collections.Generic.List[string]
$proc = $null

function Invoke-Mcp {
    param([hashtable]$Message, [switch]$NoReply)
    $line = ($Message | ConvertTo-Json -Depth 12 -Compress)
    $proc.StandardInput.WriteLine($line)
    $proc.StandardInput.Flush()
    if ($NoReply) { return $null }
    $read = $proc.StandardOutput.ReadLineAsync()
    if (-not $read.Wait($TimeoutMs)) {
        $proc.Kill()
        throw "timed out waiting for a reply to '$($Message.method)'; stderr: $($proc.StandardError.ReadToEnd())"
    }
    return ($read.Result | ConvertFrom-Json)
}

function Invoke-Request {
    param([int]$Id, [string]$Method, [hashtable]$Params)
    $paramsJson = ($Params | ConvertTo-Json -Depth 12 -Compress)
    if (-not $paramsJson -or $paramsJson -eq "{}") { $paramsJson = "{}" }
    $raw = "{`"jsonrpc`":`"2.0`",`"id`":$Id,`"method`":`"$Method`",`"params`":$paramsJson}"
    $proc.StandardInput.WriteLine($raw)
    $proc.StandardInput.Flush()
    $read = $proc.StandardOutput.ReadLineAsync()
    if (-not $read.Wait($TimeoutMs)) {
        $proc.Kill()
        throw "timed out waiting for '$Method'; stderr: $($proc.StandardError.ReadToEnd())"
    }
    return ($read.Result | ConvertFrom-Json)
}

function Invoke-Notification {
    param([string]$Method)
    $proc.StandardInput.WriteLine("{`"jsonrpc`":`"2.0`",`"method`":`"$Method`"}")
    $proc.StandardInput.Flush()
}

try {
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo.FileName = $Binary
    $proc.StartInfo.UseShellExecute = $false
    $proc.StartInfo.RedirectStandardInput = $true
    $proc.StartInfo.RedirectStandardOutput = $true
    $proc.StartInfo.RedirectStandardError = $true
    $proc.StartInfo.CreateNoWindow = $true
    [void]$proc.Start()

    # 1. Bare discovery probe: agents older than the final 2026 lifecycle read
    #    -32601 as "this server is legacy, use initialize".
    $bare = Invoke-Request -Id 1 -Method "server/discover" -Params @{}
    $code = $bare.error.code
    Write-Host "[1] bare server/discover      -> error $code (expected -32601)"
    if ($code -ne -32601) { $failures.Add("bare probe returned $code, expected -32601") }

    # 2. Legacy initialize still negotiates a pre-2026 version.
    $init = Invoke-Request -Id 2 -Method "initialize" -Params @{
        protocolVersion = "2025-11-25"
        capabilities    = @{}
        clientInfo      = @{ name = "manual-check"; version = "0" }
    }
    $version = $init.result.protocolVersion
    $server = $init.result.serverInfo.name
    Write-Host "[2] initialize 2025-11-25     -> protocolVersion=$version serverInfo=$server"
    if ($version -ne "2025-11-25" -or $server -ne "dbx") { $failures.Add("legacy initialize returned $($init | ConvertTo-Json -Compress)") }

    Invoke-Notification -Method "notifications/initialized"
    $tools = (Invoke-Request -Id 3 -Method "tools/list" -Params @{}).result.tools
    Write-Host "    legacy tools/list         -> $($tools.Count) tools"
    if (-not $tools -or $tools.Count -eq 0) { $failures.Add("legacy tools/list returned no tools") }

    # 3. A well-formed probe must reach the SDK and advertise 2026-07-28.
    $discover = Invoke-Request -Id 4 -Method "server/discover" -Params @{ _meta = $meta }
    $versions = $discover.result.supportedVersions
    Write-Host "[3] server/discover + _meta   -> versions=$($versions -join ', ')"
    $infoName = $discover.result._meta."io.modelcontextprotocol/serverInfo".name
    Write-Host "    serverInfo=$infoName ttlMs=$($discover.result.ttlMs) cacheScope=$($discover.result.cacheScope)"
    if ($versions -notcontains "2026-07-28") { $failures.Add("discovery did not advertise 2026-07-28") }

    # 4. Stateless tools/call: no initialize at all, metadata per request.
    $call = Invoke-Request -Id 5 -Method "tools/call" -Params @{
        name      = "dbx_list_connections"
        arguments = @{}
        _meta     = $meta
    }
    $text = $call.result.content[0].text
    Write-Host "[4] stateless tools/call      -> isError=$($call.result.isError) text='$($text -replace "`r?`n", ' ')'"
    if ($call.result.isError) { $failures.Add("stateless tools/call failed: $($call | ConvertTo-Json -Compress)") }
}
finally {
    if ($proc) {
        try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    }
}

if ($failures.Count -gt 0) {
    Write-Host "`nFAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "`nAll checks passed." -ForegroundColor Green
exit 0
