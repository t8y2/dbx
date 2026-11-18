import { describe, expect, it } from "vitest";
import { expandToSqlStatementWindow, parseInsertValueHints, parseInsertValueHintsAtCursor, parseInsertValueHintsInRanges, parseInsertValuesClauses } from "@/lib/sql/insertValueHints";
import { getSqlCompletionContext } from "@/lib/sql/sqlCompletion";
import { SqlCompletionAnalysisEngine } from "@/lib/sql/sqlCompletionAnalysis";
import { buildSqlSemanticDiagnostics } from "@/lib/sql/semantic/diagnostics";
import { buildSqlSemanticModel, sqlSemanticTableNameSpans } from "@/lib/sql/semantic/model";
import { mergeSqlSemanticReferenceAnalysis, resolveSqlSemanticNavigationTarget } from "@/lib/sql/semantic/references";
import { findActiveSqlStatementSpan, tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import { extractQualifiedIdentifierAt, resolveSqlObjectNavigationIdentity, splitQualifiedIdentifier } from "@/lib/sql/sqlNavigation";
import { resolveSqlShortcutTableToken } from "@/lib/sql/sqlShortcutTableTarget";

const options = { databaseType: "mysql", dialect: "mysql" } as const;
const database = "归档库（省级）";
const tableNames = ["gz13000102017152_医疗服务项目限年龄（省级）_事后_tab_1", "（省级）医疗服务", "医疗服务（省级", "医疗服务）省级"];

describe("MySQL fullwidth identifiers (#14111)", () => {
  it.each(tableNames)("preserves the full table identity for %s", (name) => {
    const sql = `SELECT gt1.id FROM ${database}.${name} gt1;`;
    const model = buildSqlSemanticModel(sql, sql.indexOf("gt1.id") + 5, options);

    expect(model.rowSources).toEqual([expect.objectContaining({ name, qualifierParts: [database], alias: "gt1" })]);
    expect(resolveSqlSemanticNavigationTarget(model, ["gt1", "id"])).toEqual(expect.objectContaining({ name, schema: database }));
    expect(sqlSemanticTableNameSpans(sql, options).map((span) => sql.slice(span.start, span.end))).toEqual([name]);
    expect(getSqlCompletionContext(sql, sql.indexOf("gt1.id") + 4, options).referencedTables).toEqual([expect.objectContaining({ name, schema: database, alias: "gt1" })]);

    const analysis = mergeSqlSemanticReferenceAnalysis({ tables: [], columns: [] }, model);
    expect(buildSqlSemanticDiagnostics(analysis, { sql, databaseType: "mysql", tables: [{ name, schema: database }], columnsByTable: new Map() })).toEqual([]);
  });

  it.each(tableNames)("extracts the same qualified name at every character of %s", (name) => {
    const qualified = `${database}.${name}`;
    const sql = `SELECT * FROM ${qualified} gt1;`;
    const start = sql.indexOf(qualified);
    for (let pos = start; pos < start + qualified.length; pos += 1) {
      const located = extractQualifiedIdentifierAt(sql, pos, "mysql");
      expect(located?.parts).toEqual([
        { value: database, quoted: false },
        { value: name, quoted: false },
      ]);
      expect(located && sql.slice(located.start, located.end)).toBe(qualified);
      expect(resolveSqlObjectNavigationIdentity(sql, pos, "mysql")).toEqual(expect.objectContaining({ name, qualifier: database, role: "unknown" }));
    }
    expect(splitQualifiedIdentifier(qualified, "mysql")).toEqual([database, name]);
  });

  it.each(tableNames)("keeps statement boundaries when the table is %s", (name) => {
    const sql = `SELECT * FROM ${name}; SELECT * FROM next_table;`;
    const cursor = sql.indexOf("next_table") + 2;
    const tokens = tokenizeSqlSemantic(sql, "mysql");
    const span = findActiveSqlStatementSpan(sql, tokens, cursor);
    const window = expandToSqlStatementWindow(sql, cursor, cursor, "mysql");
    expect(sql.slice(span.start, span.end)).toBe("SELECT * FROM next_table");
    expect(sql.slice(window.from, window.to).trim()).toBe("SELECT * FROM next_table");
    expect(buildSqlSemanticModel(sql, cursor, options).rowSources.map((source) => source.name)).toEqual(["next_table"]);
  });

  it("preserves quoted names and leaves strings, comments, and ASCII call depth intact", () => {
    const sql = "SELECT concat('（', ')'), `医疗服务（省级）`.id FROM `医疗服务（省级）` /* （ */; SELECT 2;";
    const tokens = tokenizeSqlSemantic(sql, "mysql");
    expect(tokens.filter((token) => token.text === ",").map((token) => token.depth)).toEqual([1, 0]);
    expect(tokens.filter((token) => token.kind === "quoted_identifier").map((token) => token.text)).toEqual(["`医疗服务（省级）`", "`医疗服务（省级）`"]);
    const span = findActiveSqlStatementSpan(sql, tokens, sql.lastIndexOf("2"));
    expect(sql.slice(span.start, span.end)).toBe("SELECT 2");
  });

  it.each(["oracle", "postgres", "sqlserver"])("retains existing fullwidth delimiter handling for %s", (dialect) => {
    const tokens = tokenizeSqlSemantic("to_date（x, y）", dialect);
    expect(tokens.find((token) => token.text === ",")?.depth).toBe(1);
    expect(extractQualifiedIdentifierAt("SELECT * FROM 表（省级）", 14, dialect)?.parts).toEqual([{ value: "表", quoted: false }]);
  });

  it("preserves the original table token for quick actions", () => {
    const token = `${database}.医疗服务（省级）`;
    const doc = `SELECT * FROM ${token};`;
    const head = doc.indexOf("省级", doc.indexOf("."));
    expect(resolveSqlShortcutTableToken(doc, { from: head, to: head, empty: true, head }, "mysql")).toBe(token);
  });

  it("keeps partial MySQL table names as one completion prefix", () => {
    const sql = "SELECT * FROM 医疗服务（省";
    const context = getSqlCompletionContext(sql, sql.length, options);
    expect(context.prefix).toBe("医疗服务（省");
    expect(context.exclusiveTableSuggestions).toBe(true);
  });

  it("resolves fullwidth aliases in both completion paths", () => {
    const name = "医疗服务（省级）";
    const alias = "记录（省级）";
    const sql = `SELECT ${alias}. FROM ${name} ${alias}`;
    const cursor = sql.indexOf(".") + 1;
    expect(getSqlCompletionContext(sql, cursor, options)).toEqual(expect.objectContaining({ qualifierParts: [alias], referencedTables: [expect.objectContaining({ name, alias })] }));
    const model = buildSqlSemanticModel(sql, cursor, options);
    expect(model.cursorIntent.kind).toBe("alias_column");
    expect(resolveSqlSemanticNavigationTarget(model, [alias, "id"])?.name).toBe(name);
  });

  it("resolves references using the real editor syntax-tree analysis engine", () => {
    const name = "医疗服务（省级）";
    const sql = `SELECT gt1. FROM ${database}.${name} gt1;`;
    const engine = new SqlCompletionAnalysisEngine();
    for (const semanticCompletionEnabled of [false, true]) {
      const result = engine.analyze({ sql, cursor: sql.indexOf("gt1.") + 4, ...options, semanticCompletionEnabled });
      expect(result.suppressed).toBe(false);
      expect(result.completionContext).toEqual(expect.objectContaining({ qualifier: "gt1", referencedTables: [expect.objectContaining({ name, schema: database, alias: "gt1" })] }));
    }
  });
});

describe("INSERT hints with MySQL fullwidth names", () => {
  it("retains #10104 tolerance alongside fullwidth target and source table names", () => {
    const sql = "INSERT INTO 目标库（省级）.目标表（省级） (occur_date, amount) SELECT to_date（to_char(src.d), 'YYYYMMDD'）, src.amount FROM 来源库（省级）.来源表（省级） src;";
    const [clause] = parseInsertValuesClauses(sql, "mysql");
    expect(clause).toEqual(expect.objectContaining({ table: "目标表（省级）", schema: "目标库（省级）", columns: ["occur_date", "amount"] }));
    expect(clause.rows[0].map((source) => source.from)).toEqual([sql.indexOf("to_date"), sql.indexOf("src.amount")]);
    expect(parseInsertValueHints(sql)).toEqual([
      { from: sql.indexOf("to_date"), column: "occur_date" },
      { from: sql.indexOf("src.amount"), column: "amount" },
    ]);
  });

  it("keeps fullwidth column names and aliases when the normal column counts agree", () => {
    const sql = "INSERT INTO 目标表（省级） (金额（省级）, 单位）) SELECT src.金额（省级） AS 金额（省级）, src.单位） AS 单位） FROM 来源表（省级） src";
    const [clause] = parseInsertValuesClauses(sql);
    expect(clause.columns).toEqual(["金额（省级）", "单位）"]);
    expect(clause.rows[0].map((source) => source.alias)).toEqual(["金额（省级）", "单位）"]);
    expect(parseInsertValueHints(sql)).toEqual([]);
  });

  it("locally recovers fullwidth function arguments in every VALUES row", () => {
    const sql = "INSERT INTO 目标表（省级） (name, amount) VALUES (concat（'a', 'b'）, 1), (concat（'c', 'd'）, 2)";
    const [clause] = parseInsertValuesClauses(sql);
    expect(clause.table).toBe("目标表（省级）");
    expect(clause.rows.map((row) => row.length)).toEqual([2, 2]);
    expect(parseInsertValueHints(sql).map((hint) => hint.from)).toEqual([sql.indexOf("concat"), sql.indexOf(", 1") + 2, sql.lastIndexOf("concat"), sql.indexOf(", 2") + 2]);
  });

  it("resolves missing target columns with the complete table and database qualifier", () => {
    const sql = "INSERT INTO 目标库（省级）.目标表（省级） VALUES (1, 2)";
    const calls: unknown[][] = [];
    const hints = parseInsertValueHints(sql, {
      resolveTableColumns: (...args) => {
        calls.push(args);
        return ["id", "amount"];
      },
    });
    expect(calls).toEqual([["目标表（省级）", "目标库（省级）", undefined]]);
    expect(hints.map((hint) => hint.column)).toEqual(["id", "amount"]);
  });

  it("preserves hint offsets in parenthesized SELECTs and viewport slices", () => {
    const sql = "SELECT '前置（语句）';\nINSERT INTO 目标表（省级） (d, amount) (SELECT to_date（to_char(src.d), 'YYYYMMDD'）, src.amount FROM 来源表（省级） src);\nSELECT 3;";
    const expected = [
      { from: sql.indexOf("to_date"), column: "d" },
      { from: sql.indexOf("src.amount"), column: "amount" },
    ];
    expect(parseInsertValueHints(sql)).toEqual(expected);
    expect(parseInsertValueHintsAtCursor(sql, sql.indexOf("to_date") + 3)).toEqual(expected);
    expect(parseInsertValueHintsInRanges(sql, [{ from: sql.indexOf("to_date"), to: sql.indexOf("to_date") + 7 }])).toEqual(expected);
  });
});
