import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  BinaryCellImportTooLargeError,
  binaryCellDisplayText,
  binaryCellDownloadFileName,
  binaryCellDownloadPayload,
  canDownloadBinaryCellValue,
  formatBinaryCellByteSize,
  isBinaryCellColumnType,
  binaryCellUtf8Text,
  isBlobCellColumnType,
  MAX_BINARY_CELL_IMPORT_BYTES,
  parseBinaryCellBytes,
  parseBinaryCellHexValue,
  retainBinaryCellDownloadMenuForHover,
} from "../../apps/desktop/src/lib/dataGrid/binaryCellDownload.ts";

test("parseBinaryCellHexValue accepts 0x and \\x prefixed hex values", () => {
  assert.deepEqual(Array.from(parseBinaryCellHexValue("0X48656c6c6f") ?? []), [72, 101, 108, 108, 111]);
  assert.deepEqual(Array.from(parseBinaryCellHexValue("\\x00 ff") ?? []), [0, 255]);
  assert.deepEqual(Array.from(parseBinaryCellHexValue("0x") ?? []), []);
});

test("parseBinaryCellHexValue rejects non-hex and odd-length payloads", () => {
  assert.equal(parseBinaryCellHexValue("hello"), null);
  assert.equal(parseBinaryCellHexValue("0x123"), null);
  assert.equal(parseBinaryCellHexValue(null), null);
});

test("parseBinaryCellBytes accepts common driver binary shapes", () => {
  assert.deepEqual(Array.from(parseBinaryCellBytes("89504e47", "BLOB") ?? []), [137, 80, 78, 71]);
  assert.deepEqual(Array.from(parseBinaryCellBytes("0x534e2d4130303031", "VARBINARY(8)") ?? []), [83, 78, 45, 65, 48, 48, 48, 49]);
  assert.deepEqual(Array.from(parseBinaryCellBytes("0x3135303031300000", "BINARY(8)") ?? []), [49, 53, 48, 48, 49, 48, 0, 0]);
  assert.deepEqual(Array.from(parseBinaryCellBytes("\\x89\\x50\\x4e\\x47") ?? []), [137, 80, 78, 71]);
  assert.deepEqual(Array.from(parseBinaryCellBytes([0, 1, 171, 255]) ?? []), [0, 1, 171, 255]);
  assert.deepEqual(Array.from(parseBinaryCellBytes({ type: "Buffer", data: [222, 173, 190, 239] }) ?? []), [222, 173, 190, 239]);
});

test("TDengine BINARY text is not treated as unprefixed hex", () => {
  for (const value of ["66", "67", "81", "97"]) {
    assert.equal(parseBinaryCellBytes(value, "BINARY(16)", "tdengine"), null);
    assert.equal(binaryCellDisplayText(value, "BINARY(16)", undefined, "tdengine"), null);
    assert.equal(canDownloadBinaryCellValue(value, "BINARY(16)", "tdengine"), false);
  }
  assert.deepEqual(Array.from(parseBinaryCellBytes("0x3636", "BINARY(16)", "tdengine") ?? []), [54, 54]);
  assert.equal(binaryCellDisplayText("0x3636", "BINARY(16)", undefined, "tdengine"), "66");
});

test("binary cell download detects common blob column types", () => {
  assert.equal(isBinaryCellColumnType("BLOB"), true);
  assert.equal(isBinaryCellColumnType("RAW(2000)"), true);
  assert.equal(isBinaryCellColumnType("long raw"), true);
  assert.equal(isBinaryCellColumnType("varchar"), false);
  assert.equal(isBlobCellColumnType("longblob"), true);
  assert.equal(isBlobCellColumnType("varbinary(255)"), false);
});

test("binary cell download menu closes when hover moves to another cell", () => {
  const openCell = { rowIndex: 2, col: 4 };

  assert.equal(retainBinaryCellDownloadMenuForHover(openCell, { rowIndex: 3, col: 4 }), null);
  assert.equal(retainBinaryCellDownloadMenuForHover(openCell, { rowIndex: 2, col: 5 }), null);
  assert.equal(retainBinaryCellDownloadMenuForHover(openCell, { rowIndex: 2, col: 4 }), openCell);
});

