import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createQueryEditorExecutionViewportOwnership, isQueryEditorPositionVisible } from "../../editor/queryEditorExecutionViewport";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../../../components/layout/ContentArea.vue", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
const sqlExecutionSource = readFileSync(new URL("../../../composables/useSqlExecution.ts", import.meta.url), "utf8");
const queryStoreSource = readFileSync(new URL("../../../stores/queryStore.ts", import.meta.url), "utf8");

describe("QueryEditor execution routing", () => {
  it("routes the execution shortcut through the shared execution-mode contract while bypassing the picker", () => {
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSql");
    expect(queryEditorSource).not.toContain("forceCurrent");
  });

  it("guards both CodeMirror execution bindings and the app-level fallback during IME composition", () => {
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSql");
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSqlInNewResultTab");
    expect(queryEditorSource).toContain("isEditorComposing");
    expect(queryEditorSource).toContain("function shouldBlockExecutionShortcut(event?: KeyboardEvent");
    expect(queryEditorSource).toContain("postCompositionKeyGuard.blocks(event)");
    expect(contentAreaSource).toContain("function shouldBlockQueryEditorExecutionShortcut(event: KeyboardEvent)");
    expect(contentAreaSource).toContain("queryEditorRef.value?.shouldBlockExecutionShortcut?.(event)");
    expect(appSource).toContain("if (!contentAreaRef.value?.shouldBlockQueryEditorExecutionShortcut?.(e)) requestActiveEditorExecuteInNewResultTab();");
    expect(appSource).toContain("if (!contentAreaRef.value?.shouldBlockQueryEditorExecutionShortcut?.(e)) requestActiveEditorExecute();");
  });

  it("keeps toolbar, context-menu, and gutter execution outside the shortcut guard", () => {
    expect(queryEditorSource).toContain("function executeFromContextMenu()");
    expect(queryEditorSource).toContain("requestExecute();\n  focusEditor();");
    expect(queryEditorSource).toContain("function executeSqlStatementFromGutter");
    expect(queryEditorSource).toContain("emitExecutionRequest({ ...sqlExecutionSnapshotForRange(currentView, statementRange), editorViewportRequestId })");
  });

  it("routes the new-result-tab shortcut through the same target selection contract", () => {
    expect(queryEditorSource).toContain("createQueryEditorExecutionShortcutBindings(shortcuts.executeSqlInNewResultTab");
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
    expect(queryEditorSource).toContain("const editorViewportRequestId = executionViewportOwnership.beginRequest()");
    expect(queryEditorSource).toContain("emitExecutionRequest({ ...sqlExecutionSnapshotForRange(currentView, statementRange), editorViewportRequestId })");
    expect(queryEditorSource).not.toContain('emit("execute", statementRange.sql)');
  });

  it("claims gutter viewport ownership only after the matching execution starts", () => {
    expect(appSource).toContain("acceptQueryEditorExecutionViewport(editorViewportRequestId)");
    expect(contentAreaSource).toContain("acceptGutterExecutionViewport(requestId)");
    expect(sqlExecutionSource).toContain("onExecutionStarted: () => deps.onExecutionStarted?.(options.editorViewportRequestId!)");
    expect(queryStoreSource.indexOf("tab.isExecuting = true")).toBeLessThan(queryStoreSource.indexOf("options?.onExecutionStarted?.()"));
  });

  it("tracks editor interaction while a query is executing", () => {
    expect(contentAreaSource).toContain("queryEditorRef.value?.beginExecutionViewportTracking()");
    expect(queryEditorSource).toContain('@wheel="recordExecutionViewportInteraction"');
    expect(queryEditorSource).toContain('@pointerdown="recordExecutionViewportInteraction"');
    expect(queryEditorSource).toContain("executionViewportOwnership.recordUserInteraction()");
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

  it("routes custom SQL shortcuts through selection-aware execution with dual keymap and DOM handlers", () => {
    expect(queryEditorSource).toContain("function runSqlShortcutAction(");
    expect(queryEditorSource).toContain("resolveSqlShortcutTemplate(action.sql, selected)");
    expect(queryEditorSource).toContain("enabledSqlShortcutActions(settingsStore.editorSettings.sqlShortcuts)");
    expect(queryEditorSource).toContain("isCharacterProducingShortcut(action.shortcut)");
    expect(queryEditorSource).toContain("createQueryEditorSqlShortcutDomHandler(");
    expect(queryEditorSource).toContain("shouldBlockExecutionShortcut(event, currentView)");
    expect(queryEditorSource).toContain("if (props.readOnly) return true;");
    expect(queryEditorSource).toContain("settingsStore.editorSettings.sqlShortcuts");
    expect(queryEditorSource).toContain("runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap))");
  });
});

describe("QueryEditor execution viewport ownership", () => {
  it("leaves completion positioning unclaimed when the user does not interact during execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.beginExecution();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("preserves the viewport once after user interaction during execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.beginExecution();
    ownership.recordUserInteraction();

    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("ignores editor interaction outside an active execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();

    ownership.recordUserInteraction();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("does not let a cancelled or early-returned gutter request affect the next ordinary execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const cancelledRequestId = ownership.beginRequest();

    ownership.cancelPendingRequest();

    expect(ownership.acceptRequest(cancelledRequestId)).toBe(false);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("preserves the viewport once for the matching accepted execution", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const requestId = ownership.beginRequest();

    expect(ownership.acceptRequest(requestId)).toBe(true);
    ownership.beginExecution();
    expect(ownership.consumeCompletionPreservation()).toBe(true);
    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("clears pending and accepted ownership when the editor becomes inactive", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    const pendingRequestId = ownership.beginRequest();
    ownership.reset();

    expect(ownership.acceptRequest(pendingRequestId)).toBe(false);

    const acceptedRequestId = ownership.beginRequest();
    expect(ownership.acceptRequest(acceptedRequestId)).toBe(true);
    ownership.reset();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });

  it("clears execution interaction when the editor becomes inactive", () => {
    const ownership = createQueryEditorExecutionViewportOwnership();
    ownership.beginExecution();
    ownership.recordUserInteraction();

    ownership.reset();

    expect(ownership.consumeCompletionPreservation()).toBe(false);
  });
});

describe("QueryEditor completion cursor visibility", () => {
  const viewport = { from: 10, to: 20 };

  it("treats a position inside a visible range as visible", () => {
    expect(isQueryEditorPositionVisible(15, [{ from: 10, to: 20 }], viewport)).toBe(true);
  });

  it("includes range endpoints but excludes adjacent positions", () => {
    expect(isQueryEditorPositionVisible(10, [{ from: 10, to: 20 }], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(20, [{ from: 10, to: 20 }], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(9, [{ from: 10, to: 20 }], viewport)).toBe(false);
    expect(isQueryEditorPositionVisible(21, [{ from: 10, to: 20 }], viewport)).toBe(false);
  });

  it("accepts any visible range without treating a folded gap as visible", () => {
    const visibleRanges = [
      { from: 10, to: 14 },
      { from: 17, to: 20 },
    ];

    expect(isQueryEditorPositionVisible(18, visibleRanges, viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(15, visibleRanges, viewport)).toBe(false);
  });

  it("falls back to the viewport when visible ranges are unavailable or empty", () => {
    expect(isQueryEditorPositionVisible(15, undefined, viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(15, [], viewport)).toBe(true);
    expect(isQueryEditorPositionVisible(21, undefined, viewport)).toBe(false);
  });

  it("checks visibility after completion ownership and before centering", () => {
    const ownershipCheck = queryEditorSource.indexOf("executionViewportOwnership.consumeCompletionPreservation()");
    const visibilityCheck = queryEditorSource.indexOf("if (isQueryEditorPositionVisible(pos, currentView.visibleRanges, currentView.viewport)) return");
    const centerScroll = queryEditorSource.indexOf('EditorView.scrollIntoView(pos, { y: "center" })');

    expect(ownershipCheck).toBeGreaterThan(-1);
    expect(visibilityCheck).toBeGreaterThan(ownershipCheck);
    expect(centerScroll).toBeGreaterThan(visibilityCheck);
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
