import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  appendColumnValueFilterCondition,
  buildColumnValueFilterCondition,
  buildColumnValuesFilterCondition,
  filterModeHasCompleteValue,
  filterModeIsSupportedForDatabase,
  parseFilterValue,
  parseFilterValues,
  removeColumnValueFilterCondition,
  replaceColumnValueFilterCondition,
} from "../../apps/desktop/src/lib/dataGrid/dataGridColumnFilter.ts";
import { buildDataGridContextFilterCondition } from "../../apps/desktop/src/lib/dataGrid/dataGridSql.ts";

let lastContextFilterOptions: Record<string, unknown> | undefined;

function installFilterFetchMock() {
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/query/build-data-grid-context-filter-condition") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      lastContextFilterOptions = body.options;
      return new Response(JSON.stringify("mock condition"), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(input) === "/api/query/build-data-grid-column-values-filter-condition") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const options = body.options;
      const quote = options.databaseType === "mysql" ? (name: string) => `\`${name}\`` : options.databaseType === "sqlserver" ? (name: string) => `[${name}]` : (name: string) => `"${name}"`;
      const values = options.values ?? [];
      const nonNull = values.filter((value: unknown) => value !== null);
      const nullClause = values.some((value: unknown) => value === null) ? `${quote(options.columnName)} IS NULL` : "";
      const valueClause = nonNull.length ? `${quote(options.columnName)} IN (${nonNull.map((value: unknown) => (typeof value === "number" ? value : `'${value}'`)).join(", ")})` : "";
      const result = [nullClause, valueClause].filter(Boolean).join(" OR ");
      return new Response(JSON.stringify(result ? `(${result})` : null), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(input) !== "/api/query/build-data-grid-column-value-filter-condition") {
      return new Response("unexpected request", { status: 500 });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const options = body.options;
    const quote = options.databaseType === "mysql" ? (name: string) => `\`${name}\`` : options.databaseType === "sqlserver" ? (name: string) => `[${name}]` : (name: string) => `"${name}"`;
    const text = String(options.rawValue ?? "").trim();
    const result = /^null$/i.test(text) ? `${quote(options.columnName)} IS NULL` : `${quote(options.columnName)} = ${/^\d+$/.test(text) ? text : `'${text}'`}`;
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

test("replaces a repeated database value filter without stacking incompatible conditions", () => {
  const firstStatus = `"status" = 'active'`;
  const secondStatus = `"status" IN ('pending', 'disabled')`;
  const initial = appendColumnValueFilterCondition("deleted_at IS NULL", firstStatus);

  assert.equal(replaceColumnValueFilterCondition(initial, firstStatus, secondStatus), `(deleted_at IS NULL) AND ("status" IN ('pending', 'disabled'))`);
});

test("removes nested database value filters while preserving unrelated predicates", () => {
  const status = `"status" = 'active'`;
  const tenant = `"tenant_id" = 42`;
  const whereInput = appendColumnValueFilterCondition(appendColumnValueFilterCondition("deleted_at IS NULL", status), tenant);

  assert.equal(removeColumnValueFilterCondition(whereInput, status), `(deleted_at IS NULL) AND ("tenant_id" = 42)`);
  assert.equal(removeColumnValueFilterCondition(`score BETWEEN 10 AND 20`, status), `score BETWEEN 10 AND 20`);
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

test("builds multi-value server-side column filters", async () => {
  installFilterFetchMock();
  const condition = await buildColumnValuesFilterCondition({
    databaseType: "postgres",
    columnName: "status",
    columnInfo: { name: "status", data_type: "varchar", is_nullable: true, is_primary_key: false },
    values: ["active", "pending", null],
  });

  assert.equal(condition, `("status" IS NULL OR "status" IN ('active', 'pending'))`);
});

test("parses comma and newline separated structured IN values", () => {
  const values = parseFilterValues(`alpha, 'beta,gamma'\n42\nNULL\n"NULL"\n'it''s'`, { data_type: "int" });

  assert.deepEqual(values, ["alpha", "beta,gamma", "42", null, "NULL", "it's"]);
  assert.deepEqual(parseFilterValues('a,,\n"b""c",d\te'), ["a", 'b"c', "d\te"]);
});

test("parses typed structured IN values without losing large integers", () => {
  assert.deepEqual(parseFilterValues("true, false", { data_type: "boolean" }), [true, false]);
  assert.deepEqual(parseFilterValues("9007199254740993", { data_type: "bigint" }), ["9007199254740993"]);
  assert.deepEqual(parseFilterValues("0.123456789012345678", { data_type: "decimal(38,18)" }), ["0.123456789012345678"]);
  assert.equal(parseFilterValue("0.123456789012345678", { data_type: "decimal(38,18)" }), "0.123456789012345678");
  assert.deepEqual(parseFilterValues("true, false", { data_type: "bit(1)" }, "postgres"), ["true", "false"]);
  assert.equal(parseFilterValue("true", { data_type: "bit varying" }, "postgres"), "true");
  assert.equal(parseFilterValue("true", { data_type: "bit" }, "sqlserver"), true);
});

test("hides list and range modes for unsupported dialects", () => {
  for (const databaseType of ["cassandra", "influxdb", "jdbc"] as const) {
    assert.equal(filterModeIsSupportedForDatabase("in", databaseType), false);
    assert.equal(filterModeIsSupportedForDatabase("not-in", databaseType), false);
    assert.equal(filterModeIsSupportedForDatabase("between", databaseType), false);
    assert.equal(filterModeIsSupportedForDatabase("not-between", databaseType), false);
  }
  assert.equal(filterModeIsSupportedForDatabase("between", "postgres"), true);
  assert.equal(filterModeIsSupportedForDatabase("is-null", "influxdb"), true);
});

test("requires usable values for structured list and range filters", () => {
  assert.equal(filterModeHasCompleteValue("in", " , \n "), false);
  assert.equal(filterModeHasCompleteValue("not-in", "active, pending"), true);
  assert.equal(filterModeHasCompleteValue("between", "10", ""), false);
  assert.equal(filterModeHasCompleteValue("not-between", "10", "20"), true);
  assert.equal(filterModeHasCompleteValue("is-null", "", ""), true);
});

test("passes list and range values through the shared context filter API", async () => {
  installFilterFetchMock();
  await buildDataGridContextFilterCondition({
    databaseType: "postgres",
    columnName: "id",
    mode: "in",
    value: null,
    values: [1, 2, null],
  });
  assert.deepEqual(lastContextFilterOptions, {
    databaseType: "postgres",
    columnName: "id",
    mode: "in",
    value: null,
    values: [1, 2, null],
  });

  await buildDataGridContextFilterCondition({
    databaseType: "sqlserver",
    columnName: "created_at",
    mode: "not-between",
    value: 10,
    endValue: 20,
  });
  assert.deepEqual(lastContextFilterOptions, {
    databaseType: "sqlserver",
    columnName: "created_at",
    mode: "not-between",
    value: 10,
    endValue: 20,
  });
});

test("passes the connection identifier quote to Kingbase filters", async () => {
  installFilterFetchMock();
  await buildDataGridContextFilterCondition({
    databaseType: "kingbase",
    identifierQuote: "`",
    columnName: "file_name",
    mode: "equals",
    value: "34-B-0048",
  });

  assert.deepEqual(lastContextFilterOptions, {
    databaseType: "kingbase",
    identifierQuote: "`",
    columnName: "file_name",
    mode: "equals",
    value: "34-B-0048",
  });
});
