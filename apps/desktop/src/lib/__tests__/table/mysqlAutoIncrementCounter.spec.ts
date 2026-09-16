import { describe, expect, it, vi } from "vitest";
import { buildMysqlAutoIncrementCounterStatement, canEditMysqlAutoIncrementCounter, mysqlAutoIncrementCounterDraft, refreshMysqlAutoIncrementCounterDraft } from "@/lib/table/mysqlAutoIncrementCounter";

function existingColumn(autoIncrement: boolean) {
  return {
    original: { name: "id" },
    markedForDrop: false,
    extra: { autoIncrement },
  } as any;
}

describe("MySQL table AUTO_INCREMENT counter", () => {
  it("keeps present and NULL metadata distinct without numeric conversion", () => {
    expect(mysqlAutoIncrementCounterDraft("9007199254740993")).toEqual({
      value: "9007199254740993",
      originalValue: "9007199254740993",
    });
    expect(mysqlAutoIncrementCounterDraft("18446744073709551615")).toEqual({
      value: "18446744073709551615",
      originalValue: "18446744073709551615",
    });
    expect(mysqlAutoIncrementCounterDraft(null)).toEqual({ value: undefined, originalValue: undefined });
  });

  it("refreshes restored clean drafts and rebases restored dirty drafts on live metadata", () => {
    expect(refreshMysqlAutoIncrementCounterDraft("30", { value: "10", originalValue: "10" }, true)).toEqual({
      value: "30",
      originalValue: "30",
    });
    expect(refreshMysqlAutoIncrementCounterDraft("15", { value: "20", originalValue: "10" }, true)).toEqual({
      value: "20",
      originalValue: "15",
    });
    expect(refreshMysqlAutoIncrementCounterDraft(null, { value: "20", originalValue: "10" }, true)).toEqual({
      value: "20",
      originalValue: undefined,
    });
  });

  it("is editable only for existing native-MySQL tables with an active auto-increment column draft", () => {
    const nativeMysql = { db_type: "mysql", driver_profile: "mysql" } as any;
    expect(canEditMysqlAutoIncrementCounter(nativeMysql, false, [existingColumn(true)])).toBe(true);
    expect(canEditMysqlAutoIncrementCounter(nativeMysql, false, [{ ...existingColumn(true), original: undefined }])).toBe(true);
    expect(canEditMysqlAutoIncrementCounter(nativeMysql, true, [existingColumn(true)])).toBe(false);
    expect(canEditMysqlAutoIncrementCounter(nativeMysql, false, [existingColumn(false)])).toBe(false);
    expect(canEditMysqlAutoIncrementCounter(nativeMysql, false, [{ ...existingColumn(true), markedForDrop: true }])).toBe(false);

    for (const connection of [
      { db_type: "jdbc", driver_profile: "mysql" },
      { db_type: "mysql", driver_profile: "mariadb" },
      { db_type: "mysql", driver_profile: "tidb" },
      { db_type: "mysql", driver_profile: "oceanbase" },
      { db_type: "mysql", driver_profile: "dolt" },
      { db_type: "goldendb", driver_profile: "goldendb" },
    ] as const) {
      expect(canEditMysqlAutoIncrementCounter(connection as any, false, [existingColumn(true)])).toBe(false);
    }
  });

  it("emits no DDL when unchanged and delegates changed values to the existing builder", async () => {
    const buildSql = vi.fn(async ({ value }: { value: string }) => `ALTER TABLE \`sales\`.\`events\` AUTO_INCREMENT = ${value};`);
    const common = {
      enabled: true,
      originalValue: "1",
      databaseType: "mysql" as const,
      driverProfile: "mysql",
      schema: "sales",
      tableName: "events",
      buildSql,
    };

    await expect(buildMysqlAutoIncrementCounterStatement({ ...common, value: "1" })).resolves.toBeUndefined();
    expect(buildSql).not.toHaveBeenCalled();

    await expect(buildMysqlAutoIncrementCounterStatement({ ...common, value: "18446744073709551615" })).resolves.toContain("18446744073709551615");
    expect(buildSql).toHaveBeenCalledWith(expect.objectContaining({ value: "18446744073709551615" }));
  });

  it("does not emit when metadata is unavailable and preserves builder validation errors", async () => {
    const buildSql = vi.fn(async () => {
      throw new Error("AUTO_INCREMENT must be a decimal integer");
    });
    const common = {
      enabled: true,
      databaseType: "mysql" as const,
      driverProfile: "mysql",
      schema: "sales",
      tableName: "events",
      buildSql,
    };

    await expect(buildMysqlAutoIncrementCounterStatement({ ...common, originalValue: undefined, value: undefined })).resolves.toBeUndefined();
    await expect(buildMysqlAutoIncrementCounterStatement({ ...common, originalValue: "1", value: "1e3" })).rejects.toThrow("AUTO_INCREMENT must be a decimal integer");
  });
});
