#!/usr/bin/env python3

import argparse
import struct
from pathlib import Path


class PeFormatError(ValueError):
    pass


def _read_u16(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 2 > len(data):
        raise PeFormatError("unexpected end of PE file")
    return struct.unpack_from("<H", data, offset)[0]


def _read_u32(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise PeFormatError("unexpected end of PE file")
    return struct.unpack_from("<I", data, offset)[0]


def _read_c_string(data: bytes, offset: int) -> str:
    if offset < 0 or offset >= len(data):
        raise PeFormatError("PE string offset is outside the file")
    end = data.find(b"\0", offset)
    if end < 0:
        raise PeFormatError("unterminated PE string")
    try:
        return data[offset:end].decode("ascii")
    except UnicodeDecodeError as error:
        raise PeFormatError("PE import name is not ASCII") from error


def imported_dlls(path: Path) -> list[str]:
    data = path.read_bytes()
    if len(data) < 64 or data[:2] != b"MZ":
        raise PeFormatError("missing DOS header")

    pe_offset = _read_u32(data, 0x3C)
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise PeFormatError("missing PE signature")

    section_count = _read_u16(data, pe_offset + 6)
    optional_header_size = _read_u16(data, pe_offset + 20)
    optional_header_offset = pe_offset + 24
    optional_magic = _read_u16(data, optional_header_offset)
    if optional_magic == 0x20B:
        data_directories_offset = optional_header_offset + 112
    elif optional_magic == 0x10B:
        data_directories_offset = optional_header_offset + 96
    else:
        raise PeFormatError(f"unsupported PE optional header magic: 0x{optional_magic:04x}")

    import_directory_rva = _read_u32(data, data_directories_offset + 8)
    import_directory_size = _read_u32(data, data_directories_offset + 12)
    if import_directory_rva == 0 or import_directory_size == 0:
        return []

    size_of_headers = _read_u32(data, optional_header_offset + 60)
    section_table_offset = optional_header_offset + optional_header_size
    sections = []
    for index in range(section_count):
        section_offset = section_table_offset + index * 40
        sections.append(
            (
                _read_u32(data, section_offset + 12),
                _read_u32(data, section_offset + 8),
                _read_u32(data, section_offset + 20),
                _read_u32(data, section_offset + 16),
            )
        )

    def rva_to_offset(rva: int) -> int:
        if rva < size_of_headers:
            return rva
        for virtual_address, virtual_size, raw_offset, raw_size in sections:
            span = max(virtual_size, raw_size)
            if virtual_address <= rva < virtual_address + span:
                delta = rva - virtual_address
                if delta >= raw_size:
                    break
                return raw_offset + delta
        raise PeFormatError(f"PE RVA 0x{rva:x} is not backed by file data")

    descriptor_offset = rva_to_offset(import_directory_rva)
    imports = []
    for _ in range(4096):
        if descriptor_offset + 20 > len(data):
            raise PeFormatError("truncated PE import descriptor")
        descriptor = data[descriptor_offset : descriptor_offset + 20]
        if descriptor == b"\0" * 20:
            return sorted(set(imports), key=str.casefold)
        name_rva = _read_u32(data, descriptor_offset + 12)
        if name_rva == 0:
            raise PeFormatError("PE import descriptor has no DLL name")
        imports.append(_read_c_string(data, rva_to_offset(name_rva)))
        descriptor_offset += 20

    raise PeFormatError("PE import descriptor table is not terminated")


def forbidden_msvc_runtime_dlls(imports: list[str]) -> list[str]:
    return sorted(
        {name for name in imports if name.casefold().startswith(("msvcp", "vcruntime"))},
        key=str.casefold,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Reject Windows PE files that require the Visual C++ runtime")
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()

    try:
        imports = imported_dlls(args.binary)
    except (OSError, PeFormatError) as error:
        parser.error(str(error))

    forbidden = forbidden_msvc_runtime_dlls(imports)
    if forbidden:
        parser.error(f"dynamic Visual C++ runtime dependencies found: {', '.join(forbidden)}")

    print(f"Validated {args.binary}: {len(imports)} imported DLLs, no dynamic Visual C++ runtime")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
