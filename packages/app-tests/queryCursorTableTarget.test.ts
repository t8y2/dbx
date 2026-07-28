import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  extractQualifiedIdentifierPartsAt,
  findLoadedTableTargetForCandidate,
  qualifiedTableNameAtSqlPosition,
  queryContextObjectActions,
  queryContextTargetFromCandidate,
  queryCursorTableCandidate,
  queryTableCandidateAtSqlPosition,
  resolveQueryContextCandidateDatabase,
  resolveQueryContextObjectTarget,
} from "../../apps/desktop/src/lib/sql/queryCursorTableTarget.ts";
import { qualifiedTableName } from "../../apps/desktop/src/lib/table/tableSelectSql.ts";
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
  assert.equal(qualifiedTableNameAtSqlPosition(sql, sql.indexOf(" where")), "reporting.users");
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

test("builds SQL Server view candidates from bracket-quoted identifiers", () => {
  const sql = "SELECT * FROM [sales].[v_city_sales]";
  const tab = queryTab(sql, sql.length, undefined);

  assert.deepEqual(queryCursorTableCandidate(tab, "sqlserver"), {
    connectionId: "conn-1",
    database: "app",
    schema: "sales",
    tableName: "v_city_sales",
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

test("builds three-part candidates at an explicit context-menu position", () => {
  const sql = 'select * from "warehouse"."reporting"."Daily Sales"';

  assert.deepEqual(queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "app", schema: "public", databaseType: "postgres", sql, position: sql.indexOf("Daily") + 2 }), {
    connectionId: "conn-1",
    database: "warehouse",
    schema: "reporting",
    tableName: "Daily Sales",
  });
});

test("folds unquoted Oracle-compatible identifiers before view-data quoting", () => {
  for (const databaseType of ["oracle", "dameng"] as const) {
    const sql = "select * from app.order_items";
    const candidate = queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "service", databaseType, sql, position: sql.indexOf("order") });

    assert.deepEqual(candidate, {
      connectionId: "conn-1",
      database: "service",
      schema: "APP",
      tableName: "ORDER_ITEMS",
    });
    assert.equal(qualifiedTableName({ databaseType, schema: candidate?.schema, tableName: candidate?.tableName ?? "" }), '"APP"."ORDER_ITEMS"');
  }
});

test("preserves explicitly quoted Oracle-compatible identifier case", () => {
  const sql = 'select * from "App"."Order_Items"';
  const candidate = queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "service", databaseType: "oracle", sql, position: sql.indexOf("Order") });

  assert.deepEqual(candidate, {
    connectionId: "conn-1",
    database: "service",
    schema: "App",
    tableName: "Order_Items",
  });
  assert.equal(qualifiedTableName({ databaseType: "oracle", schema: candidate?.schema, tableName: candidate?.tableName ?? "" }), '"App"."Order_Items"');
});

test("folds PostgreSQL unquoted identifiers without changing quoted names", () => {
  const unquotedSql = "select * from Reporting.Users";
  const quotedSql = 'select * from "Reporting"."Users"';

  assert.deepEqual(queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "app", databaseType: "postgres", sql: unquotedSql, position: unquotedSql.indexOf("Users") }), {
    connectionId: "conn-1",
    database: "app",
    schema: "reporting",
    tableName: "users",
  });
  assert.deepEqual(queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "app", databaseType: "postgres", sql: quotedSql, position: quotedSql.indexOf("Users") }), {
    connectionId: "conn-1",
    database: "app",
    schema: "Reporting",
    tableName: "Users",
  });
});

test("parses escaped quotes inside qualified identifiers", () => {
  const sql = 'select * from "warehouse"."reporting"."Daily ""Sales"""';

  assert.deepEqual(queryTableCandidateAtSqlPosition({ connectionId: "conn-1", database: "app", schema: "public", databaseType: "postgres", sql, position: sql.indexOf("Sales") }), {
    connectionId: "conn-1",
    database: "warehouse",
    schema: "reporting",
    tableName: 'Daily "Sales"',
  });
});

test("resolves database qualifiers case-insensitively from local metadata", () => {
  const candidate = { connectionId: "conn-1", database: "analytics", schema: undefined, tableName: "events" };

  assert.deepEqual(resolveQueryContextCandidateDatabase(candidate, ["App", "Analytics"]), {
    ...candidate,
    database: "Analytics",
  });
  assert.equal(resolveQueryContextCandidateDatabase(candidate, []), candidate);
});

test("resolves cached relation types and actual casing for context-menu targets", () => {
  const candidate = { connectionId: "conn-1", database: "app", schema: "REPORTING", tableName: "daily_sales" };

  assert.deepEqual(
    resolveQueryContextObjectTarget(candidate, [
      { name: "daily_sales", schema: "archive", type: "table" },
      { name: "Daily_Sales", schema: "reporting", type: "materialized_view" },
    ]),
    {
      name: "Daily_Sales",
      database: "app",
      schema: "reporting",
      type: "materialized_view",
    },
  );
});

test("preserves table actions when context-menu metadata is unavailable", () => {
  const candidate = { connectionId: "conn-1", database: "app", schema: "public", tableName: "unknown_relation" };

  assert.deepEqual(resolveQueryContextObjectTarget(candidate, []), {
    name: "unknown_relation",
    database: "app",
    schema: "public",
  });
  assert.deepEqual(queryContextObjectActions(undefined), ["view-data", "edit-table-structure", "view-ddl"]);
});

test("uses source actions for views and materialized views", () => {
  const expected = ["view-data", "edit-view", "view-source", "view-ddl"];

  assert.deepEqual(queryContextObjectActions("view"), expected);
  assert.deepEqual(queryContextObjectActions("materialized_view"), expected);
  assert.deepEqual(queryContextObjectActions("table"), ["view-data", "edit-table-structure", "view-ddl"]);
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
