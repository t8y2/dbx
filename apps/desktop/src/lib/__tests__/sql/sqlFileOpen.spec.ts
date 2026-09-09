// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  ExternalSqlFileTooLargeError,
  clampExternalSqlEditorMaxMbInput,
  externalSqlEditorMaxBytes,
  externalSqlFileDisplayTitles,
  externalSqlFileOpenErrorMessage,
  formatSqlFileSize,
  isSqlFilePath,
  MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
  MAX_EXTERNAL_SQL_EDITOR_FILE_MB,
  MIN_EXTERNAL_SQL_EDITOR_FILE_MB,
  normalizeExternalSqlEditorMaxMb,
  normalizeExternalSqlPath,
  readBrowserSqlFile,
} from "@/lib/sql/sqlFileOpen";

describe("external SQL file paths", () => {
  it("normalizes Windows separators for identity checks", () => {
    expect(normalizeExternalSqlPath(" C:\\work\\demo.sql ")).toBe("C:/work/demo.sql");
  });

  it("distinguishes SQL files from other filtered text files", () => {
    expect(isSqlFilePath("C:\\work\\demo.SQL")).toBe(true);
    expect(isSqlFilePath("/work/script.py")).toBe(false);
  });

  it("uses the shortest unique parent path for duplicate filenames", () => {
    expect(externalSqlFileDisplayTitles(["/work/demo/create.sql", "/work/learn/create.sql", "/work/query.sql"])).toEqual(["demo/create.sql", "learn/create.sql", "query.sql"]);
  });

  it("adds more parent segments when immediate parents also collide", () => {
    expect(externalSqlFileDisplayTitles(["/one/sql/create.sql", "/two/sql/create.sql"])).toEqual(["one/sql/create.sql", "two/sql/create.sql"]);
  });
});

describe("external SQL file editor limit", () => {
  it("accepts the exact browser editor limit", async () => {
    const file = new Blob(["select 1;"]);
    Object.defineProperty(file, "size", { value: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES });

    await expect(readBrowserSqlFile(file)).resolves.toBe("select 1;");
  });

  it("rejects browser files above the editor limit before reading", async () => {
    const file = new Blob(["select 1;"]);
    Object.defineProperty(file, "size", { value: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1 });

    await expect(readBrowserSqlFile(file)).rejects.toMatchObject({
      name: "ExternalSqlFileTooLargeError",
      sizeBytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES + 1,
      maxSizeBytes: MAX_EXTERNAL_SQL_EDITOR_FILE_BYTES,
    });
  });

  it("honors a custom browser editor limit", async () => {
    const file = new Blob(["select 1;"]);
    Object.defineProperty(file, "size", { value: 8 });

    await expect(readBrowserSqlFile(file, 4)).rejects.toMatchObject({
      name: "ExternalSqlFileTooLargeError",
      sizeBytes: 8,
      maxSizeBytes: 4,
    });
  });

  it("normalizes the configurable editor size limit in MB", () => {
    expect(normalizeExternalSqlEditorMaxMb(undefined)).toBe(64);
    expect(normalizeExternalSqlEditorMaxMb(0)).toBe(MIN_EXTERNAL_SQL_EDITOR_FILE_MB);
    expect(normalizeExternalSqlEditorMaxMb(128)).toBe(128);
    expect(normalizeExternalSqlEditorMaxMb(99999)).toBe(MAX_EXTERNAL_SQL_EDITOR_FILE_MB);
    expect(normalizeExternalSqlEditorMaxMb(12.6)).toBe(13);
  });

  it("clamps the editor size limit input", () => {
    expect(clampExternalSqlEditorMaxMbInput("abc")).toBe(MIN_EXTERNAL_SQL_EDITOR_FILE_MB);
    expect(clampExternalSqlEditorMaxMbInput(0)).toBe(MIN_EXTERNAL_SQL_EDITOR_FILE_MB);
    expect(clampExternalSqlEditorMaxMbInput(256)).toBe(256);
    expect(clampExternalSqlEditorMaxMbInput(99999)).toBe(MAX_EXTERNAL_SQL_EDITOR_FILE_MB);
  });

  it("converts the editor size limit to bytes", () => {
    expect(externalSqlEditorMaxBytes(64)).toBe(64 * 1024 * 1024);
  });

  it("formats large file sizes", () => {
    expect(formatSqlFileSize(64 * 1024 * 1024)).toBe("64.0 MB");
    expect(formatSqlFileSize(50 * 1024 * 1024 * 1024)).toBe("50.0 GB");
  });

  it("builds a localized actionable message for oversized files", () => {
    const message = externalSqlFileOpenErrorMessage(new ExternalSqlFileTooLargeError(50 * 1024 ** 3, 64 * 1024 ** 2), (_key, params) => `${params.size}/${params.limit}`);

    expect(message).toBe("50.0 GB/64.0 MB");
  });

  it("preserves ordinary backend error messages", () => {
    expect(externalSqlFileOpenErrorMessage(new Error("permission denied"), () => "unused")).toBe("permission denied");
  });
});
