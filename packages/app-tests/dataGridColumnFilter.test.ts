import { strict as assert } from "node:assert";
import test from "node:test";
import {
  appendColumnValueFilterCondition,
  buildColumnValueFilterCondition,
} from "../../apps/desktop/src/lib/dataGridColumnFilter.ts";

function installFilterFetchMock() {
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== "/api/query/build-data-grid-column-value-filter-condition") {
      return new Response("unexpected request", { status: 500 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const options = body.options;
    const quote =
      options.databaseType === "mysql"
        ? (name: string) => `\`${name}\``
        : options.databaseType === "sqlserver"
          ? (name: string) => `[${name}]`
          : (name: string) => `"${name}"`;
    const text = String(options.rawValue ?? "").trim();
    const result = /^null$/i.test(text)
      ? `${quote(options.columnName)} IS NULL`
      : `${quote(options.columnName)} = ${/^\d+$/.test(text) ? text : `'${text}'`}`;
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("builds a numeric server-side column filter from typed text", async () => {
  installFilterFetchMock();
  const condition = await buildColumnValueFilterCondition({
    databaseType: "mysql",
    columnName: "id",
    columnInfo: { name: "id", data_type: "int", is_nullable: false, is_primary_key: true },
    rawValue: "49436",
  });

  assert.equal(condition, "`id` = 49436");
});

test("quotes text server-side column filters and appends them to existing WHERE input", async () => {
  installFilterFetchMock();
  const condition = await buildColumnValueFilterCondition({
    databaseType: "postgres",
    columnName: "status",
    columnInfo: { name: "status", data_type: "varchar", is_nullable: true, is_primary_key: false },
    rawValue: "active",
  });

  assert.equal(condition, `"status" = 'active'`);
  assert.equal(appendColumnValueFilterCondition("deleted_at IS NULL", condition), `(deleted_at IS NULL) AND ("status" = 'active')`);
});

test("builds IS NULL for typed NULL filters", async () => {
  installFilterFetchMock();
  const condition = await buildColumnValueFilterCondition({
    databaseType: "sqlserver",
    columnName: "archived_at",
    rawValue: "NULL",
  });

  assert.equal(condition, "[archived_at] IS NULL");
});
