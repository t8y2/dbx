import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/api", () => ({ buildRenameDatabasePreflightSql: vi.fn(), buildMysqlRenameDatabaseSql: vi.fn(), executeQuery: vi.fn() }));

import * as api from "@/lib/backend/api";
import { executeMysqlDatabaseRename, MysqlDatabaseRenameBlockedError, MysqlDatabaseRenameIncompleteError, parseMysqlDatabaseInventory, prepareMysqlDatabaseRename } from "@/lib/table/mysqlDatabaseRename";
import { supportsDatabaseRename } from "@/lib/table/objectRenameSql";

const statements = {
  createDatabase: "CREATE DATABASE `new_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;",
  moveTables: "RENAME TABLE `old_db`.`t` TO `new_db`.`t`;",
  dropOldDatabase: "DROP DATABASE `old_db`;",
  dropNewDatabase: "DROP DATABASE `new_db`;",
};
const schemaRow = ["SCHEMA", "utf8mb4", "utf8mb4_0900_ai_ci"];
const result = (rows: unknown[][] = []) => ({ columns: [], rows, affected_rows: 0, execution_time_ms: 0 });

describe("MySQL database rename capability", () => {
  it("is limited to MySQL and MariaDB profiles", () => {
    expect(supportsDatabaseRename("mysql")).toBe(true);
    expect(supportsDatabaseRename("mysql", "mysql")).toBe(true);
    expect(supportsDatabaseRename("mysql", "MariaDB")).toBe(true);
    for (const profile of ["tidb", "oceanbase", "doris", "selectdb", "starrocks", "polardb"]) expect(supportsDatabaseRename("mysql", profile)).toBe(false);
    expect(supportsDatabaseRename("gbase")).toBe(false);
    expect(supportsDatabaseRename("goldendb")).toBe(false);
  });
});

describe("parseMysqlDatabaseInventory", () => {
  it("separates movable tables from objects RENAME TABLE cannot move", () => {
    const inventory = parseMysqlDatabaseInventory([
      schemaRow,
      ["TABLE", "orders", "BASE TABLE"],
      ["TABLE", "history", "SYSTEM VERSIONED"],
      ["TABLE", "tmp", "TEMPORARY"],
      ["TABLE", "v1", "VIEW"],
      ["TABLE", "v2", "VIEW"],
      ["TABLE", "seq", "SEQUENCE"],
      ["TRIGGER", "tr", null],
      ["ROUTINE", "p", "PROCEDURE"],
      ["EVENT", "e", null],
      ["GRANT", "'app'@'%'", "DATABASE"],
      ["GRANT", "'app'@'%'", "TABLE"],
      ["GRANT", "'audit'@'localhost'", "COLUMN"],
    ]);
    expect(inventory).toEqual({
      exists: true,
      charset: "utf8mb4",
      collation: "utf8mb4_0900_ai_ci",
      tables: ["orders", "history"],
      blockers: [
        { kind: "VIEW", count: 2 },
        { kind: "SEQUENCE", count: 1 },
        { kind: "TRIGGER", count: 1 },
        { kind: "PROCEDURE", count: 1 },
        { kind: "EVENT", count: 1 },
      ],
      grantees: ["'app'@'%'", "'audit'@'localhost'"],
    });
  });

  it("reports a missing database", () => {
    expect(parseMysqlDatabaseInventory([]).exists).toBe(false);
  });
});

describe("MySQL database rename execution", () => {
  const target = { connectionId: "c1", oldName: "old_db", newName: "new_db" };

  beforeEach(() => {
    vi.mocked(api.buildRenameDatabasePreflightSql)
      .mockReset()
      .mockImplementation(async ({ databaseName }) => `PREFLIGHT ${databaseName}`);
    vi.mocked(api.buildMysqlRenameDatabaseSql).mockReset().mockResolvedValue(statements);
    vi.mocked(api.executeQuery).mockReset();
  });

  it("refuses databases with views, triggers, routines or events", async () => {
    await expect(prepareMysqlDatabaseRename(target, parseMysqlDatabaseInventory([schemaRow, ["TRIGGER", "tr", null]]))).rejects.toBeInstanceOf(MysqlDatabaseRenameBlockedError);
    expect(api.buildMysqlRenameDatabaseSql).not.toHaveBeenCalled();
  });

  it("fails closed when the inventory is truncated", async () => {
    vi.mocked(api.executeQuery).mockResolvedValue({ ...result([schemaRow]), truncated: true } as never);
    await expect(prepareMysqlDatabaseRename(target)).rejects.toThrow(/incomplete/);
  });

  it("creates, moves, re-checks and then drops the emptied source", async () => {
    const plan = await prepareMysqlDatabaseRename(target, parseMysqlDatabaseInventory([schemaRow, ["TABLE", "t", "BASE TABLE"]]));
    expect(api.buildMysqlRenameDatabaseSql).toHaveBeenCalledWith({ oldName: "old_db", newName: "new_db", tableNames: ["t"], charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" });
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql === "PREFLIGHT old_db" ? [schemaRow] : []) as never);
    await executeMysqlDatabaseRename(plan);
    expect(vi.mocked(api.executeQuery).mock.calls.map((call) => call[2])).toEqual([statements.createDatabase, statements.moveTables, "PREFLIGHT old_db", statements.dropOldDatabase]);
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[1] === "")).toBe(true);
  });

  it("does not treat grants left on the old name as remaining objects", async () => {
    const plan = await prepareMysqlDatabaseRename(target, parseMysqlDatabaseInventory([schemaRow, ["TABLE", "t", "BASE TABLE"], ["GRANT", "'app'@'%'", "DATABASE"]]));
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql === "PREFLIGHT old_db" ? [schemaRow, ["GRANT", "'app'@'%'", "DATABASE"]] : []) as never);
    await executeMysqlDatabaseRename(plan);
    expect(vi.mocked(api.executeQuery).mock.calls.map((call) => call[2])).toContain(statements.dropOldDatabase);
  });

  it("keeps the source when objects appeared after the plan was prepared", async () => {
    const plan = await prepareMysqlDatabaseRename(target, parseMysqlDatabaseInventory([schemaRow, ["TABLE", "t", "BASE TABLE"]]));
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => result(sql === "PREFLIGHT old_db" ? [schemaRow, ["TABLE", "late", "BASE TABLE"]] : []) as never);
    await expect(executeMysqlDatabaseRename(plan)).rejects.toBeInstanceOf(MysqlDatabaseRenameIncompleteError);
    expect(vi.mocked(api.executeQuery).mock.calls.map((call) => call[2])).not.toContain(statements.dropOldDatabase);
  });

  it("drops the just-created empty target when the move fails", async () => {
    const plan = await prepareMysqlDatabaseRename(target, parseMysqlDatabaseInventory([schemaRow, ["TABLE", "t", "BASE TABLE"]]));
    vi.mocked(api.executeQuery).mockImplementation(async (_id, _db, sql) => {
      if (sql === statements.moveTables) return { ...result(), execution_error: true, error: "Trigger in wrong schema" } as never;
      return result(sql === "PREFLIGHT new_db" ? [schemaRow] : []) as never;
    });
    await expect(executeMysqlDatabaseRename(plan)).rejects.toThrow();
    const sqls = vi.mocked(api.executeQuery).mock.calls.map((call) => call[2]);
    expect(sqls).toEqual([statements.createDatabase, statements.moveTables, "PREFLIGHT new_db", statements.dropNewDatabase]);
    expect(sqls).not.toContain(statements.dropOldDatabase);
  });
});
