import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionSource(name: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = dataGridSource.indexOf("\nfunction ", start + 1);
  return dataGridSource.slice(start, end < 0 ? undefined : end);
}

describe("DataGrid column formatter keys", () => {
  it("derives every key list from the shared canonical key builder", () => {
    const keysSource = functionSource("formatterKeysForColumn");
    expect(keysSource).toContain("return columnFormatterKeys({");
    expect(keysSource).toContain("databaseType: resolvedDatabaseType.value");
    expect(keysSource).toContain("displaySource: props.queryDisplaySourceColumns?.[columnIndex]");
    // Saves keep writing the single canonical keys[0] spelling.
    const saveSource = functionSource("saveColumnFormatter");
    expect(saveSource).toContain("const key = formatterKeyForColumn(columnIndex);");
    expect(saveSource).toContain("settingsStore.updateColumnFormatter(key, formatter);");
  });

  it("clears every candidate key so either surface leaves the column unformatted", () => {
    const clearSource = functionSource("clearColumnFormatter");
    expect(clearSource).toContain("const keys = formatterKeysForColumn(columnIndex);");
    expect(clearSource).toContain("if (!keys.length) return;");
    expect(clearSource).toContain("for (const key of keys) settingsStore.updateColumnFormatter(key, undefined);");
  });
});
