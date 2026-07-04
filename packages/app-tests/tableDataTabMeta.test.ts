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

test("does not infer table metadata for query tabs", () => {
  assert.equal(tableMetaForDataTab(tab({ mode: "query" })), undefined);
});
