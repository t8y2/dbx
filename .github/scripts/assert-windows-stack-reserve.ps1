[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$BinaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$minimumStackReserve = [uint64](8 * 1024 * 1024)

foreach ($path in $BinaryPath) {
  if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Windows PE stack audit target does not exist: $path"
  }

  # Read only the headers: release executables can be hundreds of MiB.
  $image = [System.IO.File]::OpenRead((Get-Item -LiteralPath $path).FullName)
  $reader = [System.IO.BinaryReader]::new($image)
  try {
    if ($image.Length -lt 0x40 -or $reader.ReadUInt16() -ne 0x5A4D) {
      throw "Invalid or truncated DOS header in ${path}"
    }
    [void]$image.Seek(0x3C, [System.IO.SeekOrigin]::Begin)
    $peOffset = [long]$reader.ReadUInt32()
    if ($peOffset -lt 0x40 -or $peOffset + 24 -gt $image.Length) {
      throw "Invalid PE header offset in ${path}"
    }
    [void]$image.Seek($peOffset, [System.IO.SeekOrigin]::Begin)
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "Invalid PE signature in ${path}"
    }
    $machine = $reader.ReadUInt16()
    [void]$image.Seek($peOffset + 20, [System.IO.SeekOrigin]::Begin)
    $optionalHeaderSize = $reader.ReadUInt16()
    $optionalHeaderOffset = $peOffset + 24
    if ($optionalHeaderSize -lt 2 -or $optionalHeaderOffset + $optionalHeaderSize -gt $image.Length) {
      throw "Invalid or truncated PE optional header in ${path}"
    }
    [void]$image.Seek($optionalHeaderOffset, [System.IO.SeekOrigin]::Begin)
    $magic = $reader.ReadUInt16()
    $stackFieldSize = switch ($magic) {
      0x20B { 8 } # PE32+: x64 and ARM64.
      0x10B { 4 } # PE32.
      default { throw ("Unsupported PE optional header magic 0x{0:X4} in {1}" -f $magic, $path) }
    }
    if ($optionalHeaderSize -lt 72 + $stackFieldSize) {
      throw "PE optional header does not contain SizeOfStackReserve in ${path}"
    }
    [void]$image.Seek($optionalHeaderOffset + 72, [System.IO.SeekOrigin]::Begin)
    $stackReserve = if ($stackFieldSize -eq 8) { $reader.ReadUInt64() } else { [uint64]$reader.ReadUInt32() }
    if ($stackReserve -lt $minimumStackReserve) {
      throw ("Windows main-thread stack reserve is {0} bytes, below the {1}-byte minimum. Add -C link-arg=/STACK:8388608 to the build RUSTFLAGS. Binary: {2}" -f $stackReserve, $minimumStackReserve, $path)
    }
    Write-Host ("Windows PE stack reserve audit passed: {0} bytes, machine 0x{1:X4} ({2})" -f $stackReserve, $machine, $path)
  } finally {
    $reader.Dispose()
  }
}
