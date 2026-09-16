[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path,

  [string]$ExpectedCertificateSha1 = $env:VSIGN_CERT_HASH
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ExpectedCertificateSha1)) {
  throw "The expected Authenticode certificate SHA1 is not configured"
}

$expectedSha1 = $ExpectedCertificateSha1.Replace(" ", "").ToUpperInvariant()
if ($expectedSha1 -notmatch '^[0-9A-F]{40}$') {
  throw "The expected Authenticode certificate SHA1 is invalid"
}

foreach ($candidate in $Path) {
  $resolvedPath = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
  if (!(Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
    throw "Authenticode target is not a file: $resolvedPath"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $resolvedPath
  if ($null -eq $signature.SignerCertificate) {
    throw "No Authenticode signature was found on $resolvedPath"
  }

  $actualSha1 = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
  if ($actualSha1 -ne $expectedSha1) {
    throw "Signing certificate mismatch on $resolvedPath. Expected $expectedSha1, got $actualSha1"
  }
  if ($signature.Status -ne "Valid") {
    throw "Authenticode signature status for $resolvedPath is $($signature.Status): $($signature.StatusMessage)"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "The Authenticode signature on $resolvedPath does not contain a timestamp certificate"
  }

  Write-Host "Verified Authenticode signature: $resolvedPath"
}
