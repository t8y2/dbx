import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { test } from "vitest";

const source = readFileSync("apps/desktop/src/components/import/TableImportDialog.vue", "utf8");

test("positions the import data type picker from the focused input", () => {
  assert.match(source, /function openDataTypePicker\(sourceColumn: string, input: HTMLInputElement\)/);
  assert.match(source, /@focus="\(event\) => openDataTypePicker\(sourceColumn, event\.currentTarget as HTMLInputElement\)"/);
  assert.doesNotMatch(source, /document\.querySelector<HTMLElement>\(`\[data-dt-input\]/);
});

test("dismisses and navigates the import data type picker with the keyboard", () => {
  assert.match(source, /@blur="closeDataTypePicker"/);
  assert.match(source, /@keydown="\(event\) => handleDataTypePickerKeydown\(event, sourceColumn, event\.currentTarget as HTMLInputElement\)"/);
  assert.match(source, /!dataTypePickerOpen\.value && \(event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /if \(step !== "mapping"\) closeDataTypePicker\(\)/);
});
