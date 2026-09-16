import { describe, expect, it } from "vitest";
import { aiTableMentionFromTableReference } from "@/lib/ai/aiTableReferenceDrop";
import { createTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";

describe("ai table reference drop", () => {
  const context = { connectionId: "conn-1", database: "app-db" };

  it("maps a table payload to a table mention", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      schema: "public",
      tableName: "users",
      databaseType: "postgres",
    });

    expect(aiTableMentionFromTableReference(payload, context)).toEqual({
      raw: "@public.users",
      schema: "public",
      table: "users",
    });
  });

  it("quotes mention parts that are not simple identifiers", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      tableName: "order items",
      databaseType: "mysql",
    });

    expect(aiTableMentionFromTableReference(payload, context)).toEqual({
      raw: '@"order items"',
      schema: undefined,
      table: "order items",
    });
  });

  it("ignores database references", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      referenceType: "database",
      databaseType: "mysql",
    });

    expect(aiTableMentionFromTableReference(payload, context)).toBeNull();
  });

  it("ignores column references", () => {
    const payload = createTableReferencePayload({
      connectionId: "conn-1",
      database: "app-db",
      schema: "public",
      tableName: "users",
      columnName: "email",
      databaseType: "postgres",
    });

    expect(aiTableMentionFromTableReference(payload, context)).toBeNull();
  });

  it("ignores empty payloads", () => {
    expect(aiTableMentionFromTableReference(null, context)).toBeNull();
    expect(aiTableMentionFromTableReference(undefined, context)).toBeNull();
  });
});
