import { strict as assert } from "node:assert";
import { test } from "vitest";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, analyzeEditableQuery, analyzeEditableQueryEditability, isBinaryType, queryEditabilityMessageKey } from "../../apps/desktop/src/lib/sqlAnalysis.ts";

test("recognizes a simple single-table SELECT as editable", () => {
  const result = analyzeEditableQueryEditability("select id, name from public.users where active = true order by id");

  assert.equal(result.editable, true);
  assert.deepEqual(result.analysis, {
    schema: "public",
    schemaQuoted: false,
    tableName: "users",
    tableNameQuoted: false,
    tableAlias: undefined,
    selectStar: false,
    columns: [
      { sourceName: "id", sourceNameQuoted: false, resultName: "id", expression: "id" },
      { sourceName: "name", sourceNameQuoted: false, resultName: "name", expression: "name" },
    ],
  });
});

test("recognizes quoted table names and table aliases", () => {
  const result = analyzeEditableQueryEditability('SELECT u."id", u."full name" FROM "app schema"."user table" AS u');

  assert.equal(result.editable, true);
  assert.deepEqual(result.analysis, {
    schema: "app schema",
    schemaQuoted: true,
    tableName: "user table",
    tableNameQuoted: true,
    tableAlias: "u",
    selectStar: false,
    columns: [
      { sourceName: "id", sourceNameQuoted: true, resultName: "id", expression: 'u."id"' },
      { sourceName: "full name", sourceNameQuoted: true, resultName: "full name", expression: 'u."full name"' },
    ],
  });
});

test("keeps the legacy analyzer API for editable SELECT queries", () => {
  assert.deepEqual(analyzeEditableQuery("select * from users"), {
    schema: undefined,
    schemaQuoted: false,
    tableName: "users",
    tableNameQuoted: false,
    tableAlias: undefined,
    selectStar: true,
    columns: [],
  });
});

test("reports why joined query results are not editable", () => {
  const result = analyzeEditableQueryEditability("select u.id, o.total from users u join orders o on o.user_id = u.id");

  assert.deepEqual(result, {
    editable: false,
    reason: "complex-source",
  });
  assert.equal(queryEditabilityMessageKey(result.reason), "grid.queryEditUnsupportedComplexSource");
});

test("reports DuckDB external file scans as read-only external sources", () => {
  const result = analyzeEditableQueryEditability("SELECT * FROM '/tmp/duckdb_excel_extension_test.xlsx'");

  assert.deepEqual(result, {
    editable: false,
    reason: "external-source",
  });
  assert.equal(queryEditabilityMessageKey(result.reason), "grid.queryEditUnsupportedExternalSource");
});

test("reports computed result columns as unsafe to edit", () => {
  const result = analyzeEditableQueryEditability("select id, count(*) as total from users group by id");

  assert.deepEqual(result, {
    editable: false,
    reason: "aggregation",
  });
});

test("keeps single-table expression columns while mapping writable source columns", () => {
  const result = analyzeEditableQueryEditability("select iso3, year, country_name, ihli / gdp_pc as score from ihli_data");

  assert.equal(result.editable, true);
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "iso3", sourceNameQuoted: false, resultName: "iso3", expression: "iso3" },
    { sourceName: "year", sourceNameQuoted: false, resultName: "year", expression: "year" },
    { sourceName: "country_name", sourceNameQuoted: false, resultName: "country_name", expression: "country_name" },
    { sourceName: undefined, sourceNameQuoted: false, resultName: "score", expression: "ihli / gdp_pc" },
  ]);
  assert.equal(allPrimaryKeysPresent(["iso3", "year"], ["iso3", "year", "country_name", "score"], result.analysis), true);
  assert.equal(allEditableColumnsWriteable(result.analysis, ["iso3", "year", "country_name", "score"]), true);
});

test("accepts aliased primary key source columns for row identity", () => {
  const analysis = analyzeEditableQuery("select id as user_id, name from users");

  assert.ok(analysis);
  assert.equal(allPrimaryKeysPresent(["id"], ["user_id", "name"], analysis), true);
  assert.equal(allEditableColumnsWriteable(analysis, ["user_id", "name"]), true);
  assert.equal(allPrimaryKeysPresent(["id"], ["id", "name"], analyzeEditableQuery("select id, name from users")!), true);
});

test("recognizes binary type declarations with lengths", () => {
  assert.equal(isBinaryType("binary(16)"), true);
  assert.equal(isBinaryType("VARBINARY(255)"), true);
  assert.equal(isBinaryType("varchar(255)"), false);
});
