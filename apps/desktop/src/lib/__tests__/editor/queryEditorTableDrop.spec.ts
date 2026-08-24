import { describe, expect, it } from "vitest";
import { createTableReferencePayload, parseTableReferencePayload, tableReferenceInsertText } from "@/lib/editor/queryEditorTableDrop";

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
});
