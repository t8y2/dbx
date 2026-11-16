Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "prepare-webview2-win7-runtime.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Get-WebView2Archive" }, $true)
. ([scriptblock]::Create($definition.Extent.Text))

$directory = Join-Path ([IO.Path]::GetTempPath()) "dbx-ci-webview-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $directory | Out-Null
$outFile = Join-Path $directory "archive.cab"

function Invoke-WebRequest {
  param($Uri, $OutFile, $TimeoutSec)
  if ($TimeoutSec -ne 120) { throw "Download timeout changed" }
  if ($global:dbxWebviewTestcalls -gt 0 -and (Test-Path -LiteralPath $OutFile)) { throw "Partial download was reused" }
  $result = $global:dbxWebviewTestresponses[$global:dbxWebviewTestcalls]
  $global:dbxWebviewTestcalls++
  [IO.File]::WriteAllText($OutFile, "partial")
  switch ($result) {
    "ok" { [IO.File]::WriteAllText($OutFile, "complete"); return }
    "timeout" { throw [Net.WebException]::new("timeout", [Net.WebExceptionStatus]::Timeout) }
    "refused" { throw [Net.Http.HttpRequestException]::new("connection refused", [Net.Sockets.SocketException]::new([int][Net.Sockets.SocketError]::ConnectionRefused)) }
    "dns" { throw [Net.Http.HttpRequestException]::new("name lookup failed", [Net.Sockets.SocketException]::new([int][Net.Sockets.SocketError]::HostNotFound)) }
    "socket-denied" { throw [Net.Http.HttpRequestException]::new("access denied", [Net.Sockets.SocketException]::new([int][Net.Sockets.SocketError]::AccessDenied)) }
    "cancel-socket" { throw [Net.Http.HttpRequestException]::new("cancelled", [OperationCanceledException]::new("cancelled", [Net.Sockets.SocketException]::new([int][Net.Sockets.SocketError]::ConnectionReset))) }
    "tls-socket" { throw [Net.Http.HttpRequestException]::new("TLS failed", [Security.Authentication.AuthenticationException]::new("certificate failure", [Net.Sockets.SocketException]::new([int][Net.Sockets.SocketError]::ConnectionReset))) }
    "tls" { throw [Net.WebException]::new("certificate failure", [Net.WebExceptionStatus]::TrustFailure) }
    "cancel" { throw [OperationCanceledException]::new("cancelled") }
    "unknown" { throw "Unknown failure" }
    default { throw [Net.Http.HttpRequestException]::new("HTTP failure", $null, [Net.HttpStatusCode][int]$result) }
  }
}
function Start-Sleep { param($Seconds) $global:dbxWebviewTestdelays += $Seconds }

try {
  foreach ($case in @(
    @{ Responses = @("ok"); Count = 1; Delays = @(); Success = $true },
    @{ Responses = @("503", "ok"); Count = 2; Delays = @(2); Success = $true },
    @{ Responses = @("timeout", "429", "ok"); Count = 3; Delays = @(2, 4); Success = $true },
    @{ Responses = @("refused", "ok"); Count = 2; Delays = @(2); Success = $true },
    @{ Responses = @("dns", "ok"); Count = 2; Delays = @(2); Success = $true },
    @{ Responses = @("socket-denied"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("cancel-socket"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("tls-socket"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("503", "503", "503"); Count = 3; Delays = @(2, 4); Success = $false },
    @{ Responses = @("404"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("403"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("tls"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("cancel"); Count = 1; Delays = @(); Success = $false },
    @{ Responses = @("unknown"); Count = 1; Delays = @(); Success = $false }
  )) {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    $global:dbxWebviewTestresponses = $case.Responses
    $global:dbxWebviewTestcalls = 0
    $global:dbxWebviewTestdelays = @()
    $success = $true
    try { Get-WebView2Archive -Uri "https://example.test/archive.cab" -OutFile $outFile } catch { $success = $false }
    if ($success -ne $case.Success -or $global:dbxWebviewTestcalls -ne $case.Count -or
        ($global:dbxWebviewTestdelays -join ",") -ne ($case.Delays -join ",")) {
      throw "Unexpected acquisition result for $($case.Responses -join ','): success=$success calls=$global:dbxWebviewTestcalls delays=$global:dbxWebviewTestdelays"
    }
  }

  # Exercise the actual entry point: downloaded corrupt bytes must not be retried or expanded.
  Remove-Item -LiteralPath $outFile -Force
  $global:dbxWebviewTestresponses = @("ok")
  $global:dbxWebviewTestcalls = 0
  $global:dbxWebviewTestdelays = @()
  $failed = $false
  try { & $source -RuntimeDirectory (Join-Path $directory "runtime") -DownloadDirectory $directory } catch {
    $failed = $_.Exception.Message -like "*SHA-256 mismatch*"
  }
  if (!$failed -or $global:dbxWebviewTestcalls -ne 1) { throw "Corrupt archive did not fail once before extraction" }

  function Get-FileHash { param($LiteralPath, $Algorithm) [pscustomobject]@{ Hash = "7622281cf83de1a35e3a471f432f7a897d65f0a7d3975df08512b7b253dd45c7" } }
  function Get-AuthenticodeSignature { param($LiteralPath) [pscustomobject]@{ Status = [System.Management.Automation.SignatureStatus]::NotSigned; SignerCertificate = $null } }
  $failed = $false
  $global:dbxWebviewTestcalls = 0
  try { & $source -RuntimeDirectory (Join-Path $directory "runtime") -DownloadDirectory $directory } catch {
    $failed = $_.Exception.Message -like "*valid Microsoft signature*"
  }
  if (!$failed -or $global:dbxWebviewTestcalls -ne 0) { throw "Invalid signature did not fail before extraction without re-download" }
  Write-Host "WebView2 acquisition and integrity tests passed."
} finally {
  $resolved = [IO.Path]::GetFullPath($directory)
  if ((Split-Path -Parent $resolved) -ne ([IO.Path]::GetTempPath()).TrimEnd('\', '/')) { throw "Unexpected test cleanup path" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
