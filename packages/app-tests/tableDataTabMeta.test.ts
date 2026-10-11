import { strict as assert } from "node:assert";
import { test } from "vitest";
import { repairRestoredDataTabTableIdentity, tableMetaForDataTab } from "../../apps/desktop/src/lib/table/tableDataTabMeta.ts";
import type { QueryTab } from "../../apps/desktop/src/types/database.ts";

function tab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    sql: "select * from users",
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "data",
    ...overrides,
  };
}

test("returns persisted table metadata for a data tab", () => {
  const tableMeta = {
    tableName: "users",
    columns: [
      {
        name: "id",
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        extra: null,
      },
    ],
    primaryKeys: ["id"],
  };

  const restored = tab({ title: "public.users", schema: undefined, sql: 'SELECT * FROM "public"."users"', tableMeta });

  assert.equal(repairRestoredDataTabTableIdentity(restored, "postgres"), false);
  assert.equal(tableMetaForDataTab(restored), tableMeta);
});

test("builds fallback metadata from a data tab when column metadata is unavailable", () => {
  const meta = tableMetaForDataTab(
    tab({
      result: {
        columns: ["id", "name"],
        rows: [],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    }),
  );

  assert.deepEqual(meta, {
    schema: "public",
    tableName: "users",
    columns: [
      {
        name: "id",
        data_type: "",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
      {
        name: "name",
        data_type: "",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ],
    primaryKeys: [],
  });
});

test("uses result columns when persisted table metadata has no columns", () => {
  const tableMeta = {
    schema: "public",
    tableName: "users",
    columns: [],
    primaryKeys: ["id"],
  };

  assert.deepEqual(
    tableMetaForDataTab(
      tab({
        tableMeta,
        result: {
          columns: ["id", "name"],
          rows: [],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      }),
    ),
    {
      schema: "public",
      tableName: "users",
      columns: [
        {
          name: "id",
          data_type: "",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
        {
          name: "name",
          data_type: "",
          is_nullable: true,
          column_default: null,
          is_primary_key: false,
          extra: null,
        },
      ],
      primaryKeys: ["id"],
    },
  );
});

test("preserves SQL Server tableMeta instead of qualifying its title twice (#3613)", () => {
  // Data tabs opened from the object browser are titled "<schema>.<table>";
  // rebuilding SQL from the title would qualify the table twice (issue #3613).
  const tableMeta = {
    schema: "dbo",
    tableName: "wcs_dispatch_task",
    columns: [],
    primaryKeys: [],
  };

  const restored = tab({ title: "dbo.wcs_dispatch_task", schema: "dbo", tableMeta });

  assert.equal(repairRestoredDataTabTableIdentity(restored, "sqlserver"), false);
  const meta = tableMetaForDataTab(restored);

  assert.equal(meta?.tableName, "wcs_dispatch_task");
  assert.equal(meta?.schema, "dbo");
});

test("strips the schema prefix from the tab title when no tableMeta exists", () => {
  const restored = tab({ title: "public.users", schema: "public", sql: "SELECT * FROM public.users" });

  assert.equal(repairRestoredDataTabTableIdentity(restored, "postgres"), false);
  const meta = tableMetaForDataTab(restored);

  assert.equal(meta?.tableName, "users");
  assert.equal(meta?.schema, "public");
});

test("keeps a dotted tab title intact when it does not start with the schema", () => {
  const meta = tableMetaForDataTab(tab({ title: "audit.2024_log", schema: "public" }));

  assert.equal(meta?.tableName, "audit.2024_log");
});

test("repairs a restored PostgreSQL qualified title only when its SELECT confirms the identity", () => {
  const restored = tab({
    title: "term.MSS_CHECK_SALES_ITEM",
    schema: undefined,
    sql: 'SELECT * FROM "term"."MSS_CHECK_SALES_ITEM"',
    result: {
      columns: ["ITEM_ID", "STATUS"],
      rows: [],
      affected_rows: 0,
      execution_time_ms: 1,
    },
  });

  assert.equal(repairRestoredDataTabTableIdentity(restored, "postgres"), true);
  const meta = tableMetaForDataTab(restored);

  assert.equal(meta?.schema, "term");
  assert.equal(meta?.tableName, "MSS_CHECK_SALES_ITEM");
  assert.deepEqual(
    meta?.columns.map((column) => column.name),
    ["ITEM_ID", "STATUS"],
  );
  assert.deepEqual(meta?.primaryKeys, []);
});

test("does not split a restored PostgreSQL title for a literal dotted table name", () => {
  const restored = tab({
    title: "audit.2024_log",
    schema: undefined,
    sql: 'SELECT * FROM "audit.2024_log"',
  });

  assert.equal(repairRestoredDataTabTableIdentity(restored, "postgres"), false);
  const meta = tableMetaForDataTab(restored);

  assert.equal(meta?.schema, undefined);
  assert.equal(meta?.tableName, "audit.2024_log");
});

test("does not infer table metadata for query tabs", () => {
  assert.equal(tableMetaForDataTab(tab({ mode: "query" })), undefined);
});
