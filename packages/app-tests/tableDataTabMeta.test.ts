import { strict as assert } from "node:assert";
import { test } from "vitest";
import { tableMetaForDataTab } from "../../apps/desktop/src/lib/table/tableDataTabMeta.ts";
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
    schema: "public",
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

  assert.equal(tableMetaForDataTab(tab({ tableMeta })), tableMeta);
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

test("prefers the tableMeta table name over a schema-qualified tab title", () => {
  // Data tabs opened from the object browser are titled "<schema>.<table>";
  // rebuilding SQL from the title would qualify the table twice (issue #3613).
  const tableMeta = {
    schema: "dbo",
    tableName: "wcs_dispatch_task",
    columns: [],
    primaryKeys: [],
  };

  const meta = tableMetaForDataTab(tab({ title: "dbo.wcs_dispatch_task", schema: "dbo", tableMeta }));

  assert.equal(meta?.tableName, "wcs_dispatch_task");
  assert.equal(meta?.schema, "dbo");
});

test("strips the schema prefix from the tab title when no tableMeta exists", () => {
  const meta = tableMetaForDataTab(tab({ title: "dbo.wcs_dispatch_task", schema: "dbo" }));

  assert.equal(meta?.tableName, "wcs_dispatch_task");
  assert.equal(meta?.schema, "dbo");
});

test("keeps a dotted tab title intact when it does not start with the schema", () => {
  const meta = tableMetaForDataTab(tab({ title: "audit.2024_log", schema: "public" }));

  assert.equal(meta?.tableName, "audit.2024_log");
});

test("does not infer table metadata for query tabs", () => {
  assert.equal(tableMetaForDataTab(tab({ mode: "query" })), undefined);
});
