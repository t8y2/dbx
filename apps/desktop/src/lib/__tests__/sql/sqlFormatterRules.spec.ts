import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlText } from "@/lib/sql/sqlFormatter";
import { normalizeSqlFormatterSettings, parseSqlFormatterConfig, serializeSqlFormatterConfig, type SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

const rules = (overrides: Partial<SqlFormatterSettings> = {}): Partial<SqlFormatterSettings> => ({ customRulesEnabled: true, ...overrides });

describe("configurable SQL formatting rules (issue #8570)", () => {
  it("keeps custom rules disabled when loading existing settings", () => {
    expect(normalizeSqlFormatterSettings({ keywordCase: "lower", expressionWidth: 80 })).toMatchObject({
      keywordCase: "lower",
      expressionWidth: 80,
      customRulesEnabled: false,
    });
  });

  it("round-trips independent rules and the reference width through the production config parser", () => {
    const settings = {
      customRulesEnabled: true,
      listLayout: "wrap",
      selectListLayout: "vertical",
      insertListLayout: "singleLine",
      updateListLayout: "fit",
      selectCommaPosition: "before",
      insertCommaPosition: "after",
      updateCommaPosition: "inherit",
      alignSelectAliases: false,
      alignUpdateAssignments: true,
      whereLogicalOperatorNewline: "before",
      onLogicalOperatorNewline: "after",
      expressionLogicalOperatorNewline: "none",
      newlineBeforeJoinOn: true,
      collapseShortStatements: false,
      emptyLineMode: "single",
      listItemAlignment: "indent",
      expressionWidth: 76,
    };
    const parsed = parseSqlFormatterConfig(JSON.stringify({ version: 2, formatter: "sql-formatter", options: settings }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings).toMatchObject(settings);
    expect(parseSqlFormatterConfig(serializeSqlFormatterConfig(parsed.settings))).toEqual(parsed);
  });

  it("can keep a SELECT list on one line independently of INSERT and UPDATE", async () => {
    const result = await formatSqlText("select deptno as department_number, dname as department_name, loc as department_location from dept;", "oracle", rules({ selectListLayout: "singleLine" }));
    expect(result).toContain("SELECT deptno AS department_number, dname AS department_name, loc AS department_location");
  });

  it("can expand INSERT target columns and each VALUES tuple independently", async () => {
    const result = await formatSqlText("insert into dept (deptno,dname,loc) values (10,'Accounting','New York'),(20,'Sales','Boston');", "oracle", rules({ insertListLayout: "vertical" }));
    expect(result).toMatch(/dept\s*\(\s*deptno,\n\s*dname,\n\s*loc\s*\)/i);
    expect(result).toMatch(/\(\s*10,\n\s*'Accounting',\n\s*'New York'\s*\)/);
    expect(result).toMatch(/\(\s*20,\n\s*'Sales',\n\s*'Boston'\s*\)/);
  });

  it("can expand and align UPDATE assignments without collapsing the whole statement", async () => {
    const result = await formatSqlText("update dept set dname='Accounting',loc='New York' where deptno=10;", "oracle", rules({ updateListLayout: "vertical", alignUpdateAssignments: true }));
    expect(result).toMatch(/SET dname = 'Accounting',\n\s*loc\s+= 'New York'/);
  });

  it("combines right-aligned keywords with independent list rules", async () => {
    const result = await formatSqlText("select a,b from dept; insert into dept (a,b) values (1,2);", "oracle", rules({ indentStyle: "tabularRight", selectListLayout: "singleLine", insertListLayout: "vertical" }));
    expect(result).toMatch(/SELECT +a, b/);
    expect(result).toMatch(/\(\s*a,\n\s*b\s*\)/);
  });

  it("gives JOIN ON and WHERE their own logical operator placement", async () => {
    const result = await formatSqlText(
      "select a.id from a join b on a.id=b.id and a.kind=b.kind where a.x=1 and b.y=2;",
      "oracle",
      rules({
        selectListLayout: "singleLine",
        newlineBeforeJoinOn: true,
        onLogicalOperatorNewline: "after",
        whereLogicalOperatorNewline: "before",
      }),
    );
    expect(result).toMatch(/\n\s*ON a\.id = b\.id AND\n\s*a\.kind = b\.kind/);
    expect(result).toMatch(/WHERE a\.x = 1\n\s*AND b\.y = 2/);
  });

  it("restores the original classic layout when custom rules are disabled", async () => {
    const sql = "select a,b from dept where a=1 and b=2;";
    const baseline = await formatSqlText(sql, "oracle", { layoutStyle: "classic" });
    const disabled = await formatSqlText(sql, "oracle", { layoutStyle: "classic", customRulesEnabled: false, selectListLayout: "singleLine", whereLogicalOperatorNewline: "none" });
    expect(disabled).toBe(baseline);
  });

  it.each(["singleLine", "fit", "vertical", "wrap"] as const)("implements the %s list mode rather than just changing the option", async (selectListLayout) => {
    const options = rules({ selectListLayout, expressionWidth: 36, collapseShortStatements: false });
    const result = await formatSqlText("select alpha_col,bravo_col,charlie_col from t;", "oracle", options);
    if (selectListLayout === "singleLine") expect(result).toContain("SELECT alpha_col, bravo_col, charlie_col");
    else if (selectListLayout === "wrap") expect(result).toMatch(/SELECT alpha_col, bravo_col,\n\s*charlie_col/);
    else expect(result).toMatch(/SELECT alpha_col,\n\s*bravo_col,\n\s*charlie_col/);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("honours general list rules recursively in functions, IN and a nested subquery", async () => {
    const options = rules({ listLayout: "vertical", selectListLayout: "singleLine", collapseShortStatements: true });
    const result = await formatSqlText("select coalesce(a,b) as x from t where id in (1,2,3) and k in (select coalesce(c,d) from u);", "oracle", options);
    expect(result).toMatch(/coalesce\(a,\n\s*b\)/i);
    expect(result).toMatch(/IN \(1,\n\s*2,\n\s*3\)/);
    expect(result).toMatch(/coalesce\(c,\n\s*d\)/i);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("does not treat a function inside an INSERT value as another INSERT tuple", async () => {
    const result = await formatSqlText("insert into t (a,b) values (f(1,2),3);", "oracle", rules({ insertListLayout: "vertical", listLayout: "singleLine" }));
    expect(result).toContain("f(1, 2)");
    expect(result).toMatch(/f\(1, 2\),\n\s*3/);
  });

  it("applies expression rules inside CASE without splitting BETWEEN's AND", async () => {
    const options = rules({ selectListLayout: "singleLine", expressionLogicalOperatorNewline: "after", whereLogicalOperatorNewline: "before" });
    const result = await formatSqlText("select case when a=1 and b=2 then coalesce(c,d) else e end as x from t where id between 1 and 2 and k=3;", "oracle", options);
    expect(result).toMatch(/WHEN a = 1 AND\n\s*b = 2 THEN/);
    expect(result).toMatch(/BETWEEN 1 AND 2\n\s*AND k = 3/);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("applies nested list rules inside BETWEEN bounds and composite property access", async () => {
    const options = rules({ listLayout: "vertical", selectListLayout: "singleLine" });
    const result = await formatSqlText("select (get_row(a,b)).value from t where n between coalesce(low_a,low_b) and coalesce(high_a,high_b);", "postgres", options);
    expect(result).toMatch(/get_row\(a,\n\s*b\)/);
    expect(result).toMatch(/coalesce\(low_a,\n\s*low_b\)/);
    expect(result).toMatch(/coalesce\(high_a,\n\s*high_b\)/);
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it("honours nested list rules in LIMIT and set-operation operands", async () => {
    const options = rules({ listLayout: "vertical", selectListLayout: "singleLine", collapseShortStatements: false, indentStyle: "tabularRight" });
    const result = await formatSqlText("select a from t limit coalesce(10,20); select a from t union all values (coalesce(1,2));", "postgres", options);
    expect(result).toMatch(/LIMIT coalesce\(10,\n\s*20\)/i);
    expect(result).toMatch(/coalesce\(1,\n\s*2\)/i);
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it.each(["fit", "wrap"] as const)("keeps nested %s widths independent of the SELECT single-line rule", async (listLayout) => {
    const options = rules({ listLayout, selectListLayout: "singleLine", expressionWidth: 44, collapseShortStatements: false });
    const result = await formatSqlText("select coalesce(alpha_col,bravo_col,charlie_col,delta_col) from t;", "postgres", options);
    if (listLayout === "fit") expect(result).toMatch(/coalesce\(alpha_col,\n\s*bravo_col,\n\s*charlie_col,\n\s*delta_col\)/);
    else expect(result).toMatch(/coalesce\(alpha_col, bravo_col,\n\s*charlie_col, delta_col\)/);
    expect(result.split("\n").every((line) => line.length <= 44)).toBe(true);
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it("keeps single-line function arguments and scalar CASE items allowed to exceed the width", async () => {
    const options = rules({ listLayout: "singleLine", selectListLayout: "singleLine", expressionWidth: 20, collapseShortStatements: false });
    const result = await formatSqlText("select coalesce(alpha_col,bravo_col),case when a=1 then 'a long literal' else 'another long literal' end as label from t;", "postgres", options);
    expect(result).toContain("SELECT coalesce(alpha_col, bravo_col), CASE WHEN a = 1 THEN 'a long literal' ELSE 'another long literal' END AS label");
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it.each(["before", "after"] as const)("keeps SELECT annotations safe with %s commas", async (selectCommaPosition) => {
    const sql = "select a as x, -- first field\n long_name as y, /* next field */\n c as z from t;";
    const options = rules({ selectListLayout: "vertical", selectCommaPosition });
    const result = await formatSqlText(sql, "oracle", options);
    expect(result).toContain("-- first field");
    expect(result).toContain("/* next field */");
    const tokens = (value: string) =>
      tokenizeSqlSemantic(value, "oracle")
        .filter((token) => token.kind !== "comment")
        .map((token) => token.normalized);
    expect(tokens(result)).toEqual(tokens(sql));
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("allows the three DML comma and alignment rules to differ", async () => {
    const options = rules({ selectListLayout: "vertical", selectCommaPosition: "before", updateListLayout: "vertical", updateCommaPosition: "after", alignSelectAliases: false, alignUpdateAssignments: true });
    const result = await formatSqlText("select a as x,long_name as y from t; update t set a=1,long_name=2;", "oracle", options);
    expect(result).toMatch(/SELECT a AS x\n\s*, long_name AS y/);
    expect(result).toMatch(/SET a\s+= 1,\n\s*long_name = 2/);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps inline commas adjacent to their DML items when leading commas are selected", async () => {
    const options = rules({ selectListLayout: "singleLine", insertListLayout: "singleLine", updateListLayout: "singleLine", selectCommaPosition: "before", insertCommaPosition: "before", updateCommaPosition: "before", collapseShortStatements: false });
    const result = await formatSqlText("select a,b from t; insert into t (a,b) values(1,2); update t set a=1,b=2;", "oracle", options);
    expect(result).toContain("SELECT a, b");
    expect(result).toContain("t (a, b)");
    expect(result).toContain("VALUES (1, 2)");
    expect(result).toContain("SET a = 1, b = 2");
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("measures leading commas at the wrap boundary without adding a space before them", async () => {
    const options = rules({ selectListLayout: "wrap", selectCommaPosition: "before", expressionWidth: 20, collapseShortStatements: false });
    const result = await formatSqlText("select aaaaa,bbbbbb,ccc from t;", "oracle", options);
    expect(result).toMatch(/SELECT aaaaa, bbbbbb\n\s*, ccc/);
    expect(result.split("\n").every((line) => line.length <= 20)).toBe(true);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps VALUES set operands on the existing DML list rules", async () => {
    const sql = "select 0 union all values (coalesce(1,2),3),(4,5);";
    const options = rules({ listLayout: "vertical", insertListLayout: "inherit", selectListLayout: "singleLine", commaPosition: "before", collapseShortStatements: false });
    const diagnostics: string[] = [];
    const result = await formatSqlText(sql, "postgres", options, (value) => diagnostics.push(value));
    expect(result).toMatch(/coalesce\(1\n\s*, 2\)\n\s*, 3\)/);
    expect(result).toMatch(/\(4\n\s*, 5\)/);
    expect(tokenizeSqlSemantic(result, "postgres").map((token) => token.normalized)).toEqual(tokenizeSqlSemantic(sql, "postgres").map((token) => token.normalized));
    expect(diagnostics).toEqual([]);
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it.each([
    ["oracle", `select coalesce("a,b", q'[x, AND 'y like z']') as note, :p as p from t where id between 1 and 2 and label='OR'; -- tail`],
    ["mysql", "select coalesce(`a,b`, 'x, AND  y') as note, :p as p from t where id between 1 and 2 and label='OR'; -- tail"],
    ["postgres", `select coalesce("a,b", $tag$x,\n\nAND 'y'$tag$) as note, :p as p from t where id between 1 and 2 and label='OR'; /* tail */`],
    ["sqlserver", "select coalesce([a,b], 'x, AND y') as note, @p as p from t where id between 1 and 2 and label='OR'; -- tail"],
  ] as const)("preserves protected %s tokens and is idempotent", async (dialect, sql) => {
    const options = rules({ listLayout: "vertical", selectCommaPosition: "before", emptyLineMode: "single", expressionWidth: 76 });
    const protectedTokens = (value: string) =>
      tokenizeSqlSemantic(value, dialect)
        .filter((token) => ["comment", "string", "quoted_identifier", "parameter"].includes(token.kind))
        .map((token) => token.text);
    const result = await formatSqlText(sql, dialect, options);
    expect(protectedTokens(result)).toEqual(protectedTokens(sql));
    expect(await formatSqlText(result, dialect, options)).toBe(result);
  });

  it("collapses code-only empty lines without rewriting literal or block-comment paragraphs", async () => {
    const sql = "select 'first\n\n\nlast' as text, a\n\n\n\nfrom t /* first\n\n\nlast */ where id=1;";
    const result = await formatSqlText(sql, "oracle", rules({ emptyLineMode: "single" }));
    expect(result).toContain("'first\n\n\nlast'");
    expect(result).toContain("/* first\n\n\nlast */");
    expect(result.replace("'first\n\n\nlast'", "literal").replace("/* first\n\n\nlast */", "comment")).not.toMatch(/\n(?:[ \t]*\n){2}/);
    expect(result).not.toContain("__DBX_PRESERVE_EMPTY_LINE_");
  });

  it.each(["remove", "single", "preserve"] as const)("keeps alternative quoted literals intact with %s rules", async (emptyLineMode) => {
    const literal = "nQ'{first 'quoted'\r\n\r\n-- AND is data\r\nlast}'";
    const source = `select ${literal} as note, q'!second 'quoted'\nlast!' as other from dual;\n\nselect :id from dual;`;
    const options = rules({ emptyLineMode, selectListLayout: "vertical", preserveEmptyLines: false });
    const result = await formatSqlText(source, "oracle", options);
    expect(result).toContain(literal);
    expect(tokenizeSqlSemantic(result, "oracle").map((token) => token.normalized)).toEqual(tokenizeSqlSemantic(source, "oracle").map((token) => token.normalized));
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps a line comment boundary even when WHERE rules request no logical breaks", async () => {
    const source = "select a,b from t where x=1 -- note\r\nand y=2;";
    const options = rules({ whereLogicalOperatorNewline: "none" });
    const result = await formatSqlText(source, "postgres", options);
    expect(result).toMatch(/-- note\n\s*AND y = 2/);
    expect(tokenizeSqlSemantic(result, "postgres").map((token) => token.normalized)).toEqual(tokenizeSqlSemantic(source, "postgres").map((token) => token.normalized));
    expect(await formatSqlText(result, "postgres", options)).toBe(result);
  });

  it.each(["preserve", "single", "inherit"] as const)("does not mistake quoted or commented marker-like lines for %s empty lines", async (emptyLineMode) => {
    const sql = "select 'first\n-- __DBX_PRESERVE_EMPTY_LINE_0_0__\nlast' as note from t;\n\nselect 2; /* first\n-- __DBX_PRESERVE_EMPTY_LINE_0_0__\nlast */";
    const options = rules({ emptyLineMode, preserveEmptyLines: true });
    const protectedTokens = (value: string) =>
      tokenizeSqlSemantic(value, "oracle")
        .filter((token) => ["string", "comment"].includes(token.kind))
        .map((token) => token.text);
    const result = await formatSqlText(sql, "oracle", options);
    expect(protectedTokens(result)).toEqual(protectedTokens(sql));
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps complete PL/SQL blocks on the established base formatter and reports the fallback", async () => {
    const sql = "begin select a,b into x,y from t; x:=1; end;";
    const base = await formatSqlText(sql, "oracle", { layoutStyle: "classic" });
    const diagnostics: string[] = [];
    const result = await formatSqlText(sql, "oracle", rules({ layoutStyle: "classic" }), (diagnostic) => diagnostics.push(diagnostic));
    expect(result).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });

  it.each(["remove", "single"] as const)("restores saved base spacing when %s rules decline a procedure script", async (emptyLineMode) => {
    const sql = "-- heading\n\nbegin select 1 into x from dual; x:=1; end; select 2 from dual;";
    const saved = { layoutStyle: "classic", preserveEmptyLines: true, linesBetweenQueries: 2 } as const;
    const base = await formatSqlText(sql, "oracle", saved);
    const diagnostics: string[] = [];
    const result = await formatSqlText(sql, "oracle", rules({ ...saved, emptyLineMode }), (value) => diagnostics.push(value));
    expect(result).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
  });

  it("falls back for a complete FUNCTION while its independent SQL selection uses the rules", async () => {
    const query = "select deptno,dname into v_id,v_name from dept where deptno=p_id and loc='Boston';";
    const sql = `create or replace function department_label(p_id number) return varchar2 is\n  v_id number;\n  v_name varchar2(100);\nbegin\n  ${query}\n  v_name := trim(v_name);\n  return v_name;\nexception when no_data_found then return 'unknown';\nend;`;
    const options = rules({ layoutStyle: "classic", selectListLayout: "vertical" });
    const diagnostics: string[] = [];
    const base = await formatSqlText(sql, "oracle", { layoutStyle: "classic" });
    expect(await formatSqlText(sql, "oracle", options, (value) => diagnostics.push(value))).toBe(base);
    expect(diagnostics).toEqual(["custom-rules-fallback"]);
    diagnostics.length = 0;
    expect(await formatSqlText(query, "oracle", options, (value) => diagnostics.push(value))).toMatch(/SELECT deptno,\n\s*dname/);
    expect(diagnostics).toEqual([]);
  });

  it("retains the source if neither rule nor base formatting can parse the input", async () => {
    const sql = "declare v_name varchar2(100) := 'unfinished";
    const diagnostics: string[] = [];
    await expect(formatSqlText(sql, "oracle", rules(), (value) => diagnostics.push(value))).rejects.toThrow();
    expect(diagnostics).toEqual([]);
    expect(await formatSqlForDisplay(sql, "oracle", rules())).toBe(sql);
  });

  it.each(["firstItem", "indent"] as const)("positions list continuations with %s alignment", async (listItemAlignment) => {
    const result = await formatSqlText("select a,b from t;", "oracle", rules({ listItemAlignment, selectListLayout: "vertical", tabWidth: 4 }));
    expect(result).toContain(`SELECT a,\n${" ".repeat(listItemAlignment === "firstItem" ? 7 : 4)}b`);
  });

  it("lets ON none override the global operator break without changing WHERE", async () => {
    const options = rules({ newlineBeforeJoinOn: true, onLogicalOperatorNewline: "none", logicalOperatorNewline: "before", selectListLayout: "singleLine" });
    const result = await formatSqlText("select a.id from a join b on a.id=b.id and a.x=b.x where a.y=1 and b.z=2;", "oracle", options);
    expect(result).toMatch(/ON a\.id = b\.id AND a\.x = b\.x/);
    expect(result).toMatch(/WHERE a\.y = 1\n\s*AND b\.z = 2/);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps DBX placeholders and an indivisible long literal intact at a narrow width", async () => {
    const literal = "'a comma, AND a very long literal that must not be split'";
    const sql = "select ${like} as x, #{Id} as y, " + literal + " as z from t;";
    const options = rules({ expressionWidth: 20, selectListLayout: "wrap", selectCommaPosition: "before", functionCase: "lower" });
    const result = await formatSqlText(sql, "mysql", options);
    expect(result).toContain("${like}");
    expect(result).toContain("#{Id}");
    expect(result).toContain(literal);
    expect(await formatSqlText(result, "mysql", options)).toBe(result);
  });

  it.each(["standard", "tabularLeft", "tabularRight"] as const)("uses %s keyword columns together with list rules", async (indentStyle) => {
    const options = rules({ indentStyle, selectListLayout: "vertical", collapseShortStatements: false });
    const result = await formatSqlText("select a,b from t where id=1;", "oracle", options);
    const lines = result.split("\n");
    const select = lines.find((line) => /\bSELECT\b/.test(line))!;
    const from = lines.find((line) => /\bFROM\b/.test(line))!;
    const where = lines.find((line) => /\bWHERE\b/.test(line))!;
    if (indentStyle === "tabularLeft") expect([select.indexOf("a"), from.indexOf("t"), where.indexOf("id")]).toEqual([7, 7, 7]);
    else if (indentStyle === "tabularRight") expect([select.indexOf("SELECT") + 6, from.indexOf("FROM") + 4, where.indexOf("WHERE") + 5]).toEqual([6, 6, 6]);
    else expect([select.indexOf("SELECT"), from.indexOf("FROM"), where.indexOf("WHERE")]).toEqual([0, 0, 0]);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("keeps the first keyword's right padding when a later keyword is longer", async () => {
    const options = rules({ indentStyle: "tabularRight", selectListLayout: "vertical", collapseShortStatements: false });
    const result = await formatSqlText("select a,b from t order by a,b;", "oracle", options);
    expect(result).toMatch(/^  SELECT a,/);
    expect(result).toMatch(/\n    FROM t/);
    expect(result).toMatch(/\nORDER BY a, b/);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("lets all DML lists inherit the general rule without losing their individual values", async () => {
    const options = rules({ listLayout: "singleLine", selectListLayout: "inherit", insertListLayout: "inherit", updateListLayout: "inherit", collapseShortStatements: false });
    const result = await formatSqlText("select a,b from t; insert into t (a,b) values(1,2); update t set a=1,b=2;", "oracle", options);
    expect(result).toContain("SELECT a, b");
    expect(result).toContain("t (a, b)");
    expect(result).toContain("VALUES (1, 2)");
    expect(result).toContain("SET a = 1, b = 2");
  });

  it.each(["remove", "single", "preserve", "inherit"] as const)("applies the %s empty-line mode to code paragraphs", async (emptyLineMode) => {
    const result = await formatSqlText("-- heading\n\n\nSELECT a,b FROM t;", "oracle", rules({ emptyLineMode, preserveEmptyLines: true }));
    const breaks = emptyLineMode === "remove" ? "\n" : emptyLineMode === "single" ? "\n\n" : "\n\n\n";
    expect(result).toContain(`-- heading${breaks}SELECT`);
    expect(result).not.toContain("__DBX_PRESERVE_EMPTY_LINE_");
  });

  it.each([
    ["remove", 0],
    ["single", 1],
    ["preserve", 2],
    ["inherit", 2],
  ] as const)("limits generated query spacing with emptyLineMode=%s", async (emptyLineMode, blankLines) => {
    const options = rules({ emptyLineMode, linesBetweenQueries: 2 });
    const result = await formatSqlText("select 1; select 2;", "oracle", options);
    expect(result).toBe(`SELECT 1;${"\n".repeat(blankLines + 1)}SELECT 2;`);
    expect(await formatSqlText(result, "oracle", options)).toBe(result);
  });

  it("preserves the saved query spacing when custom rules are disabled", async () => {
    expect(await formatSqlText("select 1; select 2;", "oracle", { customRulesEnabled: false, emptyLineMode: "remove", linesBetweenQueries: 2 })).toBe("SELECT 1;\n\n\nSELECT 2;");
  });

  it.each(["preserve", "upper", "lower"] as const)("keeps functionCase=%s when arguments must expand", async (functionCase) => {
    const result = await formatSqlText("select CoAlEsCe(a,b) from t;", "postgres", rules({ listLayout: "vertical", selectListLayout: "singleLine", functionCase }));
    const name = functionCase === "preserve" ? "CoAlEsCe" : functionCase === "upper" ? "COALESCE" : "coalesce";
    expect(result).toMatch(new RegExp(`${name}\\(a,\\n\\s*b\\)`));
  });
});
