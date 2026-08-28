import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid DDL search navigation", () => {
  it("resets navigation when the raw search query changes", () => {
    expect(dataGridSource).toMatch(/watch\(\s*\[filteredDdlContent, searchQuery\],/);
  });

  it("uses the shared DDL cache policy and exposes refresh controls", () => {
    expect(dataGridSource).toContain('from "@/lib/metadata/objectDdlCache"');
    expect(dataGridSource).toContain("async function fetchDdl(force = settingsStore.editorSettings.refreshDdlOnOpen)");
    expect(dataGridSource).toMatch(/loadObjectDdl\([\s\S]*?objectType: tableObjectSourceKind\(props\.tableMeta\.tableType\),[\s\S]*?\{ force \},/);
    expect(dataGridSource).toMatch(/async function refreshActiveTableInfo\(\)[\s\S]*?fetchDdl\(true\)[\s\S]*?fetchTableInfoColumns\(\)[\s\S]*?fetchIndexes\(\)[\s\S]*?fetchForeignKeys\(\)[\s\S]*?fetchTriggers\(\)/);
    expect(dataGridSource).toContain('@click="refreshActiveTableInfo"');
    expect(dataGridSource).not.toContain("setTableInfoRefreshDdlOnOpen");
  });
});
