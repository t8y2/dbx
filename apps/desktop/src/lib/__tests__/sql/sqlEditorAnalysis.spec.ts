import { EditorState } from "@codemirror/state";
import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { analyzeSqlCompletion, SqlCompletionAnalysisEngine, type SqlCompletionAnalysisRequest } from "@/lib/sql/sqlCompletionAnalysis";
import { analyzeSqlStatements } from "@/lib/sql/sqlStatementAnalysis";
import { executableStatementRangeCacheForDoc } from "@/lib/sql/executableStatementRangeCache";
import { analyzeSqlDiagnostics } from "@/lib/sql/sqlDiagnosticAnalysis";
import { sqlSemanticDiagnosticRangesForViewport, sqlServerRoutineDefinitionRangesForViewport } from "@/lib/sql/semantic/diagnostics";
import type { DatabaseType } from "@/types/database";
import { computeBlockFoldRanges } from "@/lib/editor/codemirrorSqlBlockFolding";

describe("background SQL completion parity", () => {
  it.each([
    ["mysql", "WITH recent(id) AS (SELECT id FROM orders) SELECT recent. FROM recent"],
    ["postgres", "SELECT nextval('orders_id_seq')"],
    ["oracle", "SELECT * FROM orders@remote"],
    ["sqlserver", "USE reporting; SELECT * FROM dbo.orders WHERE "],
    ["mysql", "SELECT 'literal; still literal' -- comment"],
  ] as const)("preserves %s context and trigger policy", (databaseType, sql) => {
    const dialect = databaseType === "oracle" ? "mysql" : databaseType;
    const request: SqlCompletionAnalysisRequest = { sql, cursor: sql.indexOf("recent.") >= 0 ? sql.indexOf("recent.") + 7 : sql.length, databaseType, dialect, semanticCompletionEnabled: true };
    const state = EditorState.create({ doc: sql, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialect, databaseType) })] });
    ensureSyntaxTree(state, sql.length, 1000);
    const expected = analyzeSqlCompletion(request, state);
    expect(new SqlCompletionAnalysisEngine().analyze(request)).toEqual(expected);
    expect(structuredClone(expected)).toEqual(expected);
  });

  it("preserves distant CTE columns in an oversized statement", () => {
    const sql = `WITH recent(id, total) AS (SELECT id, total FROM orders WHERE 1=1\n${"AND 1=1\n".repeat(5_000)}) SELECT recent. FROM recent`;
    const engine = new SqlCompletionAnalysisEngine();
    const request: SqlCompletionAnalysisRequest = { sql, cursor: sql.lastIndexOf("recent.") + 7, databaseType: "mysql", dialect: "mysql", semanticCompletionEnabled: true };
    const result = engine.analyze(request);
    expect(result.completionContext.qualifier).toBe("recent");
    expect(result.cteDefinitions).toContainEqual({ name: "recent", columns: ["id", "total"] });
    const edited = { ...request, sql: sql.slice(0, request.cursor) + "i" + sql.slice(request.cursor), cursor: request.cursor + 1 };
    expect(engine.analyze(edited)).toEqual(new SqlCompletionAnalysisEngine().analyze(edited));
    const replaced = { ...request, sql: "SELECT o. FROM orders o", cursor: 9 };
    expect(engine.analyze(replaced)).toEqual(new SqlCompletionAnalysisEngine().analyze(replaced));
  });
});

describe("background statement and diagnostic parity", () => {
  it.each([
    ["postgres", "DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$;\nSELECT 3;"],
    ["mysql", "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;"],
    ["oracle", "BEGIN\n NULL;\n NULL;\nEND;\n/\nSELECT 3 FROM dual;"],
    ["sqlserver", "CREATE PROCEDURE p AS\nBEGIN\n SELECT 1;\n SELECT 2;\nEND\nGO\nSELECT 3;"],
    ["mysql", "/*+ optimizer hint */ SELECT #{value};\nSELECT 'escaped;literal';"],
  ] as const)("keeps exact %s execution boundaries and viewport diagnostics", (databaseType, sql) => {
    const request = { sql, databaseType: databaseType as DatabaseType, parameterOptions: { enabledSyntaxes: ["mybatis" as const] } };
    const { doc: _doc, ...expected } = executableStatementRangeCacheForDoc(null, EditorState.create({ doc: sql }).doc, databaseType, request.parameterOptions);
    const result = structuredClone(analyzeSqlStatements(request));
    expect(result).toEqual(expected);
    const dialect = databaseType === "oracle" ? "mysql" : databaseType;
    const state = EditorState.create({ doc: sql, extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialect, databaseType) })] });
    ensureSyntaxTree(state, sql.length, 1000);
    expect(analyzeSqlStatements({ ...request, includeFolds: true, syntaxDialect: dialect }).folds).toEqual(computeBlockFoldRanges(state, databaseType));
    const visibleRanges = [{ from: 0, to: sql.length }];
    const diagnostics = analyzeSqlDiagnostics({ ...request, cursor: 0, visibleRanges }).document!;
    expect(diagnostics.shouldRun).toBe(true);
    expect(diagnostics.diagnosticRanges).toEqual(sqlSemanticDiagnosticRangesForViewport(sql, visibleRanges, databaseType, undefined, request.parameterOptions));
    expect(diagnostics.sqlServerRoutineRanges).toEqual(databaseType === "sqlserver" ? sqlServerRoutineDefinitionRangesForViewport(sql, visibleRanges) : []);
  });
});
