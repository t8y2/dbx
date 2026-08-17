import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeObjectSourceSave, formatObjectSourceSaveError, resolveObjectSourceEditDraft } from "@/lib/table/objectSourceEditor";
import { formatSqlForDisplay } from "@/lib/sql/sqlFormatter";

vi.mock("@/lib/backend/api", () => ({
  executeInTransaction: vi.fn().mockResolvedValue({}),
  executeQuery: vi.fn().mockResolvedValue({}),
  executeScript: vi.fn().mockResolvedValue({}),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeObjectSourceSave", () => {
  it("runs multi-statement Informix source saves in a transaction", async () => {
    await executeObjectSourceSave("conn-1", "stores", "informix", ["CREATE TEMP VIEW v AS SELECT 1", "  ", "DROP VIEW v", "CREATE VIEW v AS SELECT 2"], "app");

    expect(api.executeInTransaction).toHaveBeenCalledOnce();
    expect(api.executeInTransaction).toHaveBeenCalledWith("conn-1", "stores", ["CREATE TEMP VIEW v AS SELECT 1", "DROP VIEW v", "CREATE VIEW v AS SELECT 2"], "app");
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.executeScript).not.toHaveBeenCalled();
  });

  it("keeps non-Informix source saves on the existing per-statement path", async () => {
    await executeObjectSourceSave("conn-1", "app", "mysql", ["ALTER VIEW v AS SELECT 1", "", "ALTER VIEW v AS SELECT 2"], "public");

    expect(api.executeInTransaction).not.toHaveBeenCalled();
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery).toHaveBeenNthCalledWith(1, "conn-1", "app", "ALTER VIEW v AS SELECT 1", "public");
    expect(api.executeQuery).toHaveBeenNthCalledWith(2, "conn-1", "app", "ALTER VIEW v AS SELECT 2", "public");
    expect(api.executeScript).not.toHaveBeenCalled();
  });
});

describe("formatObjectSourceSaveError", () => {
  const hint = "Keep existing view columns unchanged and append new columns at the end.";

  it.each(["ERROR: cannot drop columns from view", 'ERROR: cannot change name of view column "old_name" to "new_name"', 'ERROR: cannot change data type of view column "amount" from integer to bigint', "ERROR: ビューからは列を削除できません", "错误：无法从视图中删除列"])(
    "appends guidance for PostgreSQL view column replacement errors: %s",
    (message) => {
      expect(formatObjectSourceSaveError(new Error(message), "postgres", "VIEW", hint)).toBe(`${message}\n\n${hint}`);
    },
  );

  it("supports PostgreSQL-compatible databases", () => {
    expect(formatObjectSourceSaveError("cannot change name of view column", "kingbase", "VIEW", hint)).toBe(`cannot change name of view column\n\n${hint}`);
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatObjectSourceSaveError(new Error("syntax error at or near SELECT"), "postgres", "VIEW", hint)).toBe("syntax error at or near SELECT");
    expect(formatObjectSourceSaveError(new Error("SQLSTATE 42P16"), "mysql", "VIEW", hint)).toBe("SQLSTATE 42P16");
    expect(formatObjectSourceSaveError(new Error("SQLSTATE 42P16"), "postgres", "PROCEDURE", hint)).toBe("SQLSTATE 42P16");
  });

  it.each(["Agent RPC error: SQLSTATE 42P16", "ERROR: ON COMMIT can only be used on temporary tables (SQLSTATE 42P16)"])("does not treat unrelated invalid_table_definition errors as view column changes: %s", (message) => {
    expect(formatObjectSourceSaveError(new Error(message), "postgres", "VIEW", hint)).toBe(message);
  });

  it("does not append the same guidance twice", () => {
    const formatted = formatObjectSourceSaveError("ERROR: cannot drop columns from view", "postgres", "VIEW", hint);
    expect(formatObjectSourceSaveError(formatted, "postgres", "VIEW", hint)).toBe(formatted);
  });
});

describe("resolveObjectSourceEditDraft", () => {
  const mysqlSingleLineViewDefinition = "CREATE VIEW `v_active_users` AS select `users`.`id` AS `id`,`users`.`name` AS `name` from `users` where (`users`.`active` = 1)";

  it("uses the pretty-printed draft for MySQL views (issue #5057)", async () => {
    const formatted = await formatSqlForDisplay(mysqlSingleLineViewDefinition, "mysql");

    expect(formatted).not.toBe(mysqlSingleLineViewDefinition);
    expect(formatted.split("\n").length).toBeGreaterThan(1);
    expect(resolveObjectSourceEditDraft("mysql", "VIEW", formatted, mysqlSingleLineViewDefinition)).toBe(formatted);
  });

  it("keeps raw editable source for other database and object types", () => {
    const formatted = "CREATE VIEW v AS\nSELECT 1";

    expect(resolveObjectSourceEditDraft("postgres", "VIEW", formatted, mysqlSingleLineViewDefinition)).toBe(mysqlSingleLineViewDefinition);
    expect(resolveObjectSourceEditDraft("mysql", "FUNCTION", formatted, mysqlSingleLineViewDefinition)).toBe(mysqlSingleLineViewDefinition);
    expect(resolveObjectSourceEditDraft(undefined, "VIEW", formatted, mysqlSingleLineViewDefinition)).toBe(mysqlSingleLineViewDefinition);
  });

  it("falls back to raw MySQL view source when formatting produced nothing usable", () => {
    expect(resolveObjectSourceEditDraft("mysql", "VIEW", "", mysqlSingleLineViewDefinition)).toBe(mysqlSingleLineViewDefinition);
    expect(resolveObjectSourceEditDraft("mysql", "VIEW", "   ", mysqlSingleLineViewDefinition)).toBe(mysqlSingleLineViewDefinition);
  });
});
