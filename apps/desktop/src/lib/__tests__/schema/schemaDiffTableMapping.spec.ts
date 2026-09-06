import { describe, expect, it, vi } from "vitest";
import { loadSchemaDetails, type SchemaDiffMetadataApi } from "@/lib/schema/schemaDiffMetadataLoad";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { availableSchemaDiffTargetTables, buildSchemaDiffTableMatches, pruneSchemaDiffTableMappings, reconcileSchemaDiffTableMappings, swapSchemaDiffTableMappings, updateSchemaDiffTableMapping } from "@/lib/schema/schemaDiffTableMapping";
import { DEFAULT_MYSQL_OPTIONS, normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { TableInfo } from "@/types/database";

const table = (name: string): TableInfo => ({ name, table_type: "BASE TABLE" });

describe("schema diff table mappings", () => {
  it("automatically matches same-name tables", () => {
    expect(buildSchemaDiffTableMatches(["a", "b"], ["a", "b"], [])).toEqual([
      { sourceTable: "a", targetTable: "a", kind: "automatic" },
      { sourceTable: "b", targetTable: "b", kind: "automatic" },
    ]);
  });

  it("matches table names case-insensitively only when enabled and rejects ambiguous candidates", () => {
    expect(reconcileSchemaDiffTableMappings(["User"], ["user"], [], true)).toEqual([{ sourceTable: "User", targetTable: "user" }]);
    expect(reconcileSchemaDiffTableMappings(["user"], ["User", "USER"], [], true)).toEqual([]);
    expect(reconcileSchemaDiffTableMappings(["foo", "FOO"], ["FOO"], [], true)).toEqual([{ sourceTable: "FOO", targetTable: "FOO" }]);
    expect(buildSchemaDiffTableMatches(["User"], ["user"], [], true)).toEqual([{ sourceTable: "User", targetTable: "user", kind: "automatic" }]);
  });

  it("keeps explicit table mappings ahead of case-insensitive automatic matching", () => {
    expect(reconcileSchemaDiffTableMappings(["source_a"], ["SOURCE_A", "target_b"], [{ sourceTable: "source_a", targetTable: "target_b" }], true)).toEqual([{ sourceTable: "source_a", targetTable: "target_b" }]);
  });

  it("leaves a source unmatched when only some names exist on target", () => {
    expect(buildSchemaDiffTableMatches(["a", "b", "c"], ["a", "x", "c"], [])).toEqual([
      { sourceTable: "a", targetTable: "a", kind: "automatic" },
      { sourceTable: "b", kind: "unmatched" },
      { sourceTable: "c", targetTable: "c", kind: "automatic" },
    ]);
  });

  it("keeps manual mappings alongside automatic matches", () => {
    expect(buildSchemaDiffTableMatches(["a", "b", "c"], ["a", "x", "c"], [{ sourceTable: "b", targetTable: "x" }])).toEqual([
      { sourceTable: "a", targetTable: "a", kind: "automatic" },
      { sourceTable: "b", targetTable: "x", kind: "manual" },
      { sourceTable: "c", targetTable: "c", kind: "automatic" },
    ]);
  });

  it("allows a manual mapping to override an automatic match", () => {
    expect(buildSchemaDiffTableMatches(["a"], ["a", "a_new"], [{ sourceTable: "a", targetTable: "a_new" }])).toEqual([{ sourceTable: "a", targetTable: "a_new", kind: "manual" }]);
  });

  it("removes mappings for deselected sources and automatically matches new sources", () => {
    const mappings = [
      { sourceTable: "a", targetTable: "a" },
      { sourceTable: "b", targetTable: "b_new" },
    ];
    expect(reconcileSchemaDiffTableMappings(["a", "c"], ["a", "b_new", "c"], mappings)).toEqual([
      { sourceTable: "a", targetTable: "a" },
      { sourceTable: "c", targetTable: "c" },
    ]);
    expect(pruneSchemaDiffTableMappings(["a"], mappings)).toEqual([{ sourceTable: "a", targetTable: "a" }]);
  });

  it("reconciles a vanished target mapping back to same-name or unmatched", () => {
    expect(reconcileSchemaDiffTableMappings(["a", "b"], ["a", "b"], [{ sourceTable: "b", targetTable: "b_old" }])).toEqual([
      { sourceTable: "a", targetTable: "a" },
      { sourceTable: "b", targetTable: "b" },
    ]);
    expect(reconcileSchemaDiffTableMappings(["b"], ["b_other"], [{ sourceTable: "b", targetTable: "b_old" }])).toEqual([]);
  });

  it("rejects duplicate target mappings and hides occupied targets", () => {
    const mappings = [{ sourceTable: "a", targetTable: "x" }];
    expect(updateSchemaDiffTableMapping(mappings, "b", "x")).toEqual({ mappings, accepted: false, conflictSource: "a" });
    expect(availableSchemaDiffTargetTables("b", ["x", "y"], mappings)).toEqual(["y"]);
    expect(
      reconcileSchemaDiffTableMappings(
        ["a", "b"],
        ["x", "b"],
        [
          { sourceTable: "a", targetTable: "x" },
          { sourceTable: "b", targetTable: "x" },
        ],
      ),
    ).toEqual([
      { sourceTable: "a", targetTable: "x" },
      { sourceTable: "b", targetTable: "b" },
    ]);
  });

  it("round-trips table mappings through normalized config JSON", () => {
    const options = normalizeSchemaDiffCompareOptions({ tableMappings: [{ sourceTable: "a", targetTable: "a_new" }] });
    const restored = normalizeSchemaDiffCompareOptions(JSON.parse(JSON.stringify(options)));
    expect(restored.tableMappings).toEqual([{ sourceTable: "a", targetTable: "a_new" }]);
    expect(normalizeSchemaDiffCompareOptions({}).tableMappings).toEqual([]);
    expect(normalizeSchemaDiffCompareOptions({}).ignoreTableNameCase).toBe(false);
    expect(normalizeSchemaDiffCompareOptions({}).ignoreColumnNameCase).toBe(false);
  });

  it("swaps each mapping direction", () => {
    expect(
      swapSchemaDiffTableMappings([
        { sourceTable: "a", targetTable: "b" },
        { sourceTable: "c", targetTable: "d" },
      ]),
    ).toEqual([
      { sourceTable: "b", targetTable: "a" },
      { sourceTable: "d", targetTable: "c" },
    ]);
  });

  it("selects mapped target tables for metadata loading instead of same-name tables", async () => {
    const options = { ...DEFAULT_MYSQL_OPTIONS, tableMappings: [{ sourceTable: "charge_records", targetTable: "charge_record" }] };
    const filter = compileSchemaDiffTableFilter(options);
    const filtered = filterSchemaDiffTables([table("charge_records")], [table("charge_records"), table("charge_record")], filter, options, ["charge_records"]);
    expect(filtered.sourceTables.map((entry) => entry.name)).toEqual(["charge_records"]);
    expect(filtered.targetTables.map((entry) => entry.name)).toEqual(["charge_record"]);

    const getColumns = vi.fn().mockResolvedValue([]);
    const api: SchemaDiffMetadataApi = {
      getTableDdl: vi.fn().mockResolvedValue(""),
      getColumns,
      listIndexes: vi.fn().mockResolvedValue([]),
      listForeignKeys: vi.fn().mockResolvedValue([]),
      listTriggers: vi.fn().mockResolvedValue([]),
    };
    await loadSchemaDetails(
      filtered.targetTables,
      {
        connectionId: "target",
        database: "app",
        schema: "public",
        dbType: "mysql",
        options,
      },
      api,
    );
    expect(getColumns).toHaveBeenCalledWith("target", "app", "public", "charge_record");
    expect(getColumns).not.toHaveBeenCalledWith("target", "app", "public", "charge_records");
  });
});
