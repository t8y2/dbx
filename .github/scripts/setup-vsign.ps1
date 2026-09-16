[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$requiredVariables = @(
  "GITHUB_ENV",
  "RUNNER_TEMP",
  "VSIGN_CERT_HASH",
  "VSIGN_OPERATOR_PFX_B64",
  "VSIGN_OPERATOR_PWD",
  "VSIGN_OPERATOR_SHA1",
  "VSIGN_SERVER",
  "VSIGN_TOOL_SHA256"
)

foreach ($variableName in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($variableName)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required VSign configuration is missing: $variableName"
  }
}

$serverUri = $null
if (![Uri]::TryCreate($env:VSIGN_SERVER, [UriKind]::Absolute, [ref]$serverUri) -or $serverUri.Scheme -ne "https") {
  throw "VSIGN_SERVER must be an absolute HTTPS URL"
}

$expectedToolSha256 = $env:VSIGN_TOOL_SHA256.Replace(" ", "").ToUpperInvariant()
$expectedOperatorSha1 = $env:VSIGN_OPERATOR_SHA1.Replace(" ", "").ToUpperInvariant()
$expectedCertificateSha1 = $env:VSIGN_CERT_HASH.Replace(" ", "").ToUpperInvariant()
if ($expectedToolSha256 -notmatch '^[0-9A-F]{64}$') {
  throw "VSIGN_TOOL_SHA256 is invalid"
}
if ($expectedOperatorSha1 -notmatch '^[0-9A-F]{40}$') {
  throw "VSIGN_OPERATOR_SHA1 is invalid"
}
if ($expectedCertificateSha1 -notmatch '^[0-9A-F]{40}$') {
  throw "VSIGN_CERT_HASH is invalid"
}

$runId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { "local" } else { $env:GITHUB_RUN_ID }
$runAttempt = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) { "1" } else { $env:GITHUB_RUN_ATTEMPT }
$workDir = Join-Path $env:RUNNER_TEMP "vsign-$runId-$runAttempt"
$operatorDir = Join-Path $workDir "operator"
$operatorFile = Join-Path $operatorDir "dbx-github-ci@ssigncode.pfx"
$toolPath = Join-Path $workDir "ssigncode.exe"
$toolUrl = "https://github.com/g5wsg/vsign-github-test1/releases/download/vsign-cli-v1/ssigncode.exe"

New-Item -ItemType Directory -Force -Path $operatorDir | Out-Null
Invoke-WebRequest -Uri $toolUrl -OutFile $toolPath

$actualToolSha256 = (Get-FileHash -LiteralPath $toolPath -Algorithm SHA256).Hash
if ($actualToolSha256 -ne $expectedToolSha256) {
  throw "VSign CLI SHA256 mismatch. Expected $expectedToolSha256, got $actualToolSha256"
}

& $toolPath version
if ($LASTEXITCODE -ne 0) {
  throw "VSign CLI version check failed with exit code $LASTEXITCODE"
}

try {
  $pfxBytes = [Convert]::FromBase64String($env:VSIGN_OPERATOR_PFX_B64.Trim())
  [IO.File]::WriteAllBytes($operatorFile, $pfxBytes)
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $operatorCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
    $operatorFile,
    $env:VSIGN_OPERATOR_PWD,
    $flags
  )
}
catch {
  throw "Cannot restore or decrypt the VSign operator PFX: $($_.Exception.Message)"
}

try {
  $actualOperatorSha1 = $operatorCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
  if ($actualOperatorSha1 -ne $expectedOperatorSha1) {
    throw "Operator certificate mismatch. Expected $expectedOperatorSha1, got $actualOperatorSha1"
  }
  if (!$operatorCertificate.HasPrivateKey) {
    throw "The operator PFX does not contain a private key"
  }
  if ($operatorCertificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
    throw "The operator certificate has expired"
  }
}
finally {
  $operatorCertificate.Dispose()
}

$githubEnvironment = [ordered]@{
  VSIGN_WORK_DIR = $workDir
  VSIGN_CLI = $toolPath
  SSIGNCODE_OPERATOR_STORE = "file"
  SSIGNCODE_OPERATOR_DIR = $operatorDir
  SSIGNCODE_OPERATOR_FILE = $operatorFile
}

foreach ($entry in $githubEnvironment.GetEnumerator()) {
  "$($entry.Key)=$($entry.Value)" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
}

Write-Host "VSign CLI and operator certificate are ready."
