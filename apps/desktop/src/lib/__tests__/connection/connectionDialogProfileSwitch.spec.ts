import { readFileSync } from "node:fs";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const parsedDialog = parse(dialogSource, { filename: "ConnectionDialog.vue" });

function functionSource(name: string): string {
  const script = parsedDialog.descriptor.scriptSetup;
  expect(parsedDialog.errors).toEqual([]);
  expect(script).toBeDefined();

  const source = ts.createSourceFile("ConnectionDialog.vue.ts", script!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(declaration).toBeDefined();
  return declaration!.getText();
}

describe("ConnectionDialog database profile switching", () => {
  it("resets parsed connection fields before selecting another profile for a new connection", () => {
    const source = functionSource("onDbTypeChange");
    const resetIndex = source.indexOf("if (!editingId.value && val !== selectedType.value)");
    const applyIndex = source.indexOf("applyProfile(val, !!editingId.value)");

    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(source).toContain("resetForm({ preservePickerState: true })");
    expect(applyIndex).toBeGreaterThan(resetIndex);
  });
});
