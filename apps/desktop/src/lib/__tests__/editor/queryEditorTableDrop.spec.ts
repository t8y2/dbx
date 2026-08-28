import { describe, expect, it } from "vitest";
import { createColumnReferencePayload, createTableReferencePayload, parseTableReferencePayload, tableReferenceInsertText } from "@/lib/editor/queryEditorTableDrop";

describe("query editor table reference drop", () => {
  it("inserts a quoted database name for database references", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      referenceType: "database",
      databaseType: "mysql",
    });

    expect(payload).not.toBeNull();
    expect(tableReferenceInsertText(payload!)).toBe("`app-db`");
  });

  it("preserves the Phoenix schema in dragged table references", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "default",
      schema: "APP",
      tableName: "USERS",
      databaseType: "jdbc",
      driverProfile: "phoenix",
    })!;

    expect(parseTableReferencePayload(JSON.stringify(payload))).toEqual(payload);
    expect(tableReferenceInsertText(payload)).toBe("APP.USERS");
  });

  it("round-trips database reference payloads", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "reporting",
      referenceType: "database",
      databaseType: "postgres",
    })!;

    expect(parseTableReferencePayload(JSON.stringify(payload))).toEqual(payload);
  });

  it("creates a column-only payload without a source table", () => {
    const payload = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "order no"],
      databaseType: "mysql",
    });

    expect(payload).toEqual({
      kind: "dbx-table-reference",
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "order no"],
      referenceType: "column",
      databaseType: "mysql",
    } satisfies Partial<typeof payload>);
    expect(payload && "tableName" in payload).toBe(false);
  });

  it("rejects column payloads without connection, database, or names", () => {
    expect(createColumnReferencePayload({ database: "db", columnNames: ["id"] })).toBeNull();
    expect(createColumnReferencePayload({ connectionId: "conn-1", columnNames: ["id"] })).toBeNull();
    expect(createColumnReferencePayload({ connectionId: "conn-1", database: "db", columnNames: [] })).toBeNull();
    expect(createColumnReferencePayload({ connectionId: "conn-1", database: "db", columnNames: ["", "  "] })).toBeNull();
  });

  it("trims surrounding whitespace from column names instead of inserting it verbatim", () => {
    const payload = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "db",
      columnNames: [" id ", "name"],
    })!;
    expect(payload.columnNames).toEqual(["id", "name"]);
  });

  it("round-trips multi-column payloads and keeps legacy single-column payloads parseable", () => {
    const multi = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      schema: "public",
      columnNames: ["id", "name"],
      databaseType: "postgres",
    })!;
    expect(parseTableReferencePayload(JSON.stringify(multi))).toEqual(multi);

    const legacy = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      tableName: "users",
      columnName: "email",
      databaseType: "postgres",
    })!;
    expect(parseTableReferencePayload(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("inserts smart-quoted names per selected column joined by comma + newline", () => {
    // 普通名称裸输出，保留字/含特殊字符才加方言引号
    const mysql = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "order no", "order", "created_at"],
      databaseType: "mysql",
    })!;
    expect(tableReferenceInsertText(mysql)).toBe("id,\n`order no`,\n`order`,\ncreated_at");

    const postgres = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "OrderNo", "select"],
      databaseType: "postgres",
    })!;
    expect(tableReferenceInsertText(postgres)).toBe('id,\n"OrderNo",\n"select"');
  });

  it("keeps smart quoting for dialects without a dedicated keyword table", () => {
    // 未知方言用通用保守判定：普通名裸输出，特殊字符走全量引号回退
    const oracle = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "order no"],
      databaseType: "oracle",
    })!;
    expect(tableReferenceInsertText(oracle)).toBe('id,\n"order no"');
  });

  it("bare-quotes sqlserver columns when safe and brackets reserved words", () => {
    const payload = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["id", "order", "order no"],
      databaseType: "sqlserver",
    })!;
    expect(tableReferenceInsertText(payload)).toBe("id,\n[order],\n[order no]");
  });

  it("falls back to the editor database type when the payload omits one", () => {
    const payload = createColumnReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      columnNames: ["order no"],
    })!;
    expect(tableReferenceInsertText(payload, "mysql")).toBe("`order no`");
  });
});
