import { describe, expect, it } from "vitest";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";

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
});
