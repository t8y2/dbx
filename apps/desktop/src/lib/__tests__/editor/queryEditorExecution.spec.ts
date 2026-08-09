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
    const executeModeBranch = queryEditorSource.indexOf("executionCandidateForMode(candidates, settingsStore.editorSettings.executeMode)");

    expect(selectionBranch).toBeGreaterThan(-1);
    expect(executeModeBranch).toBeGreaterThan(selectionBranch);
  });

  it("does not fall back to all SQL when current mode has no statement at the cursor", () => {
    expect(queryEditorSource).toContain("const candidate = executionCandidateForMode(candidates, settingsStore.editorSettings.executeMode)");
    expect(queryEditorSource).toContain("if (!candidate) return true");
    expect(queryEditorSource).not.toContain("?? candidates[0]");
  });

  it("consumes the execution shortcut when the editor has no executable target", () => {
    expect(queryEditorSource).toContain("if (candidates.length === 0) return true");
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

describe("ContentArea execution summary errors", () => {
  it("keeps batch errors selectable and copyable without triggering statement navigation", () => {
    expect(contentAreaSource).toContain('class="absolute inset-0 z-0 cursor-pointer');
    expect(contentAreaSource).toContain('data-native-clipboard class="min-w-0 flex-1 cursor-text select-text truncate"');
    expect(contentAreaSource).toContain("@mousedown.stop @click.stop @dblclick.stop");
    expect(contentAreaSource).toContain('@click.stop="copyExecutionSummaryError(item.error)"');
    expect(contentAreaSource).toContain("await copyToClipboard(error)");
  });
});
