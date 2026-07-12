import { describe, expect, it } from "vitest";
import { DATA_TYPE_OPTIONS } from "@/lib/table/tableStructureEditorState";
import { getPostgresDataTypeHelp } from "@/lib/table/postgresDataTypeHelp";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";

function postgresHelpMessages(locale: unknown): Record<string, unknown> {
  const messages = locale as { structureEditor?: { postgresDataTypeHelp?: Record<string, unknown> } };
  return messages.structureEditor?.postgresDataTypeHelp ?? {};
}

describe("getPostgresDataTypeHelp", () => {
  it("covers every built-in PostgreSQL type option", () => {
    expect(DATA_TYPE_OPTIONS.postgres.filter((type) => !getPostgresDataTypeHelp(type))).toEqual([]);
  });

  it("normalizes aliases and float precision parameters", () => {
    expect(getPostgresDataTypeHelp("int2")).toEqual({ key: "smallint" });
    expect(getPostgresDataTypeHelp("INT4")).toEqual({ key: "integer" });
    expect(getPostgresDataTypeHelp("int8")).toEqual({ key: "bigint" });
    expect(getPostgresDataTypeHelp("decimal(10, 2)")).toEqual({ key: "numeric" });
    expect(getPostgresDataTypeHelp("float")).toEqual({ key: "double" });
    expect(getPostgresDataTypeHelp("float(24)")).toEqual({ key: "real" });
    expect(getPostgresDataTypeHelp("float(25)")).toEqual({ key: "double" });
    expect(getPostgresDataTypeHelp("float(0)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("float(54)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("float(1.5)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("float(precision)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("character varying(255)")).toEqual({ key: "varchar" });
  });

  it("documents serial, temporal aliases, dynamic built-ins, and arrays", () => {
    expect(getPostgresDataTypeHelp("bigserial")).toEqual({ key: "serial" });
    expect(getPostgresDataTypeHelp("timestamp with time zone")).toEqual({ key: "timestamptz" });
    expect(getPostgresDataTypeHelp("int4multirange")).toEqual({ key: "multirange" });
    expect(getPostgresDataTypeHelp("jsonpath")).toEqual({ key: "jsonpath" });
    expect(getPostgresDataTypeHelp("pg_lsn")).toEqual({ key: "pgLsn" });
    expect(getPostgresDataTypeHelp("pg_snapshot")).toEqual({ key: "pgSnapshot" });
    expect(getPostgresDataTypeHelp("uuid[][]")).toEqual({ key: "array" });
    expect(getPostgresDataTypeHelp("my_schema.order_status[]")).toEqual({ key: "array" });
  });

  it("leaves extensions and named user types undocumented", () => {
    expect(getPostgresDataTypeHelp("vector(1536)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("geometry(Point, 4326)")).toBeUndefined();
    expect(getPostgresDataTypeHelp("citext")).toBeUndefined();
    expect(getPostgresDataTypeHelp("hstore")).toBeUndefined();
    expect(getPostgresDataTypeHelp("order_status")).toBeUndefined();
    expect(getPostgresDataTypeHelp("order_status_multirange")).toBeUndefined();
  });

  it("has English and Simplified Chinese copy for every supported static key", () => {
    const english = postgresHelpMessages(en);
    const chinese = postgresHelpMessages(zhCN);
    const dynamic = ["int4multirange", "jsonpath", "pg_lsn", "pg_snapshot", "any_type[]"];

    for (const option of [...DATA_TYPE_OPTIONS.postgres, ...dynamic]) {
      const key = getPostgresDataTypeHelp(option)?.key;
      expect(key, option).toBeTruthy();
      expect(english[key!], `English: ${option}`).toEqual(expect.any(String));
      expect(chinese[key!], `Simplified Chinese: ${option}`).toEqual(expect.any(String));
    }
  });
});
