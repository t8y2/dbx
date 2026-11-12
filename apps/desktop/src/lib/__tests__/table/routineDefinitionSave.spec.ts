import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";
import * as api from "@/lib/backend/api";
import { canSaveRoutineToDatabase, routineDefinitionKind, saveRoutineDefinitionToDatabase } from "@/lib/table/routineDefinitionSave";
import { buildMysqlObjectTemplate } from "@/lib/sidebar/mysqlObjectTemplates";
import { buildFirebirdObjectTemplate } from "@/lib/sidebar/firebirdObjectTemplates";

vi.mock("@/lib/backend/api", () => ({ findStatementAtCursor: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("routine definition save eligibility", () => {
  it.each(["procedure", "function"] as const)("recognizes the generated MySQL %s template including DELIMITER", (kind) => {
    expect(routineDefinitionKind(buildMysqlObjectTemplate(kind, "app").sql, "mysql")).toBe(kind.toUpperCase());
    expect(routineDefinitionKind(buildFirebirdObjectTemplate(kind).sql, "firebird")).toBe(kind.toUpperCase());
  });

  it.each([
    ["mysql", "CREATE DEFINER=`app_user`@`localhost` PROCEDURE p() BEGIN SELECT 1; END", "PROCEDURE"],
    ["mysql", "CREATE DEFINER='app_user'@'localhost' FUNCTION f() RETURNS INT RETURN 1", "FUNCTION"],
    ["mysql", "CREATE DEFINER=CURRENT_USER() PROCEDURE p() SELECT 1", "PROCEDURE"],
    ["postgres", "-- new routine\nCREATE OR REPLACE PROCEDURE public.p() LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;", "PROCEDURE"],
    ["postgres", "CREATE FUNCTION public.f() RETURNS INT LANGUAGE SQL AS $$ SELECT 1 $$;", "FUNCTION"],
    ["sqlserver", "CREATE OR ALTER PROC dbo.p @id INT AS BEGIN SELECT @id; END", "PROCEDURE"],
    ["sqlserver", "ALTER FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN 1; END", "FUNCTION"],
    ["oracle", "CREATE OR REPLACE EDITIONABLE PROCEDURE p AS BEGIN NULL; END;\n/", "PROCEDURE"],
    ["dameng", "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;", "PROCEDURE"],
    ["firebird", "RECREATE PROCEDURE P AS BEGIN END;", "PROCEDURE"],
  ] as const)("recognizes %s routine DDL", (databaseType, sql, kind) => {
    expect(routineDefinitionKind(sql, databaseType)).toBe(kind);
  });

  it.each(["SELECT 'CREATE PROCEDURE p()';", "CALL p();", "DROP PROCEDURE p; CREATE PROCEDURE p() SELECT 1;", "CREATE TABLE procedures (id INT);", "CREATE VIEW procedure_view AS SELECT 1;", "CREATE DEFINER=`procedure`@`localhost` VIEW v AS SELECT 1;"])(
    "does not offer a database routine save for unrelated SQL: %s",
    (sql) => {
      expect(routineDefinitionKind(sql, "mysql")).toBeUndefined();
    },
  );

  it("keeps unsupported engines and managed source tabs on their existing save path", () => {
    const { tab, connection } = setup();
    expect(canSaveRoutineToDatabase(tab, connection)).toBe(true);
    expect(canSaveRoutineToDatabase(tab)).toBe(false);
    expect(canSaveRoutineToDatabase(tab, { ...connection, id: "other" })).toBe(false);
    expect(canSaveRoutineToDatabase({ ...tab, objectSource: { name: "p", objectType: "PROCEDURE" } }, connection)).toBe(false);
    expect(canSaveRoutineToDatabase({ ...tab, sourceView: { name: "p", objectType: "PROCEDURE" } } as QueryTab, connection)).toBe(false);
    expect(routineDefinitionKind(tab.sql, "sqlite")).toBeUndefined();
  });

  it("uses the resolved JDBC dialect", () => {
    const { tab, connection } = setup();
    expect(canSaveRoutineToDatabase({ ...tab, sql: "CREATE PROCEDURE dbo.p AS SELECT 1" }, { ...connection, db_type: "jdbc", driver_profile: "sqlserver" })).toBe(true);
  });
});

function setup(databaseType: DatabaseType = "mysql") {
  const sql = "CREATE PROCEDURE p() BEGIN SELECT 1; END;\nCALL p();";
  const tab = { id: "routine-tab", connectionId: "connection", database: "app", mode: "query", sql, isExecuting: false } as QueryTab;
  const connection = { id: "connection", db_type: databaseType } as ConnectionConfig;
  const tabs = [tab];
  const execute = vi.fn().mockResolvedValue({ status: "started", ok: true, tabId: tab.id });
  vi.mocked(api.findStatementAtCursor).mockResolvedValue("CREATE PROCEDURE p() BEGIN SELECT 1; END");
  return { tab, connection, tabs, execute, save: () => saveRoutineDefinitionToDatabase(tab, tab.sql, { connection, tabs, execute }) };
}

describe("save a routine definition to the database", () => {
  it("executes only the complete definition through the guarded SQL execution pipeline", async () => {
    const { tab, execute, save } = setup();
    expect(await save()).toMatchObject({ status: "started", ok: true });
    expect(api.findStatementAtCursor).toHaveBeenCalledWith(tab.sql, 0, "mysql");
    expect(execute).toHaveBeenCalledExactlyOnceWith({ fullSql: tab.sql, selectedSql: "CREATE PROCEDURE p() BEGIN SELECT 1; END", cursorPos: 0, selectionFrom: 0, selectionTo: "CREATE PROCEDURE p() BEGIN SELECT 1; END".length }, { tabId: tab.id });
  });

  it.each(["connectionId", "database", "schema", "catalog"] as const)("cancels if the tab's %s changes while resolving the definition", async (field) => {
    const { tab, execute, save } = setup();
    vi.mocked(api.findStatementAtCursor).mockImplementationOnce(async () => {
      tab[field] = "changed";
      return "CREATE PROCEDURE p() SELECT 1";
    });
    expect(await save()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels if the tab closes while resolving the definition", async () => {
    const { tabs, execute, save } = setup();
    vi.mocked(api.findStatementAtCursor).mockImplementationOnce(async () => {
      tabs.splice(0);
      return "CREATE PROCEDURE p() SELECT 1";
    });
    await save();
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels if the connection configuration is replaced while resolving the definition", async () => {
    const { tab, connection, tabs, execute } = setup();
    let current = true;
    vi.mocked(api.findStatementAtCursor).mockImplementationOnce(async () => {
      current = false;
      return "CREATE PROCEDURE p() SELECT 1";
    });
    await saveRoutineDefinitionToDatabase(tab, tab.sql, { connection, tabs, execute, isCurrent: () => current });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["", "CALL p()", "DELETE FROM users", "CREATE FUNCTION f() RETURNS INT RETURN 1"])("does not execute a mismatched backend statement: %s", async (statement) => {
    const { execute, save } = setup();
    vi.mocked(api.findStatementAtCursor).mockResolvedValueOnce(statement);
    expect(await save()).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves deferred confirmations and database execution failures", async () => {
    const { tab, execute, save } = setup();
    const deferred = { status: "deferred", reason: "danger", tabId: tab.id };
    execute.mockResolvedValueOnce(deferred);
    expect(await save()).toBe(deferred);
    const failed = { status: "started", ok: false, errorMessage: "Syntax error", tabId: tab.id };
    execute.mockResolvedValueOnce(failed);
    expect(await save()).toBe(failed);
  });

  it("keeps error offsets aligned with a MySQL delimiter preamble", async () => {
    const { tab, execute, save } = setup();
    tab.sql = buildMysqlObjectTemplate("procedure", "app").sql;
    const statement = tab.sql.slice(tab.sql.indexOf("CREATE"), tab.sql.indexOf("END$$") + 3);
    vi.mocked(api.findStatementAtCursor).mockResolvedValueOnce(statement);
    await save();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ fullSql: tab.sql, selectedSql: statement, selectionFrom: tab.sql.indexOf("CREATE"), selectionTo: tab.sql.indexOf("END$$") + 3 });
  });
});
