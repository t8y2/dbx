import struct
import tempfile
import unittest
from pathlib import Path

from validate_windows_pe_dependencies import PeFormatError, forbidden_msvc_runtime_dlls, imported_dlls


def build_test_pe(imports: list[str]) -> bytes:
    data = bytearray(4096)
    pe_offset = 0x80
    optional_header_offset = pe_offset + 24
    optional_header_size = 0xF0
    section_table_offset = optional_header_offset + optional_header_size
    section_rva = 0x1000
    section_offset = 0x200
    import_directory_rva = section_rva

    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, pe_offset)
    data[pe_offset : pe_offset + 4] = b"PE\0\0"
    struct.pack_into("<H", data, pe_offset + 4, 0x8664)
    struct.pack_into("<H", data, pe_offset + 6, 1)
    struct.pack_into("<H", data, pe_offset + 20, optional_header_size)
    struct.pack_into("<H", data, optional_header_offset, 0x20B)
    struct.pack_into("<I", data, optional_header_offset + 60, section_offset)
    struct.pack_into("<I", data, optional_header_offset + 112 + 8, import_directory_rva)
    struct.pack_into("<I", data, optional_header_offset + 112 + 12, (len(imports) + 1) * 20)

    data[section_table_offset : section_table_offset + 8] = b".rdata\0\0"
    struct.pack_into("<I", data, section_table_offset + 8, 0x800)
    struct.pack_into("<I", data, section_table_offset + 12, section_rva)
    struct.pack_into("<I", data, section_table_offset + 16, 0x800)
    struct.pack_into("<I", data, section_table_offset + 20, section_offset)

    name_offset = section_offset + 0x200
    for index, name in enumerate(imports):
        descriptor_offset = section_offset + index * 20
        name_rva = section_rva + (name_offset - section_offset)
        struct.pack_into("<I", data, descriptor_offset + 12, name_rva)
        encoded = name.encode("ascii") + b"\0"
        data[name_offset : name_offset + len(encoded)] = encoded
        name_offset += len(encoded)

    return bytes(data)


class WindowsPeDependenciesTest(unittest.TestCase):
    def test_reads_imported_dll_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "driver.exe"
            path.write_bytes(build_test_pe(["KERNEL32.dll", "bcrypt.dll"]))

            self.assertEqual(imported_dlls(path), ["bcrypt.dll", "KERNEL32.dll"])

    def test_rejects_dynamic_visual_cpp_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "driver.exe"
            path.write_bytes(build_test_pe(["KERNEL32.dll", "MSVCP140.dll", "VCRUNTIME140_1.dll"]))

            self.assertEqual(
                forbidden_msvc_runtime_dlls(imported_dlls(path)),
                ["MSVCP140.dll", "VCRUNTIME140_1.dll"],
            )

    def test_rejects_non_pe_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "driver.exe"
            path.write_bytes(b"not a PE file")

            with self.assertRaisesRegex(PeFormatError, "missing DOS header"):
                imported_dlls(path)


if __name__ == "__main__":
    unittest.main()
