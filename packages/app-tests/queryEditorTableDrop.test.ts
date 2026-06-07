import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DBX_TABLE_REFERENCE_MIME,
  activeTableReferencePayloadValue,
  clearActiveTableReferencePayload,
  createTableReferencePayload,
  hasTableReferencePayloadType,
  parseTableReferencePayload,
  serializeTableReferencePayload,
  setActiveTableReferencePayload,
  tableReferenceInsertText,
} from "../../apps/desktop/src/lib/queryEditorTableDrop.ts";

test("creates table drag payload only when table context is complete", () => {
  assert.equal(createTableReferencePayload({ connectionId: "c1", database: "db" }), null);
  assert.deepEqual(
    createTableReferencePayload({
      connectionId: "c1",
      database: "",
      tableName: "catalogless_table",
      databaseType: "sqlite",
    }),
    {
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "",
      tableName: "catalogless_table",
      databaseType: "sqlite",
    },
  );
  assert.deepEqual(
    createTableReferencePayload({
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "very long table",
      databaseType: "postgres",
    }),
    {
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "db",
      schema: "public",
      tableName: "very long table",
      databaseType: "postgres",
    },
  );
});

test("round trips table drag payload and rejects unrelated data", () => {
  const payload = createTableReferencePayload({
    connectionId: "c1",
    database: "db",
    tableName: "orders",
    databaseType: "mysql",
  });
  assert.ok(payload);
  assert.deepEqual(parseTableReferencePayload(serializeTableReferencePayload(payload)), payload);
  assert.deepEqual(
    parseTableReferencePayload(
      JSON.stringify({
        kind: "dbx-table-reference",
        connectionId: "c1",
        database: "",
        tableName: "orders",
      }),
    ),
    {
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "",
      tableName: "orders",
    },
  );
  assert.equal(parseTableReferencePayload("not json"), null);
  assert.equal(parseTableReferencePayload(JSON.stringify({ kind: "dbx-table-reference", tableName: "orders" })), null);
});

test("tracks the active in-app table drag payload without dataTransfer reads", () => {
  const payload = createTableReferencePayload({
    connectionId: "c1",
    database: "",
    tableName: "orders",
    databaseType: "sqlite",
  });
  assert.ok(payload);
  setActiveTableReferencePayload(payload);
  assert.equal(activeTableReferencePayloadValue(), payload);
  clearActiveTableReferencePayload(payload);
  assert.equal(activeTableReferencePayloadValue(), null);
});

test("detects table drag payload type without reading drag data", () => {
  assert.equal(hasTableReferencePayloadType(undefined), false);
  assert.equal(hasTableReferencePayloadType(["text/plain"]), false);
  assert.equal(hasTableReferencePayloadType(["text/plain", DBX_TABLE_REFERENCE_MIME]), true);
});

test("formats dropped table reference for the source database type", () => {
  assert.equal(
    tableReferenceInsertText({
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "db",
      schema: "sales",
      tableName: "customer order",
      databaseType: "postgres",
    }),
    '"sales"."customer order"',
  );
  assert.equal(
    tableReferenceInsertText({
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "db",
      schema: "dbo",
      tableName: "Order Detail",
      databaseType: "sqlserver",
    }),
    "[dbo].[Order Detail]",
  );
  assert.equal(
    tableReferenceInsertText({
      kind: "dbx-table-reference",
      connectionId: "c1",
      database: "db",
      schema: "ignored",
      tableName: "order-detail",
      databaseType: "mysql",
    }),
    "`order-detail`",
  );
});
