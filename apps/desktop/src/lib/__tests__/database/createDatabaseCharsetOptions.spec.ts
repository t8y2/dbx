import { describe, expect, it } from "vitest";
import {
  CREATE_DATABASE_CHARSET_OPTIONS,
  createDatabaseCollationOptionsForCharset,
  defaultCreateDatabaseCollationForCharset,
  normalizeCreateDatabaseCharset,
  parseCreateDatabaseCharsetMetadata,
  nextCreateDatabaseCollation,
  POSTGRES_DATABASE_ENCODINGS,
} from "@/lib/database/createDatabaseCharsetOptions";

describe("createDatabaseCharsetOptions", () => {
  it("offers common MySQL character sets with utf8mb4 first", () => {
    expect(CREATE_DATABASE_CHARSET_OPTIONS.slice(0, 4)).toEqual(["utf8mb4", "utf8", "gbk", "latin1"]);
    expect(CREATE_DATABASE_CHARSET_OPTIONS).toEqual(expect.arrayContaining(["ascii", "big5", "gb2312", "utf16", "utf32"]));
  });

  it("includes the PostgreSQL server encodings", () => {
    expect(POSTGRES_DATABASE_ENCODINGS).toEqual([
      "BIG5",
      "EUC_CN",
      "EUC_JP",
      "EUC_JIS_2004",
      "EUC_KR",
      "EUC_TW",
      "GB18030",
      "GBK",
      "ISO_8859_5",
      "ISO_8859_6",
      "ISO_8859_7",
      "ISO_8859_8",
      "JOHAB",
      "KOI8R",
      "KOI8U",
      "LATIN1",
      "LATIN2",
      "LATIN3",
      "LATIN4",
      "LATIN5",
      "LATIN6",
      "LATIN7",
      "LATIN8",
      "LATIN9",
      "LATIN10",
      "MULE_INTERNAL",
      "SJIS",
      "SHIFT_JIS_2004",
      "SQL_ASCII",
      "UHC",
      "UTF8",
      "WIN866",
      "WIN874",
      "WIN1250",
      "WIN1251",
      "WIN1252",
      "WIN1253",
      "WIN1254",
      "WIN1255",
      "WIN1256",
      "WIN1257",
      "WIN1258",
    ]);
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

  it("keeps server-provided MySQL 8 utf8mb4 collations", () => {
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

    expect(metadata.collationsByCharset.utf8mb4).toEqual(["utf8mb4_0900_ai_ci", "utf8mb4_general_ci", "utf8mb4_unicode_ci", "utf8mb4_unicode_520_ci", "utf8mb4_bin"]);
  });

  it("keeps custom collations unless the previous value was the old charset default", () => {
    expect(defaultCreateDatabaseCollationForCharset("latin1")).toBe("latin1_swedish_ci");
    expect(nextCreateDatabaseCollation("gbk", "utf8mb4", "utf8mb4_unicode_ci")).toBe("gbk_chinese_ci");
    expect(nextCreateDatabaseCollation("gbk", "utf8mb4", "custom_ci")).toBe("custom_ci");
  });
});