test("transpose cell hover also clears a different binary download menu", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const handler = source.match(/function onTransposeCellMouseenter\([^]*?\n\}/)?.[0] ?? "";

  assert.match(handler, /retainBinaryCellDownloadMenuForHover\(quickDownloadMenuCell\.value, \{ rowIndex, col: actualColIdx \}\)/);
});

test("canDownloadBinaryCellValue allows displayed binary hex strings", () => {
  assert.equal(canDownloadBinaryCellValue("0x89504e47", "BLOB"), true);
  assert.equal(canDownloadBinaryCellValue("0x89504e47"), true);
  assert.equal(canDownloadBinaryCellValue("89504e47", "BLOB"), true);
  assert.equal(canDownloadBinaryCellValue("89504e47"), false);
});

test("binaryCellDisplayText previews printable binary strings without changing their raw bytes", () => {
  assert.equal(binaryCellDisplayText("0x534e2d4130303031", "VARBINARY(8)"), "SN-A0001");
  assert.equal(binaryCellDisplayText("0x534e2d4130303031", "VARBINARY(8)", undefined, "sqlite"), "SN-A0001");
  assert.equal(binaryCellDisplayText("0x3135303031300000", "BINARY(8)"), "150010");
  assert.equal(binaryCellDisplayText("0x0000", "BINARY(2)"), "");
  assert.equal(binaryCellDisplayText("0x68690a", "VARBINARY(3)"), "hi\n");
  assert.equal(binaryCellDisplayText("0x680069", "VARBINARY(3)"), "VARBINARY [3 bytes]");
  assert.equal(binaryCellDisplayText("0xdeadbeef", "VARBINARY(4)"), "VARBINARY [4 bytes]");
  assert.equal(binaryCellDisplayText("0x48656c6c6f", "LONGBLOB", undefined, "mysql"), "Hello");
  assert.equal(binaryCellDisplayText("0xe8a1a8e8bebee5bc8f", "LONGBLOB", undefined, "mysql"), "表达式");
  assert.equal(binaryCellDisplayText("0x89504e47", "BLOB"), "BLOB [4 bytes]");
  assert.equal(binaryCellDisplayText("0x680069", "LONGBLOB", undefined, "mysql"), "BLOB [3 bytes]");
  assert.equal(binaryCellDisplayText(`0x${"00".repeat(2048)}`, "VARBINARY(2048)"), "VARBINARY [2.0 KB]");
  assert.equal(binaryCellDisplayText("0xffd8ffe000104a46...", "VARBINARY"), "VARBINARY [...]");
  assert.equal(binaryCellDisplayText("0x89504e47...", "LONGBLOB"), "BLOB [...]");
  assert.equal(binaryCellDisplayText("0xffd8ffe000104a46...", "VARBINARY", 25_143), "VARBINARY [25 KB]");
  assert.equal(binaryCellDisplayText("0x89504e47"), null);
  assert.equal(binaryCellDisplayText("0x", "VARBINARY(0)"), "");
});

test("binaryCellUtf8Text only returns strict printable text", () => {
  assert.equal(binaryCellUtf8Text("0x2332303035383035", "LONGBLOB", "mysql"), "#2005805");
  assert.equal(binaryCellUtf8Text("0xfffe", "LONGBLOB", "mysql"), null);
  assert.equal(binaryCellUtf8Text("0x0061", "LONGBLOB", "mysql"), null);
  assert.equal(binaryCellUtf8Text("0x4869", "varchar", "mysql"), null);
});

// 回归：SQLite/DuckDB 等库同样有 `blob` 列，文本预览必须与编辑写回路径一样仅对 mysql 开启，
// 否则出现“单元格/详情显示文本、编辑器却是十六进制”的不一致。
test("BLOB text preview stays limited to MySQL connections", () => {
  assert.equal(binaryCellUtf8Text("0x2332303035383035", "LONGBLOB", "sqlite"), null);
  assert.equal(binaryCellUtf8Text("0x2332303035383035", "BLOB", "duckdb"), null);
  assert.equal(binaryCellUtf8Text("0x2332303035383035", "LONGBLOB", undefined), null);
  assert.equal(binaryCellDisplayText("0x2332303035383035", "LONGBLOB", undefined, "sqlite"), "BLOB [8 bytes]");
  assert.equal(binaryCellDisplayText("0x2332303035383035", "BLOB", undefined, "duckdb"), "BLOB [8 bytes]");
  assert.equal(binaryCellDisplayText("0x2332303035383035", "LONGBLOB", undefined), "BLOB [8 bytes]");
  assert.equal(binaryCellDisplayText("0x2332303035383035", "LONGBLOB", undefined, "mysql"), "#2005805");
  // binary/varbinary 的文本预览是既有行为（如 TDengine BINARY 文本），不受 mysql 闸门影响。
  assert.equal(binaryCellDisplayText("0x534e2d4130303031", "VARBINARY(8)", undefined, "sqlite"), "SN-A0001");
});

