[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Newer WebView2 static loaders import EventSetInformation, which does not exist on Windows 7.
# The loader entry points are stable, so the Win7 bundle uses the last verified compatible SDK loader.
$sdkVersion = "1.0.1054.31"
$sdkPackageSha256 = "0afe683aa3d143a5f6330db1ce833c69278b38fe5e1eadec52f26910ad26e22f"
$loaderSha256 = "76314119685bbf4c2b2423a44e81b57beadc914c943d0e772fd6bc78c8e6b0e8"
$webView2ComSysVersion = "0.38.2"
$upstreamLoaderSha256 = "0659b741bde6348d4c4a6ec4ceb9af50e3d0048ed9cd3c8659bccbb61fde55ee"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-webview2-loader-$([Guid]::NewGuid())"
$packagePath = Join-Path $temporaryRoot "Microsoft.Web.WebView2.$sdkVersion.nupkg"
$extractedPath = Join-Path $temporaryRoot "extracted"

try {
  New-Item -ItemType Directory -Path $extractedPath -Force | Out-Null

  $packageUrl = "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$sdkVersion"
  Write-Host "Downloading WebView2 SDK $sdkVersion for the Windows 7 loader..."
  Invoke-WebRequest -Uri $packageUrl -OutFile $packagePath -UseBasicParsing

  $actualPackageSha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualPackageSha256 -ne $sdkPackageSha256) {
    throw "Unexpected WebView2 SDK package SHA256: $actualPackageSha256"
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $extractedPath)

  $legacyLoader = Join-Path $extractedPath "build/native/x64/WebView2LoaderStatic.lib"
  if (!(Test-Path -LiteralPath $legacyLoader -PathType Leaf)) {
    throw "WebView2 SDK $sdkVersion does not contain the x64 static loader."
  }

  $legacyLoaderDll = Join-Path $extractedPath "build/native/x64/WebView2Loader.dll"
  if (!(Test-Path -LiteralPath $legacyLoaderDll -PathType Leaf)) {
    throw "WebView2 SDK $sdkVersion does not contain the x64 loader DLL."
  }

  $actualLoaderSha256 = (Get-FileHash -LiteralPath $legacyLoader -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualLoaderSha256 -ne $loaderSha256) {
    throw "Unexpected Windows 7 WebView2 loader SHA256: $actualLoaderSha256"
  }

  Push-Location $repositoryRoot
  try {
    & cargo fetch --locked --target x86_64-win7-windows-msvc
    if ($LASTEXITCODE -ne 0) {
      throw "cargo fetch failed while preparing the Windows 7 WebView2 loader."
    }

    $metadataJson = & cargo metadata --locked --format-version 1
    if ($LASTEXITCODE -ne 0) {
      throw "cargo metadata failed while locating webview2-com-sys."
    }
  }
  finally {
    Pop-Location
  }

  $metadata = $metadataJson | ConvertFrom-Json
  $webView2Packages = @($metadata.packages | Where-Object {
      $_.name -eq "webview2-com-sys" -and $_.version -eq $webView2ComSysVersion
    })
  if ($webView2Packages.Count -ne 1) {
    throw "Expected exactly one webview2-com-sys $webView2ComSysVersion package, found $($webView2Packages.Count)."
  }

  $crateRoot = Split-Path -Parent $webView2Packages[0].manifest_path
  $loaderDestination = Join-Path $crateRoot "x64/WebView2LoaderStatic.lib"
  if (!(Test-Path -LiteralPath $loaderDestination -PathType Leaf)) {
    throw "webview2-com-sys static loader does not exist: $loaderDestination"
  }

  $existingLoaderSha256 = (Get-FileHash -LiteralPath $loaderDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  $knownLoaderHashes = @($upstreamLoaderSha256, $loaderSha256)
  if ($existingLoaderSha256 -notin $knownLoaderHashes) {
    throw "Refusing to replace an unknown webview2-com-sys loader SHA256: $existingLoaderSha256"
  }

  Set-ItemProperty -LiteralPath $loaderDestination -Name IsReadOnly -Value $false
  Copy-Item -LiteralPath $legacyLoader -Destination $loaderDestination -Force

  $installedLoaderSha256 = (Get-FileHash -LiteralPath $loaderDestination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedLoaderSha256 -ne $loaderSha256) {
    throw "Windows 7 WebView2 loader replacement failed: $installedLoaderSha256"
  }

  $probeDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "dbx-win7-webview2-loader-probe"
  New-Item -ItemType Directory -Path $probeDirectory -Force | Out-Null
  $probeLoader = Join-Path $probeDirectory "WebView2Loader.dll"
  Copy-Item -LiteralPath $legacyLoaderDll -Destination $probeLoader -Force

  Write-Host "Prepared WebView2 SDK $sdkVersion static loader for Windows 7: $loaderDestination"
  Write-Host "Prepared WebView2 SDK $sdkVersion loader probe DLL: $probeLoader"
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
