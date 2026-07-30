import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract while bypassing the picker", () => {
    expect(queryEditorSource).toContain("binding(shortcuts.executeSql, () => requestExecute({ bypassPicker: true }))");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });

  it("routes the new-result-tab shortcut through the same target selection contract", () => {
    expect(queryEditorSource).toContain("binding(shortcuts.executeSqlInNewResultTab, requestExecuteInNewResultTab)");
    expect(queryEditorSource).toContain('emit("executeInNewResultTab", source)');
    expect(queryEditorSource).toContain("requestExecute({ bypassPicker: true, openInNewResultTab: true })");
    expect(contentAreaSource).toContain('const showResultRunTabs = computed(() => resultRuns.value.length > 0 && resultRunDisplayMode.value === "tabs")');
    expect(contentAreaSource).toContain("!!props.activeTab.resultRuns?.length");
    expect(contentAreaSource).toContain('role="tablist" :aria-label="t(\'tabs.resultRuns\')"');
  });

  it("keeps selection priority and the configured current/all target choice", () => {
    const selectionBranch = queryEditorSource.indexOf("if (!options.ignoreSelection && !selection.empty)");
    const executeModeBranch = queryEditorSource.indexOf('settingsStore.editorSettings.executeMode === "current" ? "cursor" : "all"');

    expect(selectionBranch).toBeGreaterThan(-1);
    expect(executeModeBranch).toBeGreaterThan(selectionBranch);
  });

  it("preserves the source range when executing a current/all candidate without a manual selection", () => {
    expect(queryEditorSource).toContain("emitExecutionRequest(sqlExecutionSnapshotForRange(currentView, candidate), options.openInNewResultTab)");
    expect(queryEditorSource).toContain("currentView ? sqlExecutionSnapshotForRange(currentView, candidate) : candidate.sql");
    expect(queryEditorSource).toContain("selectionFrom: range.from");
    expect(queryEditorSource).toContain("selectionTo: range.to");
  });

  it("preserves the source range when executing from the statement gutter", () => {
    expect(queryEditorSource).toContain("emitExecutionRequest(sqlExecutionSnapshotForRange(currentView, statementRange))");
    expect(queryEditorSource).not.toContain('emit("execute", statementRange.sql)');
  });

  it("lets the shortcut skip the picker without affecting other execution entry points", () => {
    // The picker guard must also honor the shortcut's bypass flag, otherwise Ctrl+Enter would keep popping the dialog.
    expect(queryEditorSource).toContain("if (options.bypassPicker || !settingsStore.editorSettings.showExecutionTargetPicker");
  });
});
