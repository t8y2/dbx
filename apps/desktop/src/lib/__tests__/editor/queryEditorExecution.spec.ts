import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract", () => {
    expect(queryEditorSource).toContain("binding(shortcuts.executeSql, () => requestExecute())");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });

  it("keeps selection priority and the configured current/all target choice", () => {
    const selectionBranch = queryEditorSource.indexOf("if (!options.ignoreSelection && !selection.empty)");
    const executeModeBranch = queryEditorSource.indexOf('settingsStore.editorSettings.executeMode === "current" ? "cursor" : "all"');

    expect(selectionBranch).toBeGreaterThan(-1);
    expect(executeModeBranch).toBeGreaterThan(selectionBranch);
  });
});
