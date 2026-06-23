import { describe, expect, it } from "vitest";
import { CREATE_DATABASE_CHARSET_OPTIONS, createDatabaseCollationOptionsForCharset, defaultCreateDatabaseCollationForCharset, normalizeCreateDatabaseCharset, parseCreateDatabaseCharsetMetadata, nextCreateDatabaseCollation } from "@/lib/createDatabaseCharsetOptions";

describe("createDatabaseCharsetOptions", () => {
  it("offers common MySQL character sets with utf8mb4 first", () => {
    expect(CREATE_DATABASE_CHARSET_OPTIONS.slice(0, 4)).toEqual(["utf8mb4", "utf8", "gbk", "latin1"]);
    expect(CREATE_DATABASE_CHARSET_OPTIONS).toEqual(expect.arrayContaining(["ascii", "big5", "gb2312", "utf16", "utf32"]));
  });

  it("normalizes typed custom values without changing their case", () => {
    expect(normalizeCreateDatabaseCharset("  utf8mb3  ")).toBe("utf8mb3");
    expect(normalizeCreateDatabaseCharset("Big5")).toBe("Big5");
  });

  it("offers common collations for the selected character set", () => {
    expect(createDatabaseCollationOptionsForCharset("utf8mb4").slice(0, 3)).toEqual(["utf8mb4_unicode_ci", "utf8mb4_general_ci", "utf8mb4_bin"]);
    expect(createDatabaseCollationOptionsForCharset("utf8mb4")).toEqual(expect.arrayContaining(["utf8mb4_bin"]));
    expect(createDatabaseCollationOptionsForCharset("utf8mb4").some((collation) => collation.includes("0900"))).toBe(false);
    expect(createDatabaseCollationOptionsForCharset("gbk")).toEqual(["gbk_chinese_ci", "gbk_bin"]);
    expect(createDatabaseCollationOptionsForCharset("utf8")).toEqual(createDatabaseCollationOptionsForCharset("utf8mb3"));
  });

  it("parses server-provided character sets and collations", () => {
    const metadata = parseCreateDatabaseCharsetMetadata(
      {
        columns: ["Charset", "Description", "Default collation", "Maxlen"],
        rows: [
          ["utf8mb4", "UTF-8 Unicode", "utf8mb4_general_ci", 4],
          ["gbk", "GBK Simplified Chinese", "gbk_chinese_ci", 2],
        ],
      },
      {
        columns: ["Collation", "Charset", "Id", "Default", "Compiled", "Sortlen"],
        rows: [
          ["utf8mb4_general_ci", "utf8mb4", 45, "Yes", "Yes", 1],
          ["utf8mb4_unicode_ci", "utf8mb4", 224, "", "Yes", 8],
          ["gbk_chinese_ci", "gbk", 28, "Yes", "Yes", 1],
        ],
      },
    );

    expect(metadata.charsets).toEqual(["utf8mb4", "gbk"]);
    expect(metadata.collationsByCharset.utf8mb4).toEqual(["utf8mb4_general_ci", "utf8mb4_unicode_ci"]);
    expect(metadata.collationsByCharset.gbk).toEqual(["gbk_chinese_ci"]);
  });

  it("keeps server-provided utf8mb4 collations while hiding 0900 entries from the dropdown", () => {
    const metadata = parseCreateDatabaseCharsetMetadata(
      {
        columns: ["Charset", "Description", "Default collation", "Maxlen"],
        rows: [["utf8mb4", "UTF-8 Unicode", "utf8mb4_0900_ai_ci", 4]],
      },
      {
        columns: ["Collation", "Charset", "Id", "Default", "Compiled", "Sortlen"],
        rows: [
          ["utf8mb4_0900_ai_ci", "utf8mb4", 255, "Yes", "Yes", 0],
          ["utf8mb4_general_ci", "utf8mb4", 45, "", "Yes", 1],
          ["utf8mb4_unicode_ci", "utf8mb4", 224, "", "Yes", 8],
          ["utf8mb4_unicode_520_ci", "utf8mb4", 246, "", "Yes", 8],
          ["utf8mb4_bin", "utf8mb4", 46, "", "Yes", 1],
        ],
      },
    );

    expect(metadata.collationsByCharset.utf8mb4).toEqual(["utf8mb4_general_ci", "utf8mb4_unicode_ci", "utf8mb4_unicode_520_ci", "utf8mb4_bin"]);
  });

  it("keeps custom collations unless the previous value was the old charset default", () => {
    expect(defaultCreateDatabaseCollationForCharset("latin1")).toBe("latin1_swedish_ci");
    expect(nextCreateDatabaseCollation("gbk", "utf8mb4", "utf8mb4_unicode_ci")).toBe("gbk_chinese_ci");
    expect(nextCreateDatabaseCollation("gbk", "utf8mb4", "custom_ci")).toBe("custom_ci");
  });
});
