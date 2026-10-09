import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BinaryCellImportTooLargeError,
  binaryCellDisplayText,
  binaryCellClipboardText,
  binaryCellDownloadFileName,
  binaryCellDownloadPayload,
  binaryCellTextPreview,
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

// issue #9505：GaussDB（ZenithDriver）的 BLOB 已经以 binary canonical form `0x<hex>` 到达前端，
// 缺的是单元格详情里“显式、只读”的文本查看入口。此 helper 是通用 binary presentation 层，
// 不参与 MySQL BLOB 的自动文本预览闸门，也不进入编辑/提交路径。
function previewText(value: unknown, encoding: "utf8" | "gbk", columnType?: string, databaseType?: Parameters<typeof binaryCellTextPreview>[3], incomplete?: boolean): string | null {
  const result = binaryCellTextPreview(value, encoding, columnType, databaseType, incomplete);
  return result.ok ? result.text : null;
}

test("binaryCellTextPreview decodes explicit binary cells to strict UTF-8 text", () => {
  assert.deepEqual(binaryCellTextPreview("0x48656c6c6f", "utf8", "BLOB"), { ok: true, text: "Hello", encoding: "utf8", byteLength: 5 });
  // issue 复现值的前 14 字节：`[[headers = {}`。
  assert.deepEqual(binaryCellTextPreview("0x5b5b68656164657273203d207b7d", "utf8", "BLOB", "gaussdb"), { ok: true, text: "[[headers = {}", encoding: "utf8", byteLength: 14 });
  // 中文 UTF-8。
  assert.equal(previewText("0xe4b8ade69687", "utf8", "BLOB"), "中文");
  // 非 MySQL 连接同样可以显式查看：属于用户主动触发的只读 presentation。
  assert.equal(previewText("0x48656c6c6f", "utf8", "BLOB"), "Hello");
  assert.equal(previewText("0x48656c6c6f", "utf8", "BYTEA", "postgres"), "Hello");
  assert.equal(previewText("0x48656c6c6f", "utf8", "RAW(2000)", "oracle"), "Hello");
  assert.equal(previewText("0x48656c6c6f", "utf8", "LONG RAW", "oracle"), "Hello");
  assert.equal(previewText("0x48656c6c6f", "utf8", "IMAGE", "sqlserver"), "Hello");
  // 入口可见性完全复用 isBinaryCellColumnType()，本次不放宽该闸门。
  for (const type of ["BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "BINARY(8)", "VARBINARY(255)", "BYTEA", "RAW(2000)", "LONG RAW", "IMAGE", "bytes"]) {
    assert.equal(isBinaryCellColumnType(type), true, type);
    assert.equal(previewText("0x48656c6c6f", "utf8", type), "Hello", type);
  }
  // byte[] / Buffer 形态的 binary cell 同样支持。
  assert.equal(previewText([72, 105], "utf8", "VARBINARY(2)"), "Hi");
  assert.equal(previewText({ type: "Buffer", data: [72, 105] }, "utf8", "VARBINARY(2)"), "Hi");
  // 定长 BINARY 的尾部填充 NUL 与网格预览一致地裁掉。
  assert.equal(previewText("0x3135303031300000", "utf8", "BINARY(8)"), "150010");
  // 与“下载为 UTF-8/GBK”共用同一套 bytes primitive。
  assert.deepEqual(Array.from(parseBinaryCellBytes("0x48656c6c6f", "BLOB") ?? []), Array.from(binaryCellDownloadPayload("0x48656c6c6f", "binary", "BLOB").data as Uint8Array));
});

test("binaryCellTextPreview decodes GBK bytes when the user picks GBK", () => {
  assert.equal(previewText("0xd6d0cec4", "gbk", "BLOB"), "中文");
  assert.equal(previewText("0xd6d0cec4", "gbk", "BLOB", "gaussdb"), "中文");
  // UTF-8 仍是默认选项：GBK 字节不会被静默替换字符冒充文本。
  assert.deepEqual(binaryCellTextPreview("0xd6d0cec4", "utf8", "BLOB"), { ok: false, error: "undecodable" });
});

// 真实二进制（图片头、非法序列、控制字节、GBK 私用区）必须显式失败，绝不能静默替换字符。
test("binaryCellTextPreview refuses real binary instead of silently replacing characters", () => {
  assert.deepEqual(binaryCellTextPreview("0x89504e470d0a1a0a", "utf8", "BLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0xffd8ffe0", "utf8", "LONGBLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0xfffe", "utf8", "BLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0x0061", "utf8", "BLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0x89504e470d0a1a0a", "gbk", "BLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0xffff", "gbk", "BLOB"), { ok: false, error: "undecodable" });
  assert.deepEqual(binaryCellTextPreview("0x0102", "gbk", "BLOB"), { ok: false, error: "undecodable" });
});

test("binaryCellTextPreview stays out of non-binary and incomplete cells", () => {
  assert.deepEqual(binaryCellTextPreview("0x48656c6c6f", "utf8", "varchar(20)"), { ok: false, error: "notBinary" });
  assert.deepEqual(binaryCellTextPreview("0x48656c6c6f", "utf8"), { ok: false, error: "notBinary" });
  assert.deepEqual(binaryCellTextPreview("Hello", "utf8", "BLOB"), { ok: false, error: "notBinary" });
  assert.deepEqual(binaryCellTextPreview(null, "utf8", "BLOB"), { ok: false, error: "notBinary" });
  // 大值闸门把 `0x<hex>` 本身截成 `0x...` 时，前缀不是完整 bytes。
  assert.deepEqual(binaryCellTextPreview("0xffd8ffe000104a46...", "utf8", "LONGBLOB"), { ok: false, error: "notBinary" });
  // 后端返回的值本身不完整时不解码残缺 bytes。
  assert.deepEqual(binaryCellTextPreview("0x48656c6c6f", "utf8", "BLOB", undefined, true), { ok: false, error: "incomplete" });
  // TDengine 的 BINARY 裸 hex 是文本而不是 bytes。
  assert.deepEqual(binaryCellTextPreview("66", "utf8", "BINARY(16)", "tdengine"), { ok: false, error: "notBinary" });
});

test("binaryCellTextPreview never mutates the canonical binary value", () => {
  const canonical = "0x48656c6c6f";
  assert.equal(previewText(canonical, "utf8", "BLOB"), "Hello");
  assert.equal(canonical, "0x48656c6c6f");
  const bytes = [0x48, 0x69];
  assert.equal(previewText(bytes, "utf8", "VARBINARY(2)"), "Hi");
  assert.deepEqual(bytes, [0x48, 0x69]);
  const ascii = "0x534e2d4130303031";
  assert.equal(previewText(ascii, "gbk", "VARBINARY(8)"), "SN-A0001");
  assert.equal(ascii, "0x534e2d4130303031");
});

// 群反馈：MySQL varbinary 里以 GBK 写入的中文（Navicat 按连接字符集直接显示）。
// UTF-8 严格解码失败后，仅 MySQL 的 binary/varbinary 在显示/复制路径回退严格 GBK；
// BLOB 与编辑写回路径保持纯 UTF-8（与 coerceMysqlBlobTextValue 同闸门）。
test("MySQL varbinary text preview falls back to strict GBK after UTF-8", () => {
  // "2026年5月22日 星期五 9：30" 的 GBK 编码（26 字节；UTF-8 编码为 33 字节）。
  const gbkHex = "0x32303236c4ea35d4c23232c8d520d0c7c6dacee52039a3ba3330";
  assert.equal(binaryCellDisplayText(gbkHex, "VARBINARY(255)", undefined, "mysql"), "2026年5月22日 星期五 9：30");
  assert.equal(binaryCellClipboardText(gbkHex, "VARBINARY(255)", "mysql"), "2026年5月22日 星期五 9：30");
  assert.equal(binaryCellDisplayText("0xd6d0cec4", "VARBINARY(255)", undefined, "mysql"), "中文");
  assert.equal(binaryCellClipboardText("0xd6d0cec4", "VARBINARY(128)", "mysql"), "中文");
  // UTF-8 优先：两种编码都能表达时结果一致。
  assert.equal(binaryCellDisplayText("0xe4b8ade69687", "VARBINARY(128)", undefined, "mysql"), "中文");

  // GBK 回退仅限 MySQL 连接。
  assert.equal(binaryCellDisplayText("0xd6d0cec4", "VARBINARY(255)", undefined, "sqlserver"), "VARBINARY [4 bytes]");
  assert.equal(binaryCellDisplayText("0xd6d0cec4", "VARBINARY(255)", undefined, undefined), "VARBINARY [4 bytes]");

  // MySQL BLOB 不参与 GBK 回退（保持与编辑路径的显示/编辑一致性）。
  assert.equal(binaryCellDisplayText("0xd6d0cec4", "LONGBLOB", undefined, "mysql"), "BLOB [4 bytes]");
  assert.equal(binaryCellUtf8Text("0xd6d0cec4", "LONGBLOB", "mysql"), null);

  // 非法 GBK 序列、以及解码落在 Unicode 私用区的（真实文本不含 PUA）仍回退标签 / 保持 hex。
  assert.equal(binaryCellDisplayText("0xfffe", "VARBINARY(2)", undefined, "mysql"), "VARBINARY [2 bytes]");
  assert.equal(binaryCellDisplayText("0xffff", "VARBINARY(2)", undefined, "mysql"), "VARBINARY [2 bytes]");
  assert.equal(binaryCellClipboardText("0xffff", "VARBINARY(2)", "mysql"), null);
});

// issue #7471：MySQL VARBINARY 的文本 payload 复制为原始字符串，任意二进制保持 0x/hex 无损。
test("binaryCellClipboardText decodes textual MySQL varbinary and preserves arbitrary bytes", () => {
  // Case 1: ASCII VARBINARY（issue 示例 abc → 0x616263）。
  assert.equal(binaryCellClipboardText("0x616263", "VARBINARY(128)", "mysql"), "abc");
  // Case 2: 数字字符串。
  assert.equal(binaryCellClipboardText("0x31", "VARBINARY(128)", "mysql"), "1");
  assert.equal(binaryCellClipboardText("0x6b384a39784c326d51347650", "VARBINARY(128)", "mysql"), "k8J9xL2mQ4vP");
  // Case 3: 较长 ASCII token 必须完整复制。
  assert.equal(binaryCellClipboardText("0x75736572393832335f746f6b656e5f586b38396d4e32714c307750347652", "VARBINARY(128)", "mysql"), "user9823_token_Xk89mN2qL0wP4vR");
  // Case 4: UTF-8 中文 lossless round-trip。
  assert.equal(binaryCellClipboardText("0xe4b8ade69687", "VARBINARY(128)", "mysql"), "中文");
  // emoji（多字节 UTF-8）。
  assert.equal(binaryCellClipboardText("0xf09f9880", "VARBINARY(64)", "mysql"), "😀");
  // 空字符串及允许的文本换行。
  assert.equal(binaryCellClipboardText("0x", "VARBINARY(0)", "mysql"), "");
  assert.equal(binaryCellClipboardText("0x68690a", "VARBINARY(3)", "mysql"), "hi\n");

  // Case 5: 无法解码的 arbitrary binary（含 NUL / 含控制字符 / 非法序列）保持 null → 复制端沿用 0x/hex，绝不产生 � 或丢字节。
  // 0xdeadbeef 例外：恰好全部组成合法 GBK 序列，随 GBK 回退按解码文本复制（与网格显示一致）。
  assert.equal(binaryCellClipboardText("0xdeadbeef", "VARBINARY(4)", "mysql"), "蕲撅");
  assert.equal(binaryCellClipboardText("0xfffe", "VARBINARY(2)", "mysql"), null);
  assert.equal(binaryCellClipboardText("0x0061", "VARBINARY(2)", "mysql"), null); // 含 NUL
  assert.equal(binaryCellClipboardText("0x0102", "VARBINARY(2)", "mysql"), null); // 控制字符
  assert.equal(binaryCellClipboardText("0xefbbbf616263", "VARBINARY(6)", "mysql"), null); // 解码会吞 BOM，无法 byte-for-byte 回编码

  // Case 6: NULL 保持原行为（helper 只处理字符串形态的 hex 值）。
  assert.equal(binaryCellClipboardText(null, "VARBINARY(128)", "mysql"), null);

  // Case 7: 非目标类型 / 非 MySQL 一律不改写，回归保护。
  assert.equal(binaryCellClipboardText("0x616263", "BLOB", "mysql"), null); // MySQL BLOB 不跟随
  assert.equal(binaryCellClipboardText("0x616263", "LONGBLOB", "mysql"), null);
  assert.equal(binaryCellClipboardText("0x616263", "BINARY(8)", "mysql"), null); // MySQL BINARY 不跟随
  assert.equal(binaryCellClipboardText("0x616263", "VARBINARY(128)", "sqlserver"), null); // SQL Server varbinary 不改
  assert.equal(binaryCellClipboardText("0x616263", "bytea", "postgres"), null); // Postgres bytea 不改
  assert.equal(binaryCellClipboardText("0x616263", "BINARY(16)", "tdengine"), null); // 非 MySQL BINARY 不改
  assert.equal(binaryCellClipboardText("0x616263", "varchar", "mysql"), null); // 非二进制列不改
  assert.equal(binaryCellClipboardText("abcd", "VARBINARY(4)", "mysql"), null); // 普通文本不猜测为裸 hex
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
