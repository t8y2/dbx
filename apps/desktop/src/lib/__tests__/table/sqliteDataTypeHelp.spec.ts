import { describe, expect, it } from "vitest";
import { DATA_TYPE_OPTIONS } from "@/lib/table/tableStructureEditorState";
import { getSqliteDataTypeHelp } from "@/lib/table/sqliteDataTypeHelp";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";

function sqliteHelpMessages(locale: unknown): Record<string, unknown> {
  const messages = locale as { structureEditor?: { sqliteDataTypeHelp?: Record<string, unknown> } };
  return messages.structureEditor?.sqliteDataTypeHelp ?? {};
}

describe("getSqliteDataTypeHelp", () => {
  it("covers every built-in SQLite type option", () => {
    expect(DATA_TYPE_OPTIONS.sqlite.filter((type) => !getSqliteDataTypeHelp(type))).toEqual([]);
  });

  it("normalizes whitespace, casing, and declared type parameters", () => {
    expect(getSqliteDataTypeHelp(" INTEGER ")).toEqual({ key: "integer" });
    expect(getSqliteDataTypeHelp("VARCHAR(255)")).toEqual({ key: "text" });
    expect(getSqliteDataTypeHelp(" decimal(10, 2) ")).toEqual({ key: "numeric" });
  });

  it("applies SQLite's ordered declared-type affinity rules", () => {
    expect(getSqliteDataTypeHelp("char(12)")).toEqual({ key: "text" });
    expect(getSqliteDataTypeHelp("boolean")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("unsigned big int")).toEqual({ key: "integer" });
    expect(getSqliteDataTypeHelp("double precision")).toEqual({ key: "real" });
    expect(getSqliteDataTypeHelp("date")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("datetime")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("time")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("VARCHAR2")).toEqual({ key: "text" });
    expect(getSqliteDataTypeHelp("CHARACTER")).toEqual({ key: "text" });
    expect(getSqliteDataTypeHelp("INT64")).toEqual({ key: "integer" });
    expect(getSqliteDataTypeHelp("FLOATING POINT")).toEqual({ key: "integer" });
    expect(getSqliteDataTypeHelp("STRING")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("application_status")).toEqual({ key: "numeric" });
    expect(getSqliteDataTypeHelp("")).toEqual({ key: "blob" });
  });

  it("has English and Simplified Chinese copy for static and common help keys", () => {
    const english = sqliteHelpMessages(en);
    const chinese = sqliteHelpMessages(zhCN);
    const types = [...DATA_TYPE_OPTIONS.sqlite, "varchar", "boolean", "datetime"];

    for (const type of types) {
      const key = getSqliteDataTypeHelp(type)?.key;
      expect(key, type).toBeTruthy();
      expect(english[key!], `English: ${type}`).toEqual(expect.any(String));
      expect(chinese[key!], `Simplified Chinese: ${type}`).toEqual(expect.any(String));
    }
  });

  it("calls out SQLite affinity and its important storage exceptions", () => {
    const english = sqliteHelpMessages(en);

    expect(english.integer).toContain("rowid");
    expect(english.integer).toContain("does not enforce");
    expect(english.real).toContain("IEEE 754");
    expect(english.text).toContain("do not enforce n");
    expect(english.blob).toContain("without type conversion");
    expect(english.numeric).toContain("not a separate SQLite storage class");
  });
});
