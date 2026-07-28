import { describe, expect, it } from "vitest";
import { ExternalSqlFileTooLargeError, externalSqlFileDisplayTitles, externalSqlFileOpenErrorMessage, formatSqlFileSize, normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";

describe("external SQL file paths", () => {
  it("normalizes Windows separators for identity checks", () => {
    expect(normalizeExternalSqlPath(" C:\\work\\demo.sql ")).toBe("C:/work/demo.sql");
  });

  it("uses the shortest unique parent path for duplicate filenames", () => {
    expect(externalSqlFileDisplayTitles(["/work/demo/create.sql", "/work/learn/create.sql", "/work/query.sql"])).toEqual(["demo/create.sql", "learn/create.sql", "query.sql"]);
  });

  it("adds more parent segments when immediate parents also collide", () => {
    expect(externalSqlFileDisplayTitles(["/one/sql/create.sql", "/two/sql/create.sql"])).toEqual(["one/sql/create.sql", "two/sql/create.sql"]);
  });
});

describe("external SQL file editor limit", () => {
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
