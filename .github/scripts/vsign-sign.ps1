[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedPath = (Resolve-Path -LiteralPath $FilePath -ErrorAction Stop).Path
if (!(Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
  throw "VSign target is not a file: $resolvedPath"
}

$extension = [IO.Path]::GetExtension($resolvedPath).ToLowerInvariant()
if ($extension -eq ".dll") {
  Write-Host "Skipping Authenticode signing for DLL: $resolvedPath"
  return
}
if ($extension -notin @(".exe", ".msi")) {
  throw "Unsupported VSign target type: $extension"
}

$requiredVariables = @(
  "SSIGNCODE_OPERATOR_DIR",
  "SSIGNCODE_OPERATOR_FILE",
  "SSIGNCODE_OPERATOR_PWD",
  "SSIGNCODE_OPERATOR_STORE",
  "VSIGN_CERT_HASH",
  "VSIGN_CLI",
  "VSIGN_KEY_PIN",
  "VSIGN_SERVER"
)

foreach ($variableName in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($variableName)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required VSign runtime configuration is missing: $variableName"
  }
}

$directory = [IO.Path]::GetDirectoryName($resolvedPath)
$fileName = [IO.Path]::GetFileNameWithoutExtension($resolvedPath)
$signedPath = Join-Path $directory "$fileName.vsign-$([Guid]::NewGuid().ToString('N'))$extension"

try {
  & $env:VSIGN_CLI vsign `
    -s $env:VSIGN_SERVER `
    --cert_from csign `
    -u dbx-github-ci `
    --cert_hash $env:VSIGN_CERT_HASH `
    -k $env:VSIGN_KEY_PIN `
    --hash sha256 `
    -i $resolvedPath `
    -o $signedPath

  if ($LASTEXITCODE -ne 0) {
    throw "VSign failed for $resolvedPath with exit code $LASTEXITCODE"
  }
  if (!(Test-Path -LiteralPath $signedPath -PathType Leaf)) {
    throw "VSign did not create the signed output for $resolvedPath"
  }

  & "$PSScriptRoot/assert-authenticode.ps1" -Path $signedPath
  Move-Item -LiteralPath $signedPath -Destination $resolvedPath -Force
  Write-Host "Signed with TrustAsia VSign: $resolvedPath"
}
finally {
  if (Test-Path -LiteralPath $signedPath) {
    Remove-Item -LiteralPath $signedPath -Force
  }
}
