import { strict as assert } from "node:assert";
import { test } from "vitest";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, analyzeEditableQuery, analyzeEditableQueryEditability, isBinaryType, queryEditabilityMessageKey, resolveMetadataColumnName, sourceColumnsForResult } from "../../apps/desktop/src/lib/sql/sqlAnalysis.ts";

test("recognizes a simple single-table SELECT as editable", () => {
  const result = analyzeEditableQueryEditability("select id, name from public.users where active = true order by id");

  assert.equal(result.editable, true);
  assert.equal(result.analysis.schema, "public");
  assert.equal(result.analysis.tableName, "users");
  assert.equal(result.analysis.selectStar, false);
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "id", sourceNameQuoted: false, resultName: "id", expression: "id" },
    { sourceName: "name", sourceNameQuoted: false, resultName: "name", expression: "name" },
  ]);
});

test("recognizes quoted table names and table aliases", () => {
  const result = analyzeEditableQueryEditability('SELECT u."id", u."full name" FROM "app schema"."user table" AS u');

  assert.equal(result.editable, true);
  assert.equal(result.analysis.schema, "app schema");
  assert.equal(result.analysis.tableName, "user table");
  assert.equal(result.analysis.tableAlias, "u");
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "id", sourceNameQuoted: true, sourceQualifier: "u", sourceKey: "u:0", resultName: "id", expression: 'u."id"' },
    { sourceName: "full name", sourceNameQuoted: true, sourceQualifier: "u", sourceKey: "u:0", resultName: "full name", expression: 'u."full name"' },
  ]);
});

test("keeps the legacy analyzer API for editable SELECT queries", () => {
  const analysis = analyzeEditableQuery("select * from users");
  assert.ok(analysis);
  assert.equal(analysis.tableName, "users");
  assert.equal(analysis.selectStar, true);
  assert.deepEqual(analysis.columns, []);
});

test("recognizes Oracle FOR UPDATE variants without treating FOR as an alias", () => {
  for (const sql of [
    "SELECT * FROM employees FOR UPDATE",
    "SELECT * FROM employees FOR UPDATE NOWAIT",
    "SELECT * FROM employees FOR UPDATE SKIP LOCKED",
    "SELECT * FROM employees FOR UPDATE OF salary, department_id WAIT 5",
    "SELECT * FROM employees WHERE department_id = 10 ORDER BY employee_id FOR UPDATE OF salary NOWAIT",
  ]) {
    const result = analyzeEditableQueryEditability(sql);

    assert.equal(result.editable, true, sql);
    assert.equal(result.analysis.tableName, "employees", sql);
    assert.equal(result.analysis.tableAlias, undefined, sql);
    assert.equal(result.analysis.selectStar, true, sql);
  }

  const aliased = analyzeEditableQueryEditability("SELECT e.employee_id, e.salary FROM employees e FOR UPDATE OF e.salary SKIP LOCKED");
  assert.equal(aliased.editable, true);
  assert.equal(aliased.analysis.tableAlias, "e");
});

test("keeps explicit read-only and output FOR clauses non-editable", () => {
  for (const sql of ["SELECT * FROM employees FOR READ ONLY", "SELECT * FROM employees FOR FETCH ONLY", "SELECT * FROM employees FOR JSON"]) {
    const result = analyzeEditableQueryEditability(sql);

    assert.equal(result.editable, false, sql);
    assert.equal(result.reason, "complex-source", sql);
  }
});

test("recognizes PostgreSQL row-lock FOR variants", () => {
  for (const sql of ["SELECT * FROM jobs FOR SHARE", "SELECT * FROM jobs FOR NO KEY UPDATE SKIP LOCKED", "SELECT * FROM jobs FOR KEY SHARE NOWAIT"]) {
    const result = analyzeEditableQueryEditability(sql);

    assert.equal(result.editable, true, sql);
    assert.equal(result.analysis.tableName, "jobs", sql);
    assert.equal(result.analysis.tableAlias, undefined, sql);
  }
});

test("maps joined query source columns for column-level editing", () => {
  const result = analyzeEditableQueryEditability("select u.id as user_id, u.name, o.total from users u join orders o on o.user_id = u.id");

  assert.equal(result.editable, true);
  assert.equal(result.analysis.multiSource, true);
  assert.equal(result.analysis.allowInsertDelete, false);
  assert.deepEqual(
    result.analysis.sources?.map((source) => ({ key: source.key, tableName: source.tableName, alias: source.alias })),
    [
      { key: "u:0", tableName: "users", alias: "u" },
      { key: "o:1", tableName: "orders", alias: "o" },
    ],
  );
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "id", sourceNameQuoted: false, sourceQualifier: "u", sourceKey: "u:0", resultName: "user_id", expression: "u.id" },
    { sourceName: "name", sourceNameQuoted: false, sourceQualifier: "u", sourceKey: "u:0", resultName: "name", expression: "u.name" },
    { sourceName: "total", sourceNameQuoted: false, sourceQualifier: "o", sourceKey: "o:1", resultName: "total", expression: "o.total" },
  ]);
  assert.equal(allPrimaryKeysPresent(["id"], ["user_id", "name", "total"], result.analysis, "u:0"), true);
  assert.deepEqual(sourceColumnsForResult(result.analysis, ["user_id", "name", "total"], "u:0"), ["id", "name", undefined]);
});

