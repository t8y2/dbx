import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract while bypassing the picker", () => {
    expect(queryEditorSource).toContain("binding(shortcuts.executeSql, () => requestExecute({ bypassPicker: true }))");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });

  it("keeps selection priority and the configured current/all target choice", () => {
    const selectionBranch = queryEditorSource.indexOf("if (!options.ignoreSelection && !selection.empty)");
    const executeModeBranch = queryEditorSource.indexOf('settingsStore.editorSettings.executeMode === "current" ? "cursor" : "all"');

    expect(selectionBranch).toBeGreaterThan(-1);
    expect(executeModeBranch).toBeGreaterThan(selectionBranch);
  });

  it("lets the shortcut skip the picker without affecting other execution entry points", () => {
    // The picker guard must also honor the shortcut's bypass flag, otherwise Ctrl+Enter would keep popping the dialog.
    expect(queryEditorSource).toContain("if (options.bypassPicker || !settingsStore.editorSettings.showExecutionTargetPicker");
  });
});
