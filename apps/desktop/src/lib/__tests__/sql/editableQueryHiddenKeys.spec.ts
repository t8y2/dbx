import { describe, expect, it } from "vitest";
import { buildQueryWithHiddenPrimaryKeys, hiddenResultColumnIndexes } from "@/lib/sql/editableQueryHiddenKeys";
import { analyzeEditableQueryEditability, sourceColumnsForResult } from "@/lib/sql/sqlAnalysis";

describe("editable query hidden primary keys", () => {
  it("appends quoted MySQL primary keys without changing the visible projection", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT name FROM users WHERE active = 1",
        databaseType: "mysql",
        primaryKeys: ["id"],
        existingResultNames: ["name"],
      }),
    ).toEqual({
      sql: "SELECT name, `id` AS `__DBX_PK_0` FROM users WHERE active = 1",
      projections: [{ sourceName: "id", alias: "__DBX_PK_0" }],
    });
  });

  it("supports PostgreSQL composite primary keys and avoids alias collisions", () => {
    const result = buildQueryWithHiddenPrimaryKeys({
      sql: 'SELECT "value"\nFROM "items"',
      databaseType: "postgres",
      primaryKeys: ["tenant_id", "item_id"],
      existingResultNames: ["value", "__DBX_PK_0"],
    });

    expect(result?.sql).toBe('SELECT "value", "tenant_id" AS "__DBX_PK_1", "item_id" AS "__DBX_PK_2"\nFROM "items"');
    expect(result?.projections.map((projection) => projection.alias)).toEqual(["__DBX_PK_1", "__DBX_PK_2"]);
  });

  it("preserves SQL Server TOP and Oracle optimizer hints", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT TOP 10 name FROM dbo.users ORDER BY name",
        databaseType: "sqlserver",
        primaryKeys: ["id"],
        existingResultNames: ["name"],
      })?.sql,
    ).toBe("SELECT TOP 10 name, [id] AS [__DBX_PK_0] FROM dbo.users ORDER BY name");

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT /*+ INDEX(t IDX_USERS_NAME) */ t.NAME\nFROM USERS t",
        databaseType: "oracle",
        primaryKeys: ["ID"],
        existingResultNames: ["NAME"],
      })?.sql,
    ).toBe('SELECT /*+ INDEX(t IDX_USERS_NAME) */ t.NAME, "ID" AS "__DBX_PK_0"\nFROM USERS t');
  });

  it("supports an Oracle ROWID expression for keyless base tables", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT * FROM APP.USERS t WHERE t.ACTIVE = 1",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "NAME"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      }),
    ).toEqual({
      sql: 'SELECT t.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.USERS t WHERE t.ACTIVE = 1',
      projections: [{ sourceName: "__DBX_ROWID", alias: "__DBX_PK_0" }],
    });
  });

  it("preserves an Oracle FOR UPDATE clause when appending a hidden row key", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT * FROM APP.USERS FOR UPDATE SKIP LOCKED",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "NAME"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe('SELECT USERS.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.USERS FOR UPDATE SKIP LOCKED');
  });

  it("qualifies a bare Oracle wildcard when appending a hidden key", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: 'SELECT /*+ FULL("Users") */ * FROM APP."Users"',
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "NAME"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe('SELECT /*+ FULL("Users") */ "Users".*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP."Users"');

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: 'SELECT * FROM APP.USERS "u"',
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "NAME"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe('SELECT "u".*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.USERS "u"');
  });

  it("rewrites the reported Oracle queries without changing their filters", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "select * from t_zyys_vte_yyfxbd",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "MBMC"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe('select t_zyys_vte_yyfxbd.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" from t_zyys_vte_yyfxbd');

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT * from T_XT_MB WHERE   mbmc ='结束时'",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "MBMC"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe(`SELECT T_XT_MB.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" from T_XT_MB WHERE   mbmc ='结束时'`);
  });

  it("preserves a WHERE subquery when adding an Oracle ROWID", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT t.* FROM APP.PLATFORM_CARS t WHERE t.CUSTOMER_NO IN (SELECT c.CUSTOMER_NO FROM APP.CUSTOMERS c WHERE c.ENABLED = 1)",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "CUSTOMER_NO"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      })?.sql,
    ).toBe('SELECT t.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.PLATFORM_CARS t WHERE t.CUSTOMER_NO IN (SELECT c.CUSTOMER_NO FROM APP.CUSTOMERS c WHERE c.ENABLED = 1)');
  });

  it("inserts hidden keys before a trailing line comment", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT name -- visible user name\nFROM users",
        databaseType: "mysql",
        primaryKeys: ["id"],
        existingResultNames: ["name"],
      })?.sql,
    ).toBe("SELECT name, `id` AS `__DBX_PK_0` -- visible user name\nFROM users");
  });

  it("analyzes SQL Server TOP projections as ordinary source columns", () => {
    for (const sql of [
      "SELECT TOP 2 name, note FROM dbo.users ORDER BY name",
      "SELECT TOP(2) name, note FROM dbo.users ORDER BY name",
      "SELECT TOP (2) name, note FROM dbo.users ORDER BY name",
      "SELECT TOP 10 PERCENT name, note FROM dbo.users ORDER BY name",
      "SELECT TOP (2) WITH TIES name, note FROM dbo.users ORDER BY name",
    ]) {
      const result = analyzeEditableQueryEditability(sql);
      expect(result.editable, sql).toBe(true);
      if (result.editable) expect(result.analysis.columns.map((column) => column.sourceName)).toEqual(["name", "note"]);
    }
  });

  it("maps MySQL JSON expressions with implicit aliases without making them writeable", () => {
    const result = analyzeEditableQueryEditability("select id, status, extra->>'$.mode' mode, extra->>'$.template' tmpl from jobs");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(result.analysis.columns).toEqual([
      expect.objectContaining({ sourceName: "id", resultName: "id", expression: "id" }),
      expect.objectContaining({ sourceName: "status", resultName: "status", expression: "status" }),
      expect.objectContaining({ sourceName: undefined, resultName: "mode", expression: "extra->>'$.mode'" }),
      expect.objectContaining({ sourceName: undefined, resultName: "tmpl", expression: "extra->>'$.template'" }),
    ]);
    expect(sourceColumnsForResult(result.analysis, ["id", "status", "mode", "tmpl"])).toEqual(["id", "status", undefined, undefined]);
  });

  it("uses MySQL expression text as the result label when no alias is present", () => {
    const result = analyzeEditableQueryEditability("select id, status, extra->>'$.mode', extra->>'$.template' from jobs");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(sourceColumnsForResult(result.analysis, ["id", "status", "extra->>'$.mode'", "extra->>'$.template'"])).toEqual(["id", "status", undefined, undefined]);
  });

  it("preserves direct columns and explicit aliases while keeping computed projections read-only", () => {
    const result = analyzeEditableQueryEditability("select id, status as state, lower(name) normalized, count_value + 1 from jobs");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(sourceColumnsForResult(result.analysis, ["id", "state", "normalized", "count_value + 1"])).toEqual(["id", "status", undefined, undefined]);
  });

  it("does not mistake the right operand of an unaliased expression for an alias", () => {
    const result = analyzeEditableQueryEditability("select id, id + status, lower(status) from jobs");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(sourceColumnsForResult(result.analysis, ["id", "id + status", "lower(status)"])).toEqual(["id", undefined, undefined]);
  });

  it("keeps aggregate, join-star, and set-operation boundaries read-only", () => {
    expect(analyzeEditableQueryEditability("select id, count(*) total from jobs group by id")).toEqual({ editable: false, reason: "aggregation" });
    expect(analyzeEditableQueryEditability("select * from jobs j join users u on u.id = j.user_id")).toEqual({ editable: false, reason: "complex-source" });
    expect(analyzeEditableQueryEditability("select id from jobs union select id from archived_jobs")).toEqual({ editable: false, reason: "set-operation" });
  });

  it("resolves appended aliases to result indexes", () => {
    expect(
      hiddenResultColumnIndexes(
        ["name", "__DBX_PK_0", "__DBX_PK_1"],
        [
          { sourceName: "tenant_id", alias: "__DBX_PK_0" },
          { sourceName: "item_id", alias: "__DBX_PK_1" },
        ],
      ),
    ).toEqual([1, 2]);
    expect(hiddenResultColumnIndexes(["name"], [{ sourceName: "id", alias: "__DBX_PK_0" }])).toEqual([]);
    expect(
      hiddenResultColumnIndexes(
        ["name", "__DBX_PK_1"],
        [
          { sourceName: "tenant_id", alias: "__DBX_PK_0" },
          { sourceName: "item_id", alias: "__DBX_PK_1" },
        ],
      ),
    ).toEqual([1]);
  });
});
