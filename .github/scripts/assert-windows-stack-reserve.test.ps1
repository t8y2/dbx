Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$audit = Join-Path $PSScriptRoot "assert-windows-stack-reserve.ps1"
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $temporaryRoot "dbx-stack-reserve-tests-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $directory | Out-Null
$passed = 0

function New-TestImage {
  param([int]$Machine = 0x8664, [int]$Magic = 0x20B, [uint64]$StackReserve = 8388608)
  $bytes = [byte[]]::new(512)
  [BitConverter]::GetBytes([uint16]0x5A4D).CopyTo($bytes, 0)
  [BitConverter]::GetBytes([uint32]0x80).CopyTo($bytes, 0x3C)
  [BitConverter]::GetBytes([uint32]0x4550).CopyTo($bytes, 0x80)
  [BitConverter]::GetBytes([uint16]$Machine).CopyTo($bytes, 0x84)
  [BitConverter]::GetBytes([uint16]0xF0).CopyTo($bytes, 0x94)
  [BitConverter]::GetBytes([uint16]$Magic).CopyTo($bytes, 0x98)
  if ($Magic -eq 0x10B) {
    [BitConverter]::GetBytes([uint32]$StackReserve).CopyTo($bytes, 0xE0)
  } else {
    [BitConverter]::GetBytes($StackReserve).CopyTo($bytes, 0xE0)
  }
  return ,$bytes
}

function Test-Image {
  param([string]$Name, [byte[]]$Bytes, [string]$ExpectedError = "")
  $path = Join-Path $directory "$Name.exe"
  [IO.File]::WriteAllBytes($path, $Bytes)
  $before = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
  $failure = $null
  try { & $audit -BinaryPath $path } catch { $failure = $_.Exception.Message }
  if ($ExpectedError) {
    if (!$failure -or $failure -notlike "*$ExpectedError*") { throw "${Name}: expected '$ExpectedError', got '$failure'" }
  } elseif ($failure) {
    throw "${Name}: unexpected failure: $failure"
  }
  if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $before) { throw "${Name}: audit modified the executable" }
  $script:passed++
}

try {
  foreach ($machine in @(0x8664, 0xAA64)) {
    Test-Image "minimum-$machine" (New-TestImage -Machine $machine)
    Test-Image "larger-$machine" (New-TestImage -Machine $machine -StackReserve 16777216)
    Test-Image "default-$machine" (New-TestImage -Machine $machine -StackReserve 1048576) "below the 8388608-byte minimum"
  }
  Test-Image "pe32" (New-TestImage -Machine 0x14C -Magic 0x10B)
  Test-Image "pe32-default" (New-TestImage -Machine 0x14C -Magic 0x10B -StackReserve 1048576) "below the 8388608-byte minimum"
  Test-Image "below-minimum" (New-TestImage -StackReserve 8388607) "below the 8388608-byte minimum"
  Test-Image "large-pe64-reserve" (New-TestImage -StackReserve 4294967296)
  Test-Image "empty" ([byte[]]::new(0)) "DOS header"
  Test-Image "truncated-dos" ([byte[]]::new(32)) "DOS header"
  $bytes = New-TestImage; $bytes[0] = 0
  Test-Image "bad-dos-signature" $bytes "DOS header"
  $bytes = New-TestImage; [BitConverter]::GetBytes([uint32]4294967280).CopyTo($bytes, 0x3C)
  Test-Image "out-of-range-pe-offset" $bytes "PE header offset"
  $bytes = New-TestImage; [BitConverter]::GetBytes([uint32]32).CopyTo($bytes, 0x3C)
  Test-Image "pe-offset-inside-dos" $bytes "PE header offset"
  $bytes = New-TestImage; $bytes[0x80] = 0
  Test-Image "bad-pe-signature" $bytes "PE signature"
  $bytes = New-TestImage
  Test-Image "truncated-optional-header" ([byte[]]$bytes[0..180]) "truncated PE optional header"
  $bytes = New-TestImage; [BitConverter]::GetBytes([uint16]1).CopyTo($bytes, 0x94)
  Test-Image "missing-optional-magic" $bytes "PE optional header"
  $bytes = New-TestImage; [BitConverter]::GetBytes([uint16]72).CopyTo($bytes, 0x94)
  Test-Image "missing-stack-field" $bytes "SizeOfStackReserve"
  $bytes = New-TestImage; [BitConverter]::GetBytes([uint16]79).CopyTo($bytes, 0x94)
  Test-Image "truncated-pe64-stack-field" $bytes "SizeOfStackReserve"
  $bytes = New-TestImage -Magic 0x10B; [BitConverter]::GetBytes([uint16]75).CopyTo($bytes, 0x94)
  Test-Image "truncated-pe32-stack-field" $bytes "SizeOfStackReserve"
  Test-Image "unknown-magic" (New-TestImage -Magic 0x999) "optional header magic"

  & $audit -BinaryPath @((Join-Path $directory "minimum-34404.exe"), (Join-Path $directory "minimum-43620.exe"))
  $passed++
  $missing = Join-Path $directory "missing.exe"
  try { & $audit -BinaryPath $missing; throw "Missing target was accepted" } catch {
    if ($_.Exception.Message -notlike "*target does not exist*") { throw }
  }
  $passed++
  Write-Host "Windows stack reserve audit tests passed: $passed cases"
} finally {
  $resolved = [IO.Path]::GetFullPath($directory)
  if (!$resolved.StartsWith((Join-Path $temporaryRoot "dbx-stack-reserve-tests-"), [StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected cleanup path: $resolved" }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
