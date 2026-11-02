[CmdletBinding(DefaultParameterSetName = "Runtime")]
param(
  [Parameter(Mandatory = $true)]
  [string]$ComputerName,
  [Parameter(Mandatory = $true)]
  [string]$UserName,
  [string]$Password = $env:SERVER2012_PASSWORD,
  [Parameter(Mandatory = $true)]
  [ValidateSet("Runtime", "Installer")]
  [string]$Mode,
  [Parameter(Mandatory = $true, ParameterSetName = "Runtime")]
  [string]$RuntimeDirectory,
  [Parameter(Mandatory = $true, ParameterSetName = "Runtime")]
  [string]$LoaderPath,
  [Parameter(Mandatory = $true, ParameterSetName = "Installer")]
  [string]$InstallerPath,
  [switch]$UseSsl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Password)) {
  throw "SERVER2012_PASSWORD is required."
}

$securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($UserName, $securePassword)
$sessionParameters = @{
  ComputerName = $ComputerName
  Credential = $credential
  Authentication = "Negotiate"
  ErrorAction = "Stop"
}
$useSslEnabled = $UseSsl -or $env:SERVER2012_USE_SSL -eq "true"
if ($useSslEnabled) {
  $sessionParameters.UseSSL = $true
  $sessionParameters.SessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck
}

$session = $null
$remoteRoot = "C:\Windows\Temp\dbx-server2012-ci-$([Guid]::NewGuid().ToString('N'))"
try {
  $session = New-PSSession @sessionParameters
  Invoke-Command -Session $session -ScriptBlock {
    param($Path)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  } -ArgumentList $remoteRoot

  if ($Mode -eq "Runtime") {
    $runtimeDirectory = (Resolve-Path -LiteralPath $RuntimeDirectory).Path
    $loaderPath = (Resolve-Path -LiteralPath $LoaderPath).Path
    $probeScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "assert-webview2-server2012-runtime.ps1")).Path

    Copy-Item -LiteralPath $runtimeDirectory -Destination "$remoteRoot\webview2-fixed-runtime" -Recurse -ToSession $session
    Copy-Item -LiteralPath $loaderPath -Destination "$remoteRoot\WebView2Loader.dll" -ToSession $session
    Copy-Item -LiteralPath $probeScript -Destination "$remoteRoot\assert-runtime.ps1" -ToSession $session

    Invoke-Command -Session $session -ScriptBlock {
      param($Root)
      & "$Root\assert-runtime.ps1" `
        -RuntimeDirectory "$Root\webview2-fixed-runtime" `
        -LoaderPath "$Root\WebView2Loader.dll"
    } -ArgumentList $remoteRoot
  } else {
    $installerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
    $smokeScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "assert-server2012-installer-smoke.ps1")).Path

    Copy-Item -LiteralPath $installerPath -Destination "$remoteRoot\installer.exe" -ToSession $session
    Copy-Item -LiteralPath $smokeScript -Destination "$remoteRoot\assert-installer.ps1" -ToSession $session

    Invoke-Command -Session $session -ScriptBlock {
      param($Root)
      & "$Root\assert-installer.ps1" -InstallerPath "$Root\installer.exe"
    } -ArgumentList $remoteRoot
  }
}
finally {
  if ($null -ne $session) {
    Invoke-Command -Session $session -ScriptBlock {
      param($Path)
      $windowsTemp = [System.IO.Path]::GetFullPath("C:\Windows\Temp").TrimEnd('\')
      $resolvedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
      if (!$resolvedPath.StartsWith("$windowsTemp\dbx-server2012-ci-", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean an unexpected remote validation directory: $resolvedPath"
      }
      if (Test-Path -LiteralPath $resolvedPath) {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
      }
    } -ArgumentList $remoteRoot
    Remove-PSSession $session
  }
}
