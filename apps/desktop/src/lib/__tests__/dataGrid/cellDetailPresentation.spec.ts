import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactJsonText, valueEditorActions } from "@/lib/dataGrid/cellDetailPresentation";

const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

describe("cellDetailPresentation", () => {
  it("offers compact JSON beside format JSON for editable JSON values", () => {
    expect(valueEditorActions({ canSetNull: true, canFormatJson: true })).toEqual(["formatJson", "compactJson", "setNull", "restoreOriginal"]);
    expect(valueEditorActions({ canSetNull: false, canFormatJson: false })).toEqual(["restoreOriginal"]);
    expect(compactJsonText('{\n  "name": "DBX",\n  "enabled": true\n}')).toBe('{"name":"DBX","enabled":true}');
  });

  it("wires the value editor compact action to the existing compact handler", () => {
    expect(dataGridSource).toContain("activeValueEditorActions.includes('compactJson')");
    expect(dataGridSource).toContain('@click="compactDetailJson"');
  });
});
