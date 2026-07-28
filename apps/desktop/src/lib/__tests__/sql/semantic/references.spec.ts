import { describe, expect, it } from "vitest";
import { buildSqlSemanticDiagnostics } from "@/lib/sql/semantic/diagnostics";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";
import { resolveSqlSemanticNavigationTarget, mergeSqlSemanticReferenceAnalysis, sqlSemanticCompletionReferenceTables, sqlSemanticTableReferences } from "@/lib/sql/semantic/references";
import { splitQualifiedIdentifier } from "@/lib/sql/sqlNavigation";
import type { SqlReferenceAnalysis } from "@/types/database";

const span = (startColumn: number, endColumn: number) => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

describe("sqlSemanticReferences shared consumers", () => {
  it("feeds CTE projected columns to diagnostics without physical table metadata", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT ro.missing FROM recent_orders ro WHERE ro.|");
    const model = buildSqlSemanticModel(sql, cursor);
    const analysis: SqlReferenceAnalysis = {
      tables: [],
      columns: [{ name: "missing", qualifier: "ro", span: span(sql.indexOf("missing") + 1, sql.indexOf("missing") + "missing".length) }],
    };

    const diagnostics = buildSqlSemanticDiagnostics(mergeSqlSemanticReferenceAnalysis(analysis, model), {
      tables: [],
      columnsByTable: new Map(),
      sql,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(["Unknown column ro.missing"]);
  });

  it("resolves navigation targets from subquery aliases and projected columns", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT sq.user_| FROM (SELECT id, name AS user_name FROM users) sq");
    const model = buildSqlSemanticModel(sql, cursor);
    const target = resolveSqlSemanticNavigationTarget(model, splitQualifiedIdentifier("sq.user_name"));

    expect(target).toEqual(expect.objectContaining({ name: "sq", alias: "sq", columns: ["id", "user_name"] }));
    expect(target?.source.kind).toBe("subquery");
  });

  it("keeps completion diagnostics and navigation row-source resolution consistent", () => {
    const { sql, cursor } = sqlFixtureCursor("WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT * FROM recent_orders ro WHERE ro.|");
    const model = buildSqlSemanticModel(sql, cursor);
    const completionRefs = sqlSemanticCompletionReferenceTables(model);
    const diagnosticRefs = sqlSemanticTableReferences(model);
    const navigationTarget = resolveSqlSemanticNavigationTarget(model, ["ro", "total"]);

    expect(completionRefs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recent_orders", alias: "ro", columns: ["id", "total"] })]));
    expect(diagnosticRefs).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recent_orders", alias: "ro", columns: ["id", "total"] })]));
    expect(navigationTarget).toEqual(expect.objectContaining({ name: "recent_orders", alias: "ro", columns: ["id", "total"] }));
  });

  it("resolves full SQL Server table navigation to the qualified database", () => {
    const { sql, cursor } = sqlFixtureCursor("SELECT * FROM [DatabaseA].[OUT].[orders] a JOIN [DatabaseB].[OUT].[orders] b ON a.id = b.id|");
    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "sqlserver" });
    const target = resolveSqlSemanticNavigationTarget(model, ["DatabaseB", "OUT", "orders"]);

    expect(target).toEqual(expect.objectContaining({ name: "orders", database: "DatabaseB", schema: "OUT", alias: "b" }));
  });
});
