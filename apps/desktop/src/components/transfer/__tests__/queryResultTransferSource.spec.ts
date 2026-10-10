import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadQueryResultTransferSourceDdl } from "../queryResultTransferSource";
import { rewriteCreateTableName } from "../queryResultTransferDdl";

const api = vi.hoisted(() => ({ getTableDdl: vi.fn(), getTableDisplayDdl: vi.fn(), executeMulti: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
let h2Tables: string[][];

describe("query result transfer source DDL", () => {
  beforeEach(() => {
    api.getTableDdl.mockReset().mockResolvedValue('CREATE TABLE "public"."apis" ("id" serial PRIMARY KEY);');
    api.getTableDisplayDdl.mockReset().mockResolvedValue('CREATE TABLE "public"."apis" ("id" serial PRIMARY KEY); ALTER TABLE "public"."apis" OWNER TO "source_owner"; SET ROLE "source_owner"; GRANT SELECT ON "public"."apis" TO "reader"; RESET ROLE;');
    api.executeMulti.mockReset().mockImplementation(async (_connection, _database, sql) => {
      if (sql.startsWith("SELECT TABLE_SCHEMA,")) return [{ rows: h2Tables }];
      return [{ columns: ["nspname"], rows: [["application"]] }];
    });
    h2Tables = [["PUBLIC", "APIS", "BASE TABLE"]];
  });

  it("uses the executable PostgreSQL table DDL instead of display access and partition statements", async () => {
    const ddl = await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "public"."apis"', databaseType: "postgres", connectionId: "source", database: "source_db", schema: "other_schema" });

    expect(api.getTableDdl).toHaveBeenCalledWith("source", "source_db", "public", "apis", undefined, undefined);
    expect(api.getTableDisplayDdl).not.toHaveBeenCalled();
    expect(ddl).toBe('CREATE TABLE "public"."apis" ("id" serial PRIMARY KEY);');
  });

  it("resolves an unqualified PostgreSQL table through the active schema's fallback search path", async () => {
    api.executeMulti.mockResolvedValueOnce([{ columns: ["nspname"], rows: [["public"]] }]);
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "postgres", connectionId: "source", database: "source_db", schema: "tenant" });
    expect(api.executeMulti).toHaveBeenCalledWith("source", "source_db", expect.stringContaining("pg_catalog.to_regclass"), "tenant", undefined, expect.any(Object));
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "source_db", "public", "apis", undefined, undefined);
  });

  it("resolves a PostgreSQL relation through search_path on the source query session", async () => {
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM APIS", databaseType: "postgres", connectionId: "source", database: "source_db", clientSessionId: "query_session" });
    expect(api.executeMulti).toHaveBeenCalledWith("source", "source_db", expect.stringContaining("pg_catalog.to_regclass('\"apis\"')"), undefined, undefined, { executionMode: "simple", maxRows: 1, catalog: undefined, clientSessionId: "query_session" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "source_db", "application", "apis", undefined, undefined);
  });

  it("folds only unquoted PostgreSQL source names and avoids resolving an explicit schema", async () => {
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM PUBLIC.APIS", databaseType: "postgres", connectionId: "source", database: "source_db" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "source_db", "public", "apis", undefined, undefined);
    expect(api.executeMulti).not.toHaveBeenCalled();
    api.getTableDdl.mockClear();
    await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "Public"."APIS"', databaseType: "postgres", connectionId: "source", database: "source_db" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "source_db", "Public", "APIS", undefined, undefined);
  });

  it.each([
    { columns: ["nspname"], rows: [] },
    { columns: ["nspname"], rows: [["wrong"]], execution_error: true },
  ])("does not fetch an arbitrary schema when relation resolution fails", async (result) => {
    api.executeMulti.mockResolvedValueOnce([result]);
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "postgres", connectionId: "source", database: "source_db" })).toBeUndefined();
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it("keeps SQL Server temporal details for the DDL safety check", async () => {
    const ddl = "CREATE TABLE [app].[apis] ([id] int, PERIOD FOR SYSTEM_TIME ([start], [end])) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = [app].[apis_history]));";
    api.getTableDisplayDdl.mockResolvedValueOnce(ddl);
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM app.apis", databaseType: "sqlserver", connectionId: "source", database: "source_db" })).toBe(ddl);
    expect(api.getTableDisplayDdl).toHaveBeenCalledWith("source", "source_db", "app", "apis", undefined, undefined);
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it("resolves a MySQL database qualifier without retaining the prior database as schema", async () => {
    const ddl = "CREATE TABLE `apis` (`id` int) ENGINE=InnoDB";
    api.executeMulti.mockResolvedValueOnce([{ rows: [["apis", ddl]] }]);
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM `archive`.`apis`", databaseType: "mysql", connectionId: "source", database: "main", schema: "main", clientSessionId: "query_session" })).toBe(ddl);
    expect(api.executeMulti).toHaveBeenCalledWith("source", "main", "SHOW CREATE TABLE `archive`.`apis`", undefined, undefined, expect.objectContaining({ clientSessionId: "query_session" }));
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it("uses the selected MySQL database as its metadata namespace", async () => {
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "mysql", connectionId: "source", database: "source_db", schema: "stale_schema" });
    expect(api.executeMulti).toHaveBeenCalledWith("source", "source_db", "SHOW CREATE TABLE `source_db`.`apis`", undefined, undefined, expect.any(Object));
  });

  it.each(["mysql", "goldendb"] as const)("rejects the source session's temporary table instead of copying its permanent shadow (%s)", async (databaseType) => {
    api.executeMulti.mockResolvedValueOnce([{ rows: [["apis", "CREATE TEMPORARY TABLE `apis` (`id` int)"]] }]);
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType, connectionId: "source", database: "main", clientSessionId: "source_session" })).toBeUndefined();
    expect(api.executeMulti.mock.calls[0]![5]).toMatchObject({ clientSessionId: "source_session" });
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it.each(["mysql", "postgres", "sqlite", "h2"] as const)("does not reuse metadata outside the source manual transaction (%s)", async (databaseType) => {
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType, connectionId: "source", database: "main", txnSessionId: "manual_txn" })).toBeUndefined();
    expect(api.executeMulti).not.toHaveBeenCalled();
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it("preserves a SQLite attached database namespace for metadata", async () => {
    api.executeMulti.mockResolvedValueOnce([{ rows: [["apis", "CREATE TABLE apis (id int)", "table"]] }]).mockResolvedValueOnce([{ rows: [] }]);
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM aux.apis", databaseType: "sqlite", connectionId: "source", database: "/tmp/source.sqlite", schema: "main" });
    expect(api.getTableDdl).not.toHaveBeenCalled();
    expect(api.executeMulti).toHaveBeenCalledWith("source", "/tmp/source.sqlite", expect.stringContaining('FROM "aux".sqlite_master'), undefined, undefined, expect.any(Object));
  });

  it("preserves real SQLite explicit indexes through the source metadata path", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`ATTACH DATABASE ':memory:' AS "analytics.db";
        CREATE TABLE "analytics.db"."api's" (id INTEGER PRIMARY KEY, code TEXT, active INT, inline_unique TEXT UNIQUE);
        CREATE UNIQUE INDEX "analytics.db".uq_code ON "api's" (lower(code)) WHERE active = 1;
        CREATE INDEX "analytics.db".idx_active ON "api's" (active DESC);
        CREATE TRIGGER "analytics.db".excluded_trigger AFTER INSERT ON "api's" BEGIN SELECT 1; END;
        INSERT INTO "analytics.db"."api's" VALUES (1, 'sample', 1, 'one');`);
      // Execute the real metadata SQL on the same connection as the source rows.
      api.executeMulti.mockImplementation(async (_connection, _database, sql) => [
        {
          rows: db
            .prepare(sql)
            .all()
            .map((row) => Object.values(row)),
        },
      ]);
      const ddl = await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "analytics.db"."api\'s"', databaseType: "sqlite", connectionId: "source", database: "main", clientSessionId: "query_session" });
      expect(ddl).toContain("CREATE UNIQUE INDEX");
      expect(ddl).not.toContain("CREATE TRIGGER");
      expect(ddl).not.toContain("sqlite_autoindex");
      expect(api.getTableDdl).not.toHaveBeenCalled();
      expect(api.executeMulti.mock.calls[0]![5]).toMatchObject({ clientSessionId: "query_session" });
      const rewritten = rewriteCreateTableName(ddl!, '"main"."copy"', "sqlite");
      expect(rewritten).toBeDefined();
      db.exec(`${rewritten}; INSERT INTO main.copy SELECT * FROM "analytics.db"."api's";`);
      expect(db.prepare('PRAGMA main.index_list("copy")').all()).toHaveLength(3);
      expect(() => db.exec("INSERT INTO copy VALUES (2, 'SAMPLE', 1, 'two')")).toThrow(/UNIQUE constraint failed/);
      db.exec("INSERT INTO copy VALUES (2, 'SAMPLE', 0, 'two')");
      expect(db.prepare("SELECT count(*) AS count FROM copy").get()!.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it("uses SQLite temp/main/attachment lookup order and actual case on the source session", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`ATTACH DATABASE ':memory:' AS "first/attached"; ATTACH DATABASE ':memory:' AS second;
        CREATE TABLE main.apis(id INT, marker TEXT DEFAULT 'main');
        CREATE TABLE "first/attached".apis(id INT, marker TEXT DEFAULT 'first');
        CREATE TABLE second.apis(id INT, marker TEXT DEFAULT 'second');
        CREATE TEMP TABLE apis(id INT, marker TEXT DEFAULT 'temp');
        CREATE UNIQUE INDEX temp.uq_apis ON apis(id);`);
      api.executeMulti.mockImplementation(async (_connection, _database, sql) => [
        {
          rows: db
            .prepare(sql)
            .all()
            .map((row) => Object.values(row)),
        },
      ]);
      const request = { sql: "SELECT * FROM APIS", databaseType: "sqlite" as const, connectionId: "source", database: "second", clientSessionId: "source_session" };
      const tempDdl = await loadQueryResultTransferSourceDdl(request);
      expect(tempDdl).toContain("DEFAULT 'temp'");
      const rewritten = rewriteCreateTableName(tempDdl!, '"second"."copy"', "sqlite")!;
      db.exec(`${rewritten}; INSERT INTO second.copy(id) VALUES(1)`);
      expect(() => db.exec("INSERT INTO second.copy(id) VALUES(1)")).toThrow(/UNIQUE constraint failed/);
      expect(await loadQueryResultTransferSourceDdl({ ...request, sql: "SELECT * FROM MAIN.APIS" })).toContain("DEFAULT 'main'");
      expect(await loadQueryResultTransferSourceDdl({ ...request, sql: 'SELECT * FROM "first/attached".APIS' })).toContain("DEFAULT 'first'");
      db.exec("DROP TABLE temp.apis");
      expect(await loadQueryResultTransferSourceDdl(request)).toContain("DEFAULT 'main'");
      db.exec("DROP TABLE main.apis");
      expect(await loadQueryResultTransferSourceDdl(request)).toContain("DEFAULT 'first'");
      expect(api.executeMulti.mock.calls.every((call) => call[5].clientSessionId === "source_session")).toBe(true);
      expect(api.getTableDdl).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("does not skip a shadowing SQLite view to copy a different permanent table", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE apis (id INT); CREATE TEMP VIEW apis AS SELECT 42 AS id");
      api.executeMulti.mockImplementation(async (_connection, _database, sql) => [
        {
          rows: db
            .prepare(sql)
            .all()
            .map((row) => Object.values(row)),
        },
      ]);
      expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "sqlite", connectionId: "source", database: "main" })).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([{ rows: [], truncated: true }, { rows: [], has_more: true }, { rows: [], execution_error: true }, { rows: [["CREATE INDEX truncated..."]], large_value_cells: [{ row_index: 0, column_index: 0, original_bytes: 100000 }] }, { rows: [[null]] }])(
    "does not silently omit SQLite indexes after incomplete metadata: %s",
    async (result) => {
      api.executeMulti.mockResolvedValueOnce([{ rows: [["apis", "CREATE TABLE apis (id int)", "table"]] }]).mockResolvedValueOnce([result]);
      expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM main.apis", databaseType: "sqlite", connectionId: "source", database: "main" })).toBeUndefined();
    },
  );

  it.each(["APIS", "apis", "Apis"])("resolves unquoted H2 names from physical metadata (%s)", async (physicalName) => {
    h2Tables = [["PUBLIC", physicalName, "BASE TABLE"]];
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "h2", connectionId: "source", database: "test", schema: "PUBLIC" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "test", "PUBLIC", physicalName, undefined, undefined);
  });

  it("resolves an unquoted H2 schema without imposing uppercase storage", async () => {
    h2Tables = [["public", "apis", "BASE TABLE"]];
    await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM PUBLIC.APIS", databaseType: "h2", connectionId: "source", database: "test" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "test", "public", "apis", undefined, undefined);
  });

  it("retains exact quoted H2 names and rejects ambiguous unquoted tables", async () => {
    h2Tables = [["Public", "apis", "BASE TABLE"]];
    await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "Public"."apis"', databaseType: "h2", connectionId: "source", database: "test" });
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "test", "Public", "apis", undefined, undefined);
    api.executeMulti.mockClear();
    api.getTableDdl.mockClear();
    h2Tables = [
      ["PUBLIC", "APIS", "BASE TABLE"],
      ["PUBLIC", "apis", "BASE TABLE"],
    ];
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "h2", connectionId: "source", database: "test", schema: "PUBLIC" })).toBeUndefined();
    expect(api.getTableDdl).not.toHaveBeenCalled();
    expect(api.executeMulti.mock.calls.some((call) => call[2].startsWith("SCRIPT "))).toBe(false);
  });

  it("reads H2 SCRIPT through the independent metadata API to avoid committing the source transaction", async () => {
    // H2 2.2.224 reproduction: BEGIN; INSERT INTO APIS VALUES(1); SCRIPT
    // NODATA TABLE APIS; ROLLBACK; SELECT COUNT(*) FROM APIS returns 1.
    // The source session must receive only the read-only metadata lookup.
    const statements = ['CREATE MEMORY TABLE "PUBLIC"."APIS"("ID" INTEGER NOT NULL);', 'ALTER TABLE "PUBLIC"."APIS" ADD CONSTRAINT "PUBLIC"."CONSTRAINT_1" PRIMARY KEY("ID");', 'CREATE UNIQUE NULLS DISTINCT INDEX "PUBLIC"."IDX" ON "PUBLIC"."APIS"("ID" NULLS FIRST);'];
    api.getTableDdl.mockResolvedValueOnce(statements.join("\n"));
    const ddl = await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "PUBLIC"."APIS"', databaseType: "h2", connectionId: "source", database: "test", clientSessionId: "source_session" });
    expect(ddl).toBe(statements.join("\n"));
    expect(api.getTableDdl).toHaveBeenCalledWith("source", "test", "PUBLIC", "APIS", undefined, undefined);
    expect(api.executeMulti).toHaveBeenCalledTimes(1);
    expect(api.executeMulti).toHaveBeenCalledWith("source", "test", "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES", undefined, undefined, expect.objectContaining({ clientSessionId: "source_session" }));
    expect(rewriteCreateTableName(ddl!, '"ARCHIVE"."COPY"', "h2")).toContain('ON "ARCHIVE"."COPY"');
  });

  it("preserves real H2 SCRIPT inline table and column comments through rewriting", async () => {
    const statements = ['CREATE MEMORY TABLE "PUBLIC"."APIS" COMMENT \'table desc\'(\n    "ID" INTEGER NOT NULL,\n    "NAME" CHARACTER VARYING COMMENT \'column desc\'\n);', 'ALTER TABLE "PUBLIC"."APIS" ADD CONSTRAINT "PUBLIC"."CONSTRAINT_1" PRIMARY KEY("ID");'];
    api.getTableDdl.mockResolvedValueOnce(statements.join("\n"));
    const ddl = await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "h2", connectionId: "source", database: "test", schema: "PUBLIC" });
    const rewritten = rewriteCreateTableName(ddl!, '"ARCHIVE"."COPY"', "h2");
    expect(rewritten).toContain('CREATE MEMORY TABLE "ARCHIVE"."COPY" COMMENT \'table desc\'');
    expect(rewritten).toContain("\"NAME\" CHARACTER VARYING COMMENT 'column desc'");
  });

  it("preserves H2 explicit sequence dependencies so the rewriter can reject them safely", async () => {
    api.getTableDdl.mockResolvedValueOnce('CREATE SEQUENCE IF NOT EXISTS "PUBLIC"."SEQ" START WITH 1; CREATE MEMORY TABLE "PUBLIC"."APIS"("ID" BIGINT DEFAULT NEXT VALUE FOR "PUBLIC"."SEQ");');
    const ddl = await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "h2", connectionId: "source", database: "test", schema: "PUBLIC" });
    expect(ddl).toContain("CREATE SEQUENCE");
    expect(rewriteCreateTableName(ddl!, '"ARCHIVE"."COPY"', "h2")).toBeUndefined();
  });

  it("refuses H2 local temporary metadata on the source session without choosing a permanent shadow", async () => {
    h2Tables = [["PUBLIC", "Apis", "LOCAL TEMPORARY"]];
    expect(await loadQueryResultTransferSourceDdl({ sql: 'SELECT * FROM "PUBLIC"."Apis"', databaseType: "h2", connectionId: "source", database: "test", clientSessionId: "source_session" })).toBeUndefined();
    expect(api.executeMulti.mock.calls.every((call) => call[5].clientSessionId === "source_session")).toBe(true);
    expect(api.executeMulti.mock.calls.some((call) => call[2].startsWith("SCRIPT "))).toBe(false);
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it.each(["SELECT id FROM apis", "SELECT a.*, b.name FROM apis a JOIN users b ON b.id = a.id", "SELECT 1 AS id"])("does not fetch whole-table DDL for %s", async (sql) => {
    expect(await loadQueryResultTransferSourceDdl({ sql, databaseType: "postgres", connectionId: "source", database: "source_db", schema: "public" })).toBeUndefined();
    expect(api.getTableDdl).not.toHaveBeenCalled();
  });

  it("returns unavailable instead of switching to display DDL after a metadata error", async () => {
    api.getTableDdl.mockRejectedValueOnce(new Error("metadata failed"));
    expect(await loadQueryResultTransferSourceDdl({ sql: "SELECT * FROM apis", databaseType: "postgres", connectionId: "source", database: "source_db", schema: "public" })).toBeUndefined();
    expect(api.getTableDisplayDdl).not.toHaveBeenCalled();
  });
});
