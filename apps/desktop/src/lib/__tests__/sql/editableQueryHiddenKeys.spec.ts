import { describe, expect, it } from "vitest";
import { buildQueryWithHiddenPrimaryKeys, hiddenResultColumnIndexes } from "@/lib/sql/editableQueryHiddenKeys";
import { analyzeEditableQueryEditability, allPrimaryKeysPresent, sourceColumnsForResult, type EditableQueryInfo } from "@/lib/sql/sqlAnalysis";

describe("editable query hidden primary keys", () => {
  it.each([
    "APP.ITEMS PIVOT(SUM(AMOUNT) FOR KIND IN (1,2))",
    "APP.ITEMS t PIVOT(SUM(AMOUNT) FOR KIND IN (1,2))",
    "APP.ITEMS UNPIVOT(AMOUNT FOR KIND IN (FIRST_AMOUNT,SECOND_AMOUNT))",
    "APP.ITEMS UNPIVOT INCLUDE NULLS (AMOUNT FOR KIND IN (FIRST_AMOUNT,SECOND_AMOUNT))",
    "APP.ITEMS t UNKNOWN_SUFFIX(1)",
  ])("rejects an unparsed source suffix: %s", (source) => {
    for (const projection of ["*", "t.*", "AMOUNT", "ROWID AS RID, AMOUNT"]) {
      const sql = `SELECT ${projection} FROM ${source}`;
      expect(analyzeEditableQueryEditability(sql)).toEqual({ editable: false, reason: "complex-source" });
      expect(buildQueryWithHiddenPrimaryKeys({ sql, databaseType: "oceanbase-oracle", primaryKeys: ["__DBX_ROWID"], existingResultNames: ["AMOUNT"], sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" } })).toBeUndefined();
    }
  });

  it.each(['"PIVOT"', '"UNPIVOT"', '"PARTITION"'])("preserves a quoted keyword alias %s", (alias) => {
    const sql = `SELECT * FROM APP.ITEMS ${alias}`;
    expect(analyzeEditableQueryEditability(sql).editable).toBe(true);
    expect(buildQueryWithHiddenPrimaryKeys({ sql, databaseType: "oceanbase-oracle", primaryKeys: ["__DBX_ROWID"], existingResultNames: ["AMOUNT"], sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" } })?.sql).toBe(`SELECT ${alias}.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_0" FROM APP.ITEMS ${alias}`);
  });

  it("preserves SQL Server table hints in the parsed source shape", () => {
    for (const source of ["dbo.items WITH (NOLOCK)", "dbo.items t WITH (INDEX (idx_items), NOLOCK)"]) {
      const sql = `SELECT amount FROM ${source} WHERE amount > 0`;
      expect(analyzeEditableQueryEditability(sql).editable).toBe(true);
      expect(buildQueryWithHiddenPrimaryKeys({ sql, databaseType: "sqlserver", primaryKeys: ["id"], existingResultNames: ["amount"] })?.sql).toContain("[id] AS [__DBX_PK_0]");
    }
  });

  it.each(["FROM dbo.items t WITH (NOLOCK) JOIN dbo.owners o WITH (NOLOCK) ON t.owner_id = o.id", "FROM dbo.items t LEFT JOIN dbo.owners o ON t.owner_id = o.id", "FROM dbo.items t CROSS JOIN dbo.owners o", 'FROM "APP"."Items" "t" JOIN "APP"."Owners" "o" ON "t"."OWNER_ID" = "o"."ID"'])(
    "retains direct joined-source mappings: %s",
    (from) => {
      const result = analyzeEditableQueryEditability(`SELECT t.amount, o.id ${from}`);
      expect(result.editable).toBe(true);
      if (result.editable) expect(result.analysis.sources).toHaveLength(2);
    },
  );

  it.each(["PARTITION(P0)", "SUBPARTITION(P0)", "PARTITION FOR (1)"])("does not treat the Oracle table suffix %s as an alias", (suffix) => {
    expect(buildQueryWithHiddenPrimaryKeys({ sql: `SELECT * FROM APP.ITEMS ${suffix}`, databaseType: "oceanbase-oracle", primaryKeys: ["__DBX_ROWID"], existingResultNames: ["LABEL"], sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" } })).toBeUndefined();
  });
  it.each(["oracle", "oceanbase-oracle"] as const)("preserves source spelling and projection boundaries for %s star queries", (databaseType) => {
    for (const [sql, expected] of [
      ['SELECT * FROM "Owner"."Items" "i"', 'SELECT "i".*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_1" FROM "Owner"."Items" "i"'],
      ['SELECT "i".* FROM "Owner"."Items" "i"', 'SELECT "i".*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_1" FROM "Owner"."Items" "i"'],
      ["SELECT /*+ FULL(t) */ * -- columns\nFROM APP.ITEMS t", 'SELECT /*+ FULL(t) */ t.*, ROWIDTOCHAR(ROWID) AS "__DBX_PK_1" -- columns\nFROM APP.ITEMS t'],
    ]) {
      const result = buildQueryWithHiddenPrimaryKeys({ sql: sql!, databaseType, primaryKeys: ["__DBX_ROWID"], existingResultNames: ["rowid", "__DBX_PK_0"], sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" } });
      expect(result?.sql).toBe(expected);
      expect(result?.projections).toEqual([{ sourceName: "__DBX_ROWID", alias: "__DBX_PK_1" }]);
    }
  });

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

  it("quotes the appended key with each reported engine's own dialect", () => {
    // #10233 reports OceanBase (Oracle mode), Dameng and HighGo. All three draw their
    // quoting from the dialect adapter rather than a hard-coded quote character:
    // Dameng/OceanBase Oracle mode ride the Oracle adapter, HighGo the PostgreSQL one.
    for (const databaseType of ["dameng", "oceanbase-oracle", "highgo"] as const) {
      expect(
        buildQueryWithHiddenPrimaryKeys({
          sql: "SELECT name FROM users",
          databaseType,
          primaryKeys: ["id"],
          existingResultNames: ["name"],
        }),
      ).toEqual({
        sql: 'SELECT name, "id" AS "__DBX_PK_0" FROM users',
        projections: [{ sourceName: "id", alias: "__DBX_PK_0" }],
      });
    }
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

  it("supports Xugu's unqualified ROWID expression for keyless base tables", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT * FROM APP.USERS t WHERE t.ACTIVE = 1",
        databaseType: "xugu",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["ID", "NAME"],
        sourceExpressions: { __DBX_ROWID: "ROWID" },
      }),
    ).toEqual({
      sql: 'SELECT *, ROWID AS "__DBX_PK_0" FROM APP.USERS t WHERE t.ACTIVE = 1',
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

  it("rejects queries with GROUP BY, HAVING, or set operations", () => {
    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT department, COUNT(*) AS total FROM users GROUP BY department",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["department", "total"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      }),
    ).toBeUndefined();

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT department FROM users HAVING COUNT(*) > 1",
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["department"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      }),
    ).toBeUndefined();

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: `SELECT 
  R.P_ID, 
  R.SUBJECT, 
  COUNT(0) AS CNT_NUM
  FROM COMMON.RECORD R
 WHERE R.CREATE_TIME >= SYSDATE - INTERVAL '1' DAY
   AND R.SUBJECT = '邮件提醒'
   AND R.P_ID = '123214512'
 GROUP BY R.P_ID, R.SUBJECT`,
        databaseType: "oracle",
        primaryKeys: ["__DBX_ROWID"],
        existingResultNames: ["P_ID", "SUBJECT", "CNT_NUM"],
        sourceExpressions: { __DBX_ROWID: "ROWIDTOCHAR(ROWID)" },
      }),
    ).toBeUndefined();

    expect(
      buildQueryWithHiddenPrimaryKeys({
        sql: "SELECT id, name FROM users UNION SELECT id, name FROM archived_users",
        databaseType: "mysql",
        primaryKeys: ["id"],
        existingResultNames: ["id", "name"],
      }),
    ).toBeUndefined();
  });

  it.each([
    "SELECT name FROM users /* GROUP BY name HAVING COUNT(*) > 1 */",
    "SELECT name FROM users -- GROUP BY name",
    "SELECT name, 'GROUP BY name HAVING COUNT(*)' AS note FROM users",
    'SELECT "GROUP", "HAVING", name FROM users',
    "SELECT name, (SELECT COUNT(*) FROM orders GROUP BY user_id) AS total FROM users",
  ])("appends hidden keys when grouping text is outside the outer query: %s", (sql) => {
    const result = buildQueryWithHiddenPrimaryKeys({ sql, databaseType: "oracle", primaryKeys: ["id"], existingResultNames: ["name", "note", "total"] });
    expect(result?.sql).toContain('"id" AS "__DBX_PK_0"');
    expect(result?.projections).toEqual([{ sourceName: "id", alias: "__DBX_PK_0" }]);
  });

  it.each(["UNION", "UNION ALL", "INTERSECT", "EXCEPT", "MINUS"])("does not append hidden keys across %s", (operation) => {
    expect(buildQueryWithHiddenPrimaryKeys({ sql: `SELECT name FROM users ${operation} SELECT name FROM archived_users`, databaseType: "oracle", primaryKeys: ["id"], existingResultNames: ["name"] })).toBeUndefined();
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

  it("keeps Oracle NUM columns and aliases mapped when result labels disagree", () => {
    const named = analyzeEditableQueryEditability("select id, num from users");
    expect(named.editable).toBe(true);
    if (!named.editable) return;
    expect(sourceColumnsForResult(named.analysis, ["ID", "NUM"], undefined, "oracle")).toEqual(["id", "num"]);
    expect(sourceColumnsForResult(named.analysis, ["ID", "ROWNUM"], undefined, "oracle")).toEqual(["id", undefined]);

    const aliased = analyzeEditableQueryEditability("select id, amount as num from users");
    expect(aliased.editable).toBe(true);
    if (!aliased.editable) return;
    expect(sourceColumnsForResult(aliased.analysis, ["ID", "AMOUNT"], undefined, "oracle")).toEqual(["id", "amount"]);
    expect(sourceColumnsForResult(aliased.analysis, ["ID", "NUM", "ROWNUM"], undefined, "oracle")).toEqual(["id", "amount", undefined]);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("maps a qualified %s ROWID projection to the synthetic row key", (databaseType) => {
    const analysis: EditableQueryInfo = {
      schema: "APP",
      tableName: "USERS",
      selectStar: false,
      columns: [
        { sourceName: "ROWID", sourceQualifier: "t", sourceKey: "t:0", resultName: "ROWID", expression: "t.ROWID" },
        { sourceName: "NAME", sourceQualifier: "t", sourceKey: "t:0", resultName: "NAME", expression: "t.NAME" },
        { sourceName: "LABEL", sourceQualifier: "o", sourceKey: "o:1", resultName: "LABEL", expression: "o.LABEL" },
      ],
    };

    expect(allPrimaryKeysPresent(["__DBX_ROWID"], ["ROWID", "NAME", "LABEL"], analysis, "t:0", databaseType)).toBe(true);
    expect(sourceColumnsForResult(analysis, ["ROWID", "NAME", "LABEL"], "t:0", databaseType, ["__DBX_ROWID"])).toEqual(["__DBX_ROWID", "NAME", undefined]);
    expect(allPrimaryKeysPresent(["__DBX_ROWID"], ["ROWID", "NAME", "LABEL"], analysis, "o:1", databaseType)).toBe(false);
  });

  it("does not assign an unqualified multi-source ROWID to a target table", () => {
    const analysis: EditableQueryInfo = {
      schema: "APP",
      tableName: "USERS",
      selectStar: false,
      columns: [{ sourceName: "ROWID", resultName: "ROWID", expression: "ROWID" }],
    };

    expect(allPrimaryKeysPresent(["__DBX_ROWID"], ["ROWID"], analysis, "t:0", "oracle")).toBe(false);
    expect(sourceColumnsForResult(analysis, ["ROWID"], "t:0", "oracle", ["__DBX_ROWID"])).toEqual([undefined]);
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
