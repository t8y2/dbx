import { describe, expect, it } from "vitest";
import { analyzeEditableQueryEditability, resolveSourceColumnsByOrdinal } from "@/lib/sql/sqlAnalysis";

/**
 * Result columns resolve by projection ordinal, each carrying its source
 * identity (sourceKey + canonical source column), so joined results keep
 * per-source comments instead of first-source-wins on name clashes.
 */
describe("multi-source result column mapping", () => {
  it("parses a JOIN as multi-source with per-source columns", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, a.user_id, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const sources = result.analysis.sources!;
    expect(sources.map((source) => source.tableName)).toEqual(["orders", "users"]);
    expect(result.analysis.columns.map((column) => column.resultName)).toEqual(["id", "user_id", "name"]);
    expect(result.analysis.columns.map((column) => column.sourceKey)).toEqual(["a:0", "a:0", "b:1"]);
  });

  it("maps each JOIN result column back to (source, column) by ordinal", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, a.user_id, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      3,
    );
    expect(resolved).toEqual([
      { sourceKey: "a:0", sourceColumn: "id" },
      { sourceKey: "a:0", sourceColumn: "user_id" },
      { sourceKey: "b:1", sourceColumn: "name" },
    ]);
  });

  it("keeps duplicate result column names resolved per source (both tables have id)", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, b.id FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      2,
    );
    // Result column #0 is orders.id, #1 is users.id — no first-source-wins.
    expect(resolved).toEqual([
      { sourceKey: "a:0", sourceColumn: "id" },
      { sourceKey: "b:1", sourceColumn: "id" },
    ]);
  });

  it("resolves a uniquely qualified unqualified alias (name AS username) back to its physical column", () => {
    const result = analyzeEditableQueryEditability("SELECT name AS username FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      1,
    );
    expect(resolved).toEqual([{ sourceKey: "b:1", sourceColumn: "name" }]);
  });

  it("returns undefined for an ambiguous unqualified column shared by several sources", () => {
    const result = analyzeEditableQueryEditability("SELECT id FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      1,
    );
    expect(resolved).toEqual([undefined]);
  });

  it("resolves quoted mixed-case identifiers exactly (case preserved)", () => {
    const result = analyzeEditableQueryEditability('SELECT a."ID", b."Name" FROM orders a JOIN users b ON a.user_id = b.id');
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "postgres",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "ID" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "Name" }] },
      ],
      2,
    );
    expect(resolved).toEqual([
      { sourceKey: "a:0", sourceColumn: "ID" },
      { sourceKey: "b:1", sourceColumn: "Name" },
    ]);
  });

  it("does not collapse an unquoted lower-case name onto a distinct quoted mixed-case column", () => {
    const result = analyzeEditableQueryEditability('SELECT a.id, b."ID" FROM orders a JOIN users b ON a.user_id = b.id');
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "postgres",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "ID" }, { name: "name" }] },
      ],
      2,
    );
    // a.id folds to postgres `id`; b."ID" matches the quoted column exactly.
    expect(resolved).toEqual([
      { sourceKey: "a:0", sourceColumn: "id" },
      { sourceKey: "b:1", sourceColumn: "ID" },
    ]);
  });

  it("expands a qualified star projection in projection order", () => {
    const result = analyzeEditableQueryEditability("SELECT a.*, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      4,
    );
    expect(resolved).toEqual([
      { sourceKey: "a:0", sourceColumn: "id" },
      { sourceKey: "a:0", sourceColumn: "user_id" },
      { sourceKey: "a:0", sourceColumn: "amount" },
      { sourceKey: "b:1", sourceColumn: "name" },
    ]);
  });

  it("returns undefined for computed columns and extra result columns", () => {
    const result = analyzeEditableQueryEditability("SELECT a.id, a.amount + b.id AS total, b.name FROM orders a JOIN users b ON a.user_id = b.id");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const resolved = resolveSourceColumnsByOrdinal(
      "mysql",
      result.analysis,
      [
        { source: result.analysis.sources![0]!, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] },
        { source: result.analysis.sources![1]!, columns: [{ name: "id" }, { name: "name" }] },
      ],
      3,
    );
    expect(resolved).toEqual([{ sourceKey: "a:0", sourceColumn: "id" }, undefined, { sourceKey: "b:1", sourceColumn: "name" }]);
  });
});