test("recognizes single-table explicit columns mixed with alias star", () => {
  const result = analyzeEditableQueryEditability("select t.create_date, t.* from tt_kd_material_container_sap t where t.order_no = 'KD2607071336' order by t.create_date desc");

  assert.equal(result.editable, true);
  assert.equal(result.analysis.tableName, "tt_kd_material_container_sap");
  assert.equal(result.analysis.tableAlias, "t");
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "create_date", sourceNameQuoted: false, sourceQualifier: "t", sourceKey: "t:0", resultName: "create_date", expression: "t.create_date" },
    { star: true, sourceQualifier: "t", sourceKey: "t:0", resultName: "*", expression: "t.*" },
  ]);
});

test("treats DISTINCT single-table projections as update-only", () => {
  const result = analyzeEditableQueryEditability("select distinct id, name from users");

  assert.equal(result.editable, true);
  assert.equal(result.analysis.distinct, true);
  assert.equal(result.analysis.allowInsertDelete, false);
  assert.deepEqual(result.analysis.columns, [
    { sourceName: "id", sourceNameQuoted: false, resultName: "id", expression: "id" },
    { sourceName: "name", sourceNameQuoted: false, resultName: "name", expression: "name" },
  ]);
});

test("maps a DISTINCT qualified star to one joined source", () => {
  const result = analyzeEditableQueryEditability("select distinct u.* from users u left join orders o on o.user_id = u.id");

  assert.equal(result.editable, true);
  assert.equal(result.analysis.distinct, true);
  assert.equal(result.analysis.multiSource, true);
  assert.equal(result.analysis.allowInsertDelete, false);
  assert.deepEqual(result.analysis.columns, [{ star: true, sourceQualifier: "u", sourceKey: "u:0", resultName: "*", expression: "u.*" }]);
});

test("keeps ambiguous DISTINCT projections read-only", () => {
  assert.deepEqual(analyzeEditableQueryEditability("select distinct * from users u join orders o on o.user_id = u.id"), {
    editable: false,
    reason: "complex-source",
  });
  assert.deepEqual(analyzeEditableQueryEditability("select distinct on (user_id) id, user_id from orders order by user_id, id desc"), {
    editable: false,
    reason: "aggregation",
  });
});

test("reports DuckDB external file scans as read-only external sources", () => {
  const result = analyzeEditableQueryEditability("SELECT * FROM '/tmp/duckdb_excel_extension_test.xlsx'");

  assert.deepEqual(result, {
    editable: false,
    reason: "external-source",
  });
  assert.equal(queryEditabilityMessageKey(result.reason), "grid.queryEditUnsupported.external-source");
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

test("resolves metadata columns with dialect and quote aware identifier rules", () => {
  const postgresColumns = ["id", "ID", "name"];
  assert.equal(resolveMetadataColumnName("postgres", "ID", false, postgresColumns), "id");
  assert.equal(resolveMetadataColumnName("postgres", "ID", true, postgresColumns), "ID");
  assert.equal(resolveMetadataColumnName("postgres", "ID", undefined, postgresColumns), "ID");
  assert.equal(resolveMetadataColumnName("postgres", "Id", true, postgresColumns), undefined);

  assert.equal(resolveMetadataColumnName("kingbase", "ckg023", false, ["CKG023", "CKG096"]), "CKG023");
  assert.equal(resolveMetadataColumnName("kingbase", "ckg023", false, ["CKG023", "Ckg023"]), undefined);
  assert.equal(resolveMetadataColumnName("kingbase", "ckg023", true, ["CKG023"]), undefined);
});

test("requires canonical primary key names instead of case-only matches", () => {
  const lowerId = analyzeEditableQuery("select id, name from case_keys");
  const quotedId = analyzeEditableQuery('select "ID", name from case_keys');

  assert.ok(lowerId);
  assert.ok(quotedId);
  assert.equal(allPrimaryKeysPresent(["ID"], ["id", "name"], lowerId), false);
  assert.equal(allPrimaryKeysPresent(["ID"], ["ID", "name"], quotedId), true);
});

test("rejects ambiguous case-only result column mapping", () => {
  const analysis = analyzeEditableQuery('select id as id, "ID" as "ID" from case_keys');

  assert.ok(analysis);
  assert.equal(sourceColumnsForResult(analysis, ["Id"]), undefined);
});

test("maps ClickHouse simple query results when identifier columns are returned", () => {
  const analysis = analyzeEditableQuery("SELECT id, name, score + 1 AS next_score FROM default.people");

  assert.ok(analysis);
  assert.equal(allPrimaryKeysPresent(["id"], ["id", "name", "next_score"], analysis), true);
  assert.equal(allEditableColumnsWriteable(analysis, ["id", "name", "next_score"]), true);
  assert.deepEqual(sourceColumnsForResult(analysis, ["id", "name", "next_score"]), ["id", "name", undefined]);
});

test("rejects ClickHouse query result editing when identifier source columns are omitted", () => {
  const analysis = analyzeEditableQuery("SELECT name FROM default.people");

  assert.ok(analysis);
  assert.equal(allPrimaryKeysPresent(["id"], ["name"], analysis), false);
  assert.deepEqual(sourceColumnsForResult(analysis, ["name"]), ["name"]);
});

test("recognizes binary type declarations with lengths", () => {
  assert.equal(isBinaryType("binary(16)"), true);
  assert.equal(isBinaryType("VARBINARY(255)"), true);
  assert.equal(isBinaryType("varchar(255)"), false);
});
