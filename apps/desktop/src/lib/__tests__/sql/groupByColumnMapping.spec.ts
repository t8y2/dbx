import { describe, expect, it } from "vitest";
import { analyzeEditableQueryEditability, analyzeSelectStructureForDisplay, resolveSourceColumnsByOrdinal, type EditableQueryInfo, type EditableQuerySource } from "@/lib/sql/sqlAnalysis";

/**
 * Mirrors queryStore.editableQuerySources: single-source analyses store the
 * source on the analysis root, so tests normalize it exactly like the store
 * before resolving result columns by ordinal.
 */
function displayTableSources(analysis: EditableQueryInfo, columns: readonly string[]): Array<{ source: EditableQuerySource; columns: { name: string }[] }> {
  const source: EditableQuerySource = analysis.sources?.length
    ? analysis.sources[0]!
    : {
        key: `${analysis.tableAlias ?? analysis.tableName}:0`,
        catalog: analysis.catalog,
        catalogQuoted: analysis.catalogQuoted,
        schema: analysis.schema,
        schemaQuoted: analysis.schemaQuoted,
        tableName: analysis.tableName,
        tableNameQuoted: analysis.tableNameQuoted,
        alias: analysis.tableAlias,
      };
  return [{ source, columns: columns.map((name) => ({ name })) }];
}

/**
 * GROUP BY / HAVING queries stay read-only (`aggregation`) but still expose a
 * display-only structural analysis so the result grid can resolve comments for
 * result columns that map directly back to a base-table column. Aggregate,
 * computed and ambiguous projections must stay unresolved (no guessed comment).
 */
describe("grouped query display column mapping", () => {
  describe("display structure analysis", () => {
    it("parses projections and sources for a GROUP BY query without making it editable", () => {
      const editability = analyzeEditableQueryEditability("SELECT department, COUNT(*) AS total FROM users GROUP BY department");
      expect(editability).toEqual({ editable: false, reason: "aggregation" });

      const analysis = analyzeSelectStructureForDisplay("SELECT department, COUNT(*) AS total FROM users GROUP BY department");
      expect(analysis).not.toBeNull();
      if (!analysis) return;
      expect(analysis.tableName).toBe("users");
      expect(analysis.columns.map((column) => column.resultName)).toEqual(["department", "total"]);
      expect(analysis.columns[0]).toMatchObject({ sourceName: "department" });
      // Aggregate expression has no direct source column.
      expect(analysis.columns[1]?.sourceName).toBeUndefined();
    });

    it("parses HAVING queries without an explicit GROUP BY", () => {
      const editability = analyzeEditableQueryEditability("SELECT department, COUNT(*) AS total FROM users GROUP BY department HAVING COUNT(*) > 1");
      expect(editability).toEqual({ editable: false, reason: "aggregation" });

      const analysis = analyzeSelectStructureForDisplay("SELECT department, COUNT(*) AS total FROM users GROUP BY department HAVING COUNT(*) > 1");
      expect(analysis).not.toBeNull();
      if (!analysis) return;
      expect(analysis.columns.map((column) => column.resultName)).toEqual(["department", "total"]);
    });

    it("parses multi-source grouped queries with per-source qualifiers", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT u.department, COUNT(o.id) AS order_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.department");
      expect(analysis).not.toBeNull();
      if (!analysis) return;
      expect(analysis.sources!.map((source) => source.tableName)).toEqual(["users", "orders"]);
      expect(analysis.columns.map((column) => column.resultName)).toEqual(["department", "order_count"]);
      expect(analysis.columns[0]?.sourceKey).toBe("u:0");
    });

    it("returns null for unparseable / dangerous display shapes", () => {
      expect(analyzeSelectStructureForDisplay("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
      expect(analyzeSelectStructureForDisplay("SELECT a FROM (SELECT 1 AS a) t")).toBeNull();
      expect(analyzeSelectStructureForDisplay("INSERT INTO t VALUES (1)")).toBeNull();
    });
  });

  describe("ordinal resolution", () => {
    it("maps direct physical columns and leaves aggregate expressions unresolved (T1)", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT department, COUNT(*) AS total FROM users GROUP BY department");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal("mysql", analysis, displayTableSources(analysis, ["department", "id"]), 2);
      expect(resolved).toEqual([{ sourceKey: "users:0", sourceColumn: "department" }, undefined]);
    });

    it("resolves aliased physical columns back to the base column (T2)", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT department AS dept, COUNT(*) AS total FROM users GROUP BY department");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal("mysql", analysis, displayTableSources(analysis, ["department", "id"]), 2);
      expect(resolved).toEqual([{ sourceKey: "users:0", sourceColumn: "department" }, undefined]);
    });

    it("maps multiple grouped physical columns (T5)", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT department, status, COUNT(*) FROM users GROUP BY department, status");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal("mysql", analysis, displayTableSources(analysis, ["department", "status", "id"]), 3);
      expect(resolved).toEqual([{ sourceKey: "users:0", sourceColumn: "department" }, { sourceKey: "users:0", sourceColumn: "status" }, undefined]);
    });

    it("never lets an aggregate expression inherit its operand's comment (T6/T7)", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT DATE(created_at) AS day, SUM(amount) AS total_amount FROM orders GROUP BY DATE(created_at)");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal("mysql", analysis, displayTableSources(analysis, ["created_at", "amount", "id"]), 2);
      expect(resolved).toEqual([undefined, undefined]);
    });

    it("resolves qualified grouped columns across joined sources (T4) and keeps aggregates unresolved", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT u.department, COUNT(o.id) AS order_count FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.department");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const usersSource = analysis.sources![0]!;
      const ordersSource = analysis.sources![1]!;
      const resolved = resolveSourceColumnsByOrdinal(
        "mysql",
        analysis,
        [
          { source: usersSource, columns: [{ name: "id" }, { name: "department" }] },
          { source: ordersSource, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] },
        ],
        2,
      );
      expect(resolved).toEqual([{ sourceKey: "u:0", sourceColumn: "department" }, undefined]);
    });

    it("keeps quoted identifier semantics for grouped columns (T8)", () => {
      const analysis = analyzeSelectStructureForDisplay('SELECT "ID", COUNT(*) AS total FROM users GROUP BY "ID"');
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal("postgres", analysis, displayTableSources(analysis, ["id", "ID"]), 2);
      // Quoted "ID" matches the physical quoted column exactly; unquoted id stays distinct.
      expect(resolved).toEqual([{ sourceKey: "users:0", sourceColumn: "ID" }, undefined]);
    });

    it("leaves ambiguous unqualified grouped columns unresolved (T9)", () => {
      const analysis = analyzeSelectStructureForDisplay("SELECT id, COUNT(*) AS total FROM users u JOIN orders o ON o.user_id = u.id GROUP BY id");
      expect(analysis).not.toBeNull();
      if (!analysis) return;

      const resolved = resolveSourceColumnsByOrdinal(
        "mysql",
        analysis,
        [
          { source: analysis.sources![0]!, columns: [{ name: "id" }, { name: "department" }] },
          { source: analysis.sources![1]!, columns: [{ name: "id" }, { name: "user_id" }] },
        ],
        2,
      );
      expect(resolved).toEqual([undefined, undefined]);
    });
  });
});
