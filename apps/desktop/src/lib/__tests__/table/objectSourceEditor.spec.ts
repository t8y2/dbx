import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { executeObjectSourceSave, fingerprintOracleRoutineObjectSource, formatObjectSourceSaveError, prepareRoutineSourceRun, resolveObjectSourceEditDraft, rewriteOracleRoutineReferences, supportsRoutineSourceReplaceOnRun, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
import { beginSourceSave, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";
import { supportsObjectRename } from "@/lib/table/objectRenameSql";
import { formatSqlForDisplay } from "@/lib/sql/sqlFormatter";

vi.mock("@/lib/backend/api", () => ({
  buildExecutableObjectSourceStatements: vi.fn(),
  executeInTransaction: vi.fn().mockResolvedValue({}),
  executeQuery: vi.fn().mockResolvedValue({}),
  executeScript: vi.fn().mockResolvedValue({}),
  rewriteOracleRoutineReferences: vi.fn().mockResolvedValue("CREATE VIEW v AS SELECT F_NEW(id) FROM t"),
  fingerprintOracleRoutineObjectSource: vi.fn().mockResolvedValue("fingerprint"),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("openGauss rename capabilities", () => {
  it("keeps direct object renames without enabling source-backed routine rebuilds", () => {
    expect(supportsObjectRename("opengauss", "TABLE")).toBe(true);
    expect(supportsObjectRename("opengauss", "VIEW")).toBe(true);
    expect(supportsObjectRename("opengauss", "MATERIALIZED_VIEW")).toBe(true);
    expect(supportsSourceBackedRoutineRename("opengauss", "FUNCTION")).toBe(false);
    expect(supportsSourceBackedRoutineRename("opengauss", "PROCEDURE")).toBe(false);
    expect(supportsSourceBackedRoutineRename("postgres", "FUNCTION")).toBe(true);
    expect(supportsSourceBackedRoutineRename("oceanbase-oracle", "FUNCTION")).toBe(true);
  });
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

  it("executes Oracle-family rebuild statements in order and stops at the first failure", async () => {
    vi.mocked(api.executeQuery)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.executeQuery>>)
      .mockRejectedValueOnce(new Error("CREATE failed"));

    await expect(executeObjectSourceSave("conn-1", "app", "oceanbase-oracle", ["CREATE FUNCTION f_new", "ALTER FUNCTION caller COMPILE", "DROP FUNCTION f_old"], "owner", 45)).rejects.toThrow("CREATE failed");

    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    expect(api.executeQuery).toHaveBeenNthCalledWith(1, "conn-1", "app", "CREATE FUNCTION f_new", "owner", undefined, { timeoutSecs: 45 });
    expect(api.executeQuery).toHaveBeenNthCalledWith(2, "conn-1", "app", "ALTER FUNCTION caller COMPILE", "owner", undefined, { timeoutSecs: 45 });
    expect(api.executeScript).not.toHaveBeenCalled();
  });
});

describe("routine source Run replacement (issue #12855)", () => {
  const identity = (name: string) => captureSourceIdentity({ connectionId: "conn-1", database: "app", schema: "app", objectType: "PROCEDURE", name });
  const prepare = (sql: string, name = "refresh_cache", objectType: "PROCEDURE" | "FUNCTION" = "PROCEDURE") => prepareRoutineSourceRun({ identity: identity(name), connectionId: "conn-1", database: "app", databaseType: "mysql", schema: "app", objectType, name, sql });
  // The backend's replace sequence: validate under a temporary name, drop the old routine, then the CREATE itself.
  const replaceSequence = (create: string) => ["DROP PROCEDURE IF EXISTS `app`.`dbx_routine_check_1`;", "CREATE PROCEDURE `dbx_routine_check_1`() BEGIN SELECT 1; END;", "DROP PROCEDURE IF EXISTS `app`.`dbx_routine_check_1`;", "DROP PROCEDURE IF EXISTS `app`.`refresh_cache`;", create];

  it("only applies to MySQL-family procedures and functions", () => {
    for (const databaseType of ["mysql", "goldendb"] as const) {
      expect(supportsRoutineSourceReplaceOnRun(databaseType, "PROCEDURE")).toBe(true);
      expect(supportsRoutineSourceReplaceOnRun(databaseType, "FUNCTION")).toBe(true);
    }
    expect(supportsRoutineSourceReplaceOnRun("mysql", "VIEW")).toBe(false);
    expect(supportsRoutineSourceReplaceOnRun("mysql", "TRIGGER")).toBe(false);
    expect(supportsRoutineSourceReplaceOnRun("mysql", "EVENT")).toBe(false);
    for (const databaseType of ["postgres", "oracle", "sqlserver", "doris", "starrocks", undefined] as const) {
      expect(supportsRoutineSourceReplaceOnRun(databaseType, "PROCEDURE")).toBe(false);
      expect(supportsRoutineSourceReplaceOnRun(databaseType, "FUNCTION")).toBe(false);
    }
  });

  it("runs the validate + drop steps of the Save sequence ahead of the tab's own CREATE", async () => {
    const create = "CREATE DEFINER=`root`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 2; END";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue(replaceSequence(`${create};`));

    await expect(prepare(create)).resolves.toBe(true);

    expect(api.buildExecutableObjectSourceStatements).toHaveBeenCalledWith({ databaseType: "mysql", objectType: "PROCEDURE", schema: "app", name: "refresh_cache", source: create });
    const executed = vi.mocked(api.executeQuery).mock.calls.map((call) => call[2]);
    expect(executed).toEqual(replaceSequence("").slice(0, -1));
    expect(api.executeQuery).toHaveBeenNthCalledWith(1, "conn-1", "app", "DROP PROCEDURE IF EXISTS `app`.`dbx_routine_check_1`;", "app");
    // The CREATE is left to the normal query pipeline.
    expect(executed.some((sql) => sql.includes("DEFINER"))).toBe(false);
  });

  it.each([
    ["bare name", "CREATE PROCEDURE refresh_cache() BEGIN SELECT 1; END"],
    ["case-insensitive quoted name", "  create\nprocedure `Refresh_Cache` (IN a INT) BEGIN SELECT 1; END"],
    ["bare definer", "CREATE DEFINER=root@localhost PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"],
    ["quoted definer with a space", "CREATE DEFINER = 'app user'@'%' PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"],
    ["backquoted definer containing @", "CREATE DEFINER=`a@b`@`%` PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"],
    ["CURRENT_USER() definer", "CREATE DEFINER=CURRENT_USER() PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"],
  ])("treats a %s as the tab's own CREATE", async (_description, create) => {
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue(replaceSequence(`${create};`));
    await expect(prepare(create)).resolves.toBe(true);
    expect(api.executeQuery).toHaveBeenCalledTimes(4);
  });

  it("matches functions by their own kind and backquote-escaped names", async () => {
    const create = "CREATE FUNCTION `odd``name`(a INT) RETURNS int DETERMINISTIC RETURN a";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue([
      "DROP FUNCTION IF EXISTS `app`.`dbx_routine_check_2`;",
      "CREATE FUNCTION `dbx_routine_check_2`(a INT) RETURNS int DETERMINISTIC RETURN a;",
      "DROP FUNCTION IF EXISTS `app`.`dbx_routine_check_2`;",
      "DROP FUNCTION IF EXISTS `app`.`odd``name`;",
      `${create};`,
    ]);

    await expect(prepare(create, "odd`name", "FUNCTION")).resolves.toBe(true);
    expect(api.executeQuery).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["a plain query", "SELECT 1"],
    ["a routine call", "CALL refresh_cache()"],
    ["ALTER PROCEDURE", "ALTER PROCEDURE `refresh_cache` COMMENT 'x'"],
    ["an explicit DROP", "DROP PROCEDURE IF EXISTS `refresh_cache`"],
    ["a rename to another name", "CREATE PROCEDURE `other_cache`() BEGIN SELECT 1; END"],
    ["a different routine kind", "CREATE FUNCTION `refresh_cache`() RETURNS int RETURN 1"],
    ["IF NOT EXISTS", "CREATE PROCEDURE IF NOT EXISTS `refresh_cache`() BEGIN SELECT 1; END"],
    ["a schema-qualified name", "CREATE PROCEDURE `app`.`refresh_cache`() BEGIN SELECT 1; END"],
    ["an unquoted schema-qualified name", "CREATE PROCEDURE app.refresh_cache() BEGIN SELECT 1; END"],
    ["a name that only starts like the tab's", "CREATE PROCEDURE refresh_cache_v2() BEGIN SELECT 1; END"],
    ["a leading comment", "-- edited\nCREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END"],
  ])("leaves %s untouched", async (_description, sql) => {
    await expect(prepare(sql)).resolves.toBe(false);
    expect(api.buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("skips non-MySQL tabs and non-routine objects without calling the backend", async () => {
    const create = "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END";
    await expect(prepareRoutineSourceRun({ identity: identity("refresh_cache"), connectionId: "conn-1", database: "app", databaseType: "postgres", schema: "app", objectType: "PROCEDURE", name: "refresh_cache", sql: create })).resolves.toBe(false);
    await expect(prepareRoutineSourceRun({ identity: identity("refresh_cache"), connectionId: "conn-1", database: "app", databaseType: "mysql", schema: "app", objectType: "VIEW", name: "refresh_cache", sql: create })).resolves.toBe(false);
    expect(api.buildExecutableObjectSourceStatements).not.toHaveBeenCalled();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("does nothing when the backend turns the CREATE into a rename (trailing cleanup DROP)", async () => {
    const create = "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue([...replaceSequence(`${create};`), "DROP PROCEDURE IF EXISTS `app`.`refresh_cache_old`;"]);

    await expect(prepare(create)).resolves.toBe(false);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("does nothing when the backend returns a bare statement", async () => {
    const create = "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue([`${create};`]);

    await expect(prepare(create)).resolves.toBe(false);
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("stops at the failing validation step and releases the source-save lock", async () => {
    const create = "CREATE PROCEDURE `refresh_cache`() BEGIN SELEC 1; END";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue(replaceSequence(`${create};`));
    vi.mocked(api.executeQuery)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.executeQuery>>)
      .mockRejectedValueOnce(new Error("You have an error in your SQL syntax"));

    await expect(prepare(create)).rejects.toThrow("You have an error in your SQL syntax");

    // The old routine's DROP never ran, so the original stays in place.
    expect(api.executeQuery).toHaveBeenCalledTimes(2);
    const release = beginSourceSave(identity("refresh_cache"));
    release();
  });

  it("refuses to run while the same routine is being saved", async () => {
    const create = "CREATE PROCEDURE `refresh_cache`() BEGIN SELECT 1; END";
    vi.mocked(api.buildExecutableObjectSourceStatements).mockResolvedValue(replaceSequence(`${create};`));
    const busy = identity("refresh_cache");
    const release = beginSourceSave(busy);
    try {
      await expect(prepareRoutineSourceRun({ identity: busy, connectionId: "conn-1", database: "app", databaseType: "mysql", schema: "app", objectType: "PROCEDURE", name: "refresh_cache", sql: create })).rejects.toThrow();
      expect(api.executeQuery).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});

describe("Oracle routine dependency source rewrite", () => {
  it("routes complete caller source through the shared backend implementation", async () => {
    const input = { databaseType: "oceanbase-oracle" as const, callerType: "VIEW" as const, targetType: "FUNCTION" as const, schema: "APP", oldName: "F_OLD", newName: "F_NEW", source: "CREATE VIEW v AS SELECT F_OLD(id) FROM t" };
    await expect(rewriteOracleRoutineReferences(input)).resolves.toBe("CREATE VIEW v AS SELECT F_NEW(id) FROM t");
    expect(api.rewriteOracleRoutineReferences).toHaveBeenCalledWith(input);
  });

  it("routes Oracle routine source fingerprint requests through the shared backend implementation", async () => {
    const input = { databaseType: "oceanbase-oracle" as const, objectType: "PROCEDURE" as const, schema: "APP", name: "CALLER", source: "CREATE PROCEDURE APP.CALLER IS BEGIN NULL; END;" };
    await expect(fingerprintOracleRoutineObjectSource(input)).resolves.toBe("fingerprint");
    expect(api.fingerprintOracleRoutineObjectSource).toHaveBeenCalledWith(input);
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
