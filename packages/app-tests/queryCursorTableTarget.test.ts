import { strict as assert } from "node:assert";
import { test } from "vitest";
import { extractQualifiedIdentifierPartsAt, findLoadedTableTargetForCandidate, qualifiedTableNameAtSqlPosition, queryContextTargetFromCandidate, queryCursorTableCandidate } from "../../apps/desktop/src/lib/sql/queryCursorTableTarget.ts";
import type { QueryTab, TreeNode } from "../../apps/desktop/src/types/database.ts";

function queryTab(sql: string, head: number, schema = "public"): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    schema,
    sql,
    editorSelection: { anchor: head, head },
    isExecuting: false,
    mode: "query",
  };
}

test("extracts the qualified identifier under or after the cursor", () => {
  const sql = "select * from public.users";
  assert.deepEqual(
    extractQualifiedIdentifierPartsAt(sql, sql.length).map((part) => part.value),
    ["public", "users"],
  );
  assert.deepEqual(
    extractQualifiedIdentifierPartsAt("select * from `sales-db`.`Order`", 29).map((part) => part.value),
    ["sales-db", "Order"],
  );
  assert.deepEqual(
    extractQualifiedIdentifierPartsAt('select * from "public"."order"', 26).map((part) => part.value),
    ["public", "order"],
  );
});

test("resolves the table name at a context-menu position", () => {
  const sql = "select * from reporting.users where id = 1";

  assert.equal(qualifiedTableNameAtSqlPosition(sql, sql.indexOf("users") + 2), "reporting.users");
  assert.equal(qualifiedTableNameAtSqlPosition("select * from users", "select * from users".length), "users");
  assert.equal(qualifiedTableNameAtSqlPosition(sql, sql.indexOf("where") + 1), null);
});

test("builds schema-aware cursor table candidates", () => {
  const tab = queryTab("select * from reporting.users", "select * from reporting.users".length);

  assert.deepEqual(queryCursorTableCandidate(tab, "postgres"), {
    connectionId: "conn-1",
    database: "app",
    schema: "reporting",
    tableName: "users",
  });
});

test("builds database-qualified candidates for multi-database non-schema engines", () => {
  const tab = queryTab("select * from analytics.events", "select * from analytics.events".length, undefined);

  assert.deepEqual(queryCursorTableCandidate(tab, "mysql"), {
    connectionId: "conn-1",
    database: "analytics",
    schema: undefined,
    tableName: "events",
  });
});

test("falls back to the candidate database and schema when no table is loaded", () => {
  const tab = queryTab("select * from reporting.missing", "select * from reporting.missing".length);
  const candidate = queryCursorTableCandidate(tab, "postgres");

  assert.deepEqual(queryContextTargetFromCandidate(tab, candidate), {
    type: "query-context",
    connectionId: "conn-1",
    database: "app",
    schema: "reporting",
  });
});

test("resolves loaded table targets case-insensitively and keeps actual tree labels", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn-1",
      label: "local",
      type: "connection",
      connectionId: "conn-1",
      children: [
        {
          id: "db-app",
          label: "app",
          type: "database",
          connectionId: "conn-1",
          database: "app",
          children: [{ id: "users", label: "Users", type: "table", connectionId: "conn-1", database: "app", schema: "public" }],
        },
      ],
    },
  ];

  assert.deepEqual(findLoadedTableTargetForCandidate(nodes, { connectionId: "conn-1", database: "APP", schema: "PUBLIC", tableName: "users" }), {
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    tableName: "Users",
  });
});
