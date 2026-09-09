import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");
const formatterSource = readFileSync(new URL("../../../composables/useDataGridColumnFormatter.ts", import.meta.url), "utf8");

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n  function ", start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

describe("DataGrid column formatter keys", () => {
  it("derives every key list from the shared canonical key builder", () => {
    const keysSource = functionSource(formatterSource, "formatterKeysForColumn");
    expect(keysSource).toContain("return columnFormatterKeys({");
    expect(keysSource).toContain("databaseType: options.resolvedDatabaseType.value");
    expect(keysSource).toContain("displaySource: props.queryDisplaySourceColumns?.[columnIndex]");
    // Saves keep writing the single canonical keys[0] spelling.
    const saveSource = functionSource(formatterSource, "saveColumnFormatter");
    expect(saveSource).toContain("const key = formatterKeyForColumn(columnIndex);");
    expect(saveSource).toContain("settingsStore.updateColumnFormatter(key, formatter);");
  });

  it("clears every candidate key so either surface leaves the column unformatted", () => {
    const clearSource = functionSource(formatterSource, "clearColumnFormatter");
    expect(clearSource).toContain("const keys = formatterKeysForColumn(columnIndex);");
    expect(clearSource).toContain("if (!keys.length) return;");
    expect(clearSource).toContain("for (const key of keys) settingsStore.updateColumnFormatter(key, undefined);");
  });
});
