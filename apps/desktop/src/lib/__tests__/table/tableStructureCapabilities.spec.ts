import { describe, expect, it } from "vitest";
import { getTableStructureCapabilities, isPhysicalTableColumnOrderChange, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";

describe("tableStructureCapabilities", () => {
  it("uses table rebuilds only for native SQLite connections", () => {
    expect(getTableStructureCapabilities("sqlite", "sqlite")).toMatchObject({
      alterStrategy: "sqlite-rebuild",
      alterExistingColumn: true,
      alterType: true,
    });

    for (const [databaseType, connectionType] of [
      ["rqlite", "rqlite"],
      ["turso", "turso"],
      ["sqlite", "jdbc"],
      ["sqlite", undefined],
    ] as const) {
      expect(getTableStructureCapabilities(databaseType, connectionType)).toMatchObject({
        alterStrategy: "none",
        alterExistingColumn: false,
        alterType: false,
      });
    }
  });

  it("marks databases with native ALTER COLUMN support as direct", () => {
    expect(getTableStructureCapabilities("mysql", "mysql").alterStrategy).toBe("direct");
    expect(getTableStructureCapabilities("postgres", "postgres").alterStrategy).toBe("direct");
  });

  it("uses local-only column reordering for editable databases without physical reorder support", () => {
    for (const databaseType of ["sqlserver", "postgres", "sqlite", "oracle", "dameng", "duckdb", "informix"] as const) {
      expect(supportsLocalTableColumnReorder(databaseType, databaseType)).toBe(true);
    }

    for (const databaseType of ["mysql", "gbase", "clickhouse"] as const) {
      expect(supportsLocalTableColumnReorder(databaseType, databaseType)).toBe(false);
    }
    expect(supportsLocalTableColumnReorder("influxdb", "influxdb")).toBe(false);
  });

  it("does not treat local-only reordering as a database structure change", () => {
    expect(isPhysicalTableColumnOrderChange("sqlserver", "sqlserver", 0, 2)).toBe(false);
    expect(isPhysicalTableColumnOrderChange("postgres", "postgres", 0, 2)).toBe(false);
    expect(isPhysicalTableColumnOrderChange("mysql", "mysql", 0, 2)).toBe(true);
  });
});
