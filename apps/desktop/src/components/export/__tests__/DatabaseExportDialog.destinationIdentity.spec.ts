import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../DatabaseExportDialog.vue", import.meta.url), "utf8");

function functionSource(name: string, nextName: string) {
  const start = dialogSource.indexOf(`async function ${name}(`);
  const end = dialogSource.indexOf(`async function ${nextName}(`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return dialogSource.slice(start, end);
}

describe("DatabaseExportDialog destination identity", () => {
  it("records a manually selected file destination before starting a single-database export", () => {
    const source = functionSource("startExport", "startAllDatabasesExport");
    const selectedPath = source.indexOf("const path = await save(");
    const recordedDestination = source.indexOf("recordDatabaseExportDestination(await dirname(path))");
    const exportStarted = source.indexOf("isExporting.value = true");

    expect(selectedPath).toBeGreaterThanOrEqual(0);
    expect(recordedDestination).toBeGreaterThan(selectedPath);
    expect(exportStarted).toBeGreaterThan(recordedDestination);
  });

  it("records a manually selected directory before starting an all-databases export", () => {
    const source = functionSource("startAllDatabasesExport", "cancelExport");
    const selectedPath = source.indexOf("const path = await openDialog(");
    const recordedDestination = source.indexOf("recordDatabaseExportDestination(path)");
    const exportStarted = source.indexOf("isExporting.value = true");

    expect(selectedPath).toBeGreaterThanOrEqual(0);
    expect(recordedDestination).toBeGreaterThan(selectedPath);
    expect(exportStarted).toBeGreaterThan(recordedDestination);
  });
});
