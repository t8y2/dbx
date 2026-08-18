import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createQueryEditorExecutionViewportOwnership } from "@/lib/editor/queryEditorExecutionViewport";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const sqlExecutionSource = readFileSync(new URL("../../../composables/useSqlExecution.ts", import.meta.url), "utf8");
const queryStoreSource = readFileSync(new URL("../../../stores/queryStore.ts", import.meta.url), "utf8");

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
    const executeModeBranch = queryEditorSource.indexOf("executionCandidateForMode(candidates, executeMode");

    expect(selectionBranch).toBeGreaterThan(-1);
    expect(executeModeBranch).toBeGreaterThan(selectionBranch);
  });

  it("uses the opt-in blank-line fallback and otherwise reports the missing cursor statement", () => {
    expect(queryEditorSource).toContain("executeAllOnBlankLine: settingsStore.editorSettings.executeAllOnBlankLine");
    expect(queryEditorSource).toContain('toast(t("editor.noExecutableStatementAtCursor"), 3000)');
    expect(queryEditorSource).not.toContain("?? candidates[0]");
  });

  it("consumes the execution shortcut and reports an empty current target", () => {
    expect(queryEditorSource).toContain("if (candidates.length === 0)");
    expect(queryEditorSource).toContain('if (executeMode === "current") toast(t("editor.noExecutableStatementAtCursor"), 3000)');
  });

  it("preserves the source range when executing a current/all candidate without a manual selection", () => {
    expect(queryEditorSource).toContain("emitExecutionRequest(sqlExecutionSnapshotForRange(currentView, candidate), options.openInNewResultTab)");
    expect(queryEditorSource).toContain("currentView ? sqlExecutionSnapshotForRange(currentView, candidate) : candidate.sql");
    expect(queryEditorSource).toContain("selectionFrom: range.from");
    expect(queryEditorSource).toContain("selectionTo: range.to");
  });

  it("preserves the source range when executing from the statement gutter", () => {
    expect(queryEditorSource).toContain("const editorViewportRequestId = gutterExecutionViewport.beginRequest()");
    expect(queryEditorSource).toContain("emitExecutionRequest({ ...sqlExecutionSnapshotForRange(currentView, statementRange), editorViewportRequestId })");
    expect(queryEditorSource).not.toContain('emit("execute", statementRange.sql)');
  });

  it("claims gutter viewport ownership only after the matching execution starts", () => {
    expect(appSource).toContain("acceptQueryEditorExecutionViewport(editorViewportRequestId)");
    expect(contentAreaSource).toContain("acceptGutterExecutionViewport(requestId)");
    expect(sqlExecutionSource).toContain("onExecutionStarted: () => deps.onExecutionStarted?.(options.editorViewportRequestId!)");
    expect(queryStoreSource.indexOf("tab.isExecuting = true")).toBeLessThan(queryStoreSource.indexOf("options?.onExecutionStarted?.()"));
  });

  it("lets the shortcut skip the picker without affecting other execution entry points", () => {
    // The picker guard must also honor the shortcut's bypass flag, otherwise Ctrl+Enter would keep popping the dialog.
    expect(queryEditorSource).toContain("if (options.bypassPicker || !settingsStore.editorSettings.showExecutionTargetPicker");
  });

  it("inserts a complete indented line below the current line", () => {
    expect(queryEditorSource).toContain('userEvent: "input.insertLineBelow"');
    expect(queryEditorSource).toContain("changes: { from: line.to, to: line.to, insert: insertion }");
    expect(queryEditorSource).toContain("const cursor = line.to + insertion.length");
    expect(queryEditorSource).not.toMatch(/key:\s*"Enter"[\s\S]{0,180}shift:\s*codeMirrorInsertNewlineKeepIndent/);
  });
});

describe("QueryEditor gutter execution viewport ownership", () => {
  it("does not let a cancelled or early-returned gutter request affect the next ordinary execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const cancelledRequestId = ownership.beginRequest();

    ownership.cancelPendingRequest();

    expect(ownership.acceptRequest(cancelledRequestId)).toBe(false);
    expect(ownership.consumeAcceptedRequest()).toBe(false);
  });

  it("preserves the viewport once for the matching accepted execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const requestId = ownership.beginRequest();

    expect(ownership.acceptRequest(requestId)).toBe(true);
    expect(ownership.consumeAcceptedRequest()).toBe(true);
    expect(ownership.consumeAcceptedRequest()).toBe(false);
  });

  it("clears pending and accepted ownership when the editor becomes inactive", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const pendingRequestId = ownership.beginRequest();
    ownership.reset();

    expect(ownership.acceptRequest(pendingRequestId)).toBe(false);

    const acceptedRequestId = ownership.beginRequest();
    expect(ownership.acceptRequest(acceptedRequestId)).toBe(true);
    ownership.reset();

    expect(ownership.consumeAcceptedRequest()).toBe(false);
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
