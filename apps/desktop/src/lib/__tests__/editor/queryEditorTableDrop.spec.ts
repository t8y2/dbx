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