test("binaryCellDownloadPayload builds raw and decoded payloads", () => {
  const binary = binaryCellDownloadPayload("0x4869", "binary");
  assert.equal(binary.mimeType, "application/octet-stream");
  assert.equal(binary.extension, "bin");
  assert.deepEqual(Array.from(binary.data as Uint8Array), [72, 105]);

  const text = binaryCellDownloadPayload("0x4869", "utf8");
  assert.equal(text.mimeType, "text/plain;charset=utf-8");
  assert.equal(text.extension, "txt");
  assert.equal(text.data, "Hi");

  const paddedBinary = binaryCellDownloadPayload("0x3135303031300000", "binary", "BINARY(8)");
  assert.deepEqual(Array.from(paddedBinary.data as Uint8Array), [49, 53, 48, 48, 49, 48, 0, 0]);

  const emptyBinary = binaryCellDownloadPayload("0x", "binary", "VARBINARY(0)");
  assert.deepEqual(Array.from(emptyBinary.data as Uint8Array), []);
});

test("DataGrid binary preview prefers ResultSet column types when table metadata is unavailable", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const formatter = source.match(/function formatCell\([^]*?\n\}/)?.[0] ?? "";

  assert.match(formatter, /binaryCellDisplayText\(value, columnIndex === undefined \? undefined : allColumnTypes\.value\[columnIndex\], originalBytes, resolvedDatabaseType\.value\)/);
});

test("binaryCellDownloadPayload decodes GBK text bytes", () => {
  const payload = binaryCellDownloadPayload("0xd6d0cec4", "gbk");
  assert.equal(payload.data, "中文");
});

test("binaryCellDownloadFileName sanitizes column names", () => {
  assert.equal(binaryCellDownloadFileName({ column: "avatar/blob", rowNumber: 7, mode: "gbk", extension: "txt" }), "avatar-blob-row-7-gbk.txt");
});

test("MAX_BINARY_CELL_IMPORT_BYTES is a sane upper bound for single-cell imports", () => {
  // 16 MB: 单个 BLOB 单元格导入的保守上限，避免 readFile 全量读 + 2× hex 常驻导致 OOM。
  assert.equal(MAX_BINARY_CELL_IMPORT_BYTES, 16 * 1024 * 1024);
});

test("BinaryCellImportTooLargeError carries code and byte/limit for toast formatting", () => {
  const err = new BinaryCellImportTooLargeError(20 * 1024 * 1024, MAX_BINARY_CELL_IMPORT_BYTES);
  assert.equal(err.code, "binary-import-too-large");
  assert.equal(err.bytes, 20 * 1024 * 1024);
  assert.equal(err.limit, MAX_BINARY_CELL_IMPORT_BYTES);
  assert.ok(err instanceof Error);
});

test("formatBinaryCellByteSize formats human-readable sizes for the import toast", () => {
  assert.equal(formatBinaryCellByteSize(512), "512 bytes");
  assert.equal(formatBinaryCellByteSize(2048), "2.0 KB");
  // bytes >= 10 MB 时按整数 MB 显示（对齐 binaryCellDisplayText 既有格式）。
  assert.equal(formatBinaryCellByteSize(20 * 1024 * 1024), "20 MB");
});

test("DataGrid import handler surfaces a dedicated too-large toast instead of the generic failure", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");
  const handler = source.match(/async function importDetailBinaryValue\([^]*?\n\}/)?.[0] ?? "";

  // 闸门错误必须走专门的文案，而非通用 binaryImportFailed。
  assert.match(handler, /e instanceof BinaryCellImportTooLargeError/);
  assert.match(handler, /grid\.binaryImportTooLarge/);
  assert.match(handler, /formatBinaryCellByteSize\(e\.bytes\)/);
  assert.match(handler, /formatBinaryCellByteSize\(e\.limit\)/);
});
