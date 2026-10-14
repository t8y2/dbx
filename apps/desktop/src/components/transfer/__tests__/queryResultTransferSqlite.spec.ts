import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { nonInsertableColumnNamesFromDdl, rewriteCreateTableName } from "../queryResultTransfer";
import { queryResultTransferInsertSql } from "../queryResultTransferStatements";
import { queryResultTransferSqlLiteral } from "../queryResultTransferValues";

describe("query result transfer against SQLite", () => {
  it("copies a real schema and values, including generated columns, references and quoted identifiers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE "apis" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          " name " TEXT NOT NULL DEFAULT 'fallback',
          "parent" INTEGER REFERENCES "apis" ("id"),
          "length" INTEGER GENERATED ALWAYS AS (length(" name ")) STORED
        );
        CREATE INDEX "idx_apis_name" ON "apis" (" name ");`);
      const insert = db.prepare('INSERT INTO "apis" (" name ", "parent") VALUES (?, ?)');
      insert.run("C:\\data\\请求", null);
      insert.run("O'Reilly", 1);
      const rows = db.prepare('SELECT * FROM "apis"').all();
      const ddl = db
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'apis' AND sql IS NOT NULL ORDER BY type DESC")
        .all()
        .map((row) => row.sql)
        .join(";\n");
      const rewritten = rewriteCreateTableName(ddl, '"copy"', "sqlite", undefined, "apis");
      expect(rewritten).toBeDefined();
      const generated = nonInsertableColumnNamesFromDdl(ddl, "sqlite");
      const columns = Object.keys(rows[0]!).filter((name) => !generated.has(name));
      const values = rows.map((row) => `(${columns.map((column) => queryResultTransferSqlLiteral(row[column], "sqlite")).join(", ")})`);
      const statements = queryResultTransferInsertSql(
        '"copy"',
        columns.map((column) => `"${column}"`),
        values,
        "sqlite",
      );
      db.exec(`BEGIN; ${rewritten}; ${statements.join(";")}; COMMIT;`);

      expect(db.prepare('SELECT * FROM "copy"').all()).toEqual(rows);
      expect(db.prepare('PRAGMA table_xinfo("copy")').all()).toEqual(db.prepare('PRAGMA table_xinfo("apis")').all());
      expect(db.prepare('PRAGMA foreign_key_list("copy")').all()[0]?.table).toBe("copy");
      expect(db.prepare('PRAGMA index_list("copy")').all()).toHaveLength(1);
      db.exec('INSERT INTO "copy" DEFAULT VALUES');
      expect(db.prepare('SELECT id, " name " AS name, length FROM "copy" WHERE id = 3').get()).toEqual({ id: 3, name: "fallback", length: 8 });
    } finally {
      db.close();
    }
  });

  it("rolls back both table creation and rows when a copied constraint rejects an insert", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const ddl = rewriteCreateTableName("CREATE TABLE source (id INTEGER PRIMARY KEY, value TEXT NOT NULL)", '"copy"', "sqlite")!;
      db.exec("BEGIN");
      db.exec(ddl);
      const statements = queryResultTransferInsertSql('"copy"', ['"id"', '"value"'], ["(1, 'ok')", "(2, NULL)"], "sqlite");
      expect(() => statements.forEach((sql) => db.exec(sql))).toThrow(/NOT NULL/);
      db.exec("ROLLBACK");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'copy'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
