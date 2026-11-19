[CmdletBinding()]
param(
  [string[]]$Targets = @("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$audit = Join-Path $PSScriptRoot "assert-windows-stack-reserve.ps1"
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $temporaryRoot "dbx-stack-reserve-probe-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path (Join-Path $directory "src") | Out-Null
$originalRustflags = [Environment]::GetEnvironmentVariable("RUSTFLAGS", "Process")
$originalEncodedRustflags = [Environment]::GetEnvironmentVariable("CARGO_ENCODED_RUSTFLAGS", "Process")
$hadRustflags = Test-Path Env:RUSTFLAGS
$hadEncodedRustflags = Test-Path Env:CARGO_ENCODED_RUSTFLAGS

function Restore-RustflagEnvironment {
  if ($hadRustflags) { $env:RUSTFLAGS = $originalRustflags }
  else { Remove-Item Env:RUSTFLAGS -ErrorAction SilentlyContinue }
  if ($hadEncodedRustflags) { $env:CARGO_ENCODED_RUSTFLAGS = $originalEncodedRustflags }
  else { Remove-Item Env:CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue }
}

# A real PE produced by Cargo verifies effective linker flags, including when
# an environment override takes precedence over the repository's target config.
# no_std keeps the cross-architecture probe independent of Windows SDK libraries.
[IO.File]::WriteAllText((Join-Path $directory "Cargo.toml"), @'
[package]
name = "stack-reserve-probe"
version = "0.0.0"
edition = "2021"
[workspace]
[profile.release]
panic = "abort"
'@)
[IO.File]::WriteAllText((Join-Path $directory "src/main.rs"), @'
#![no_std]
#![no_main]
#[no_mangle]
pub extern "C" fn mainCRTStartup() {}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
'@)

Push-Location $repositoryRoot
try {
  foreach ($mode in @("target-config", "environment")) {
    if ($mode -eq "environment") {
      if (!$hadRustflags -and !$hadEncodedRustflags) { continue }
      Restore-RustflagEnvironment
    } else {
      # An empty variable still overrides Cargo config in current PowerShell.
      Remove-Item Env:RUSTFLAGS, Env:CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue
    }
    foreach ($target in $Targets) {
      Write-Host "Verifying Windows stack reserve: $target ($mode)"
      & cargo rustc --offline --release --manifest-path (Join-Path $directory "Cargo.toml") --target $target --target-dir (Join-Path $directory "target") -- -C linker=rust-lld -C link-arg=/ENTRY:mainCRTStartup -C link-arg=/SUBSYSTEM:CONSOLE -C link-arg=/NODEFAULTLIB
      if ($LASTEXITCODE -ne 0) { throw "Failed to build the Windows stack probe for $target ($mode)" }
      & $audit -BinaryPath (Join-Path $directory "target/$target/release/stack-reserve-probe.exe")
    }
  }
} finally {
  Restore-RustflagEnvironment
  Pop-Location
  $resolved = [IO.Path]::GetFullPath($directory)
  if (!$resolved.StartsWith((Join-Path $temporaryRoot "dbx-stack-reserve-probe-"), [StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected cleanup path: $resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
