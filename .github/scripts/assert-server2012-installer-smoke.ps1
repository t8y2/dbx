[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [int]$StartupSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$os = [System.Environment]::OSVersion.Version
if ($os.Major -ne 6 -or ($os.Minor -ne 1 -and $os.Minor -ne 3)) {
  throw "The installer smoke test requires Windows 7 or Server 2012 R2 (kernel 6.1/6.3), detected $($os.ToString())."
}

$installerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "dbx-server2012-installer-smoke"
$resolvedTemp = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path.TrimEnd('\')
$resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot).TrimEnd('\')
if (!$resolvedTestRoot.StartsWith("$resolvedTemp\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a smoke-test directory outside the system temporary directory: $resolvedTestRoot"
}

if (Test-Path -LiteralPath $resolvedTestRoot) {
  Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}

$appProcess = $null
try {
  $installer = Start-Process -FilePath $installerPath -ArgumentList @("/S", "/D=$resolvedTestRoot") -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "Server 2012 R2 test installer failed with exit code $($installer.ExitCode)."
  }

  $appPath = Join-Path $resolvedTestRoot "dbx.exe"
  $runtimePath = Join-Path $resolvedTestRoot "webview2-fixed-runtime\msedgewebview2.exe"
  foreach ($requiredPath in @($appPath, $runtimePath)) {
    if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Server 2012 R2 installer omitted required file: $requiredPath"
    }
  }

  $env:WEBVIEW2_BROWSER_EXECUTABLE_FOLDER = Join-Path $resolvedTestRoot "webview2-fixed-runtime"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--no-sandbox --disable-gpu"
  $env:DBX_STARTUP_LOG_DIR = Join-Path $resolvedTestRoot "smoke-logs"
  New-Item -ItemType Directory -Path $env:DBX_STARTUP_LOG_DIR -Force | Out-Null

  $appProcess = Start-Process -FilePath $appPath -PassThru
  Start-Sleep -Seconds $StartupSeconds
  $appProcess.Refresh()
  if ($appProcess.HasExited) {
    $startupLog = Join-Path $env:DBX_STARTUP_LOG_DIR "startup.log"
    $logText = if (Test-Path -LiteralPath $startupLog) {
      Get-Content -LiteralPath $startupLog -Raw
    } else {
      "<startup.log was not created>"
    }
    throw "DBX exited during the Server 2012 R2 startup smoke test with code $($appProcess.ExitCode).`n$logText"
  }

  Write-Host "Server 2012 R2 installer smoke test passed after $StartupSeconds seconds: $installerPath"
}
finally {
  if ($null -ne $appProcess -and !$appProcess.HasExited) {
    Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
  }

  $uninstallerPath = Join-Path $resolvedTestRoot "uninstall.exe"
  if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
    $uninstaller = Start-Process -FilePath $uninstallerPath -ArgumentList @("/S", "_?=$resolvedTestRoot") -Wait -PassThru
    if ($uninstaller.ExitCode -ne 0) {
      Write-Warning "Server 2012 R2 test uninstaller returned exit code $($uninstaller.ExitCode)."
    }
  }
}
