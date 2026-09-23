// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import path from "node:path";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { describe, expect, it } from "vitest";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";

const source = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/QueryEditor.vue"), "utf8");

const menuSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/QueryEditorContextMenu.vue"), "utf8");

const documentSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/useQueryEditorDocumentState.ts"), "utf8");
const batchSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/useQueryEditorBatchSelection.ts"), "utf8");

const completionSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/useQueryEditorCompletion.ts"), "utf8");
const completionKeysSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/useQueryEditorCompletionKeys.ts"), "utf8");
const extensionsSource = readFileSync(path.resolve(process.cwd(), "apps/desktop/src/components/editor/queryEditorSqlExtensions.ts"), "utf8");

describe("QueryEditor context menu lifecycle", () => {
  it("keeps heavyweight context derivation out of the per-update path", () => {
    const updateStart = source.indexOf("EditorView.updateListener.of((update) => {");
    const updateEnd = source.indexOf("initializedRuntime.fontThemeComp.of(", updateStart);
    const updateSource = source.slice(updateStart, updateEnd);

    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateEnd).toBeGreaterThan(updateStart);
    expect(updateSource).toContain("syncEditorSelectionState(update.view);");
    expect(updateSource).toContain("schedulePreviewContextRefresh(update.view);");
    expect(updateSource).not.toContain("syncContextMenuState(update.view);");
  });

  it("does not suppress legitimate external model updates", () => {
    expect(source).not.toContain("lastEmittedModelValue");
    expect(documentSource).toContain("if (val !== currentEditorDocText(view.value)) {");
  });

  it("resynchronizes context state after restoring a tab document", () => {
    const activateStart = documentSource.indexOf("function activateTabDocument");
    const activateEnd = documentSource.indexOf("\n  watch([() => props.tabId", activateStart);
    const activateSource = documentSource.slice(activateStart, activateEnd);

    expect(activateStart).toBeGreaterThanOrEqual(0);
    expect(activateEnd).toBeGreaterThan(activateStart);
    expect(activateSource).toContain("syncContextMenuState(currentView);");
    expect(activateSource).toContain('emit("previewChangesAvailable", !!previewContextSql.value);');
  });

  it("guards deferred preview refresh against stale selection ranges", () => {
    expect(source).toContain("const expectedSelection = currentView.state.selection.main;");
    expect(source).toContain("currentSelection.from !== expectedSelection.from");
    expect(source).toContain("currentSelection.to !== expectedSelection.to");
  });

  it("resolves menu items after synchronizing the right-click target", () => {
    const syncStart = source.indexOf("function syncContextMenuStateAtEvent");
    const syncEnd = source.indexOf("\n}", syncStart);
    const syncSource = source.slice(syncStart, syncEnd);
    const syncIndex = source.indexOf("syncContextMenuStateAtEvent(view, e);");
    const openIndex = source.indexOf("onContextMenu(e);", syncIndex);
    const getterStart = menuSource.indexOf("function currentContextMenuItems()");
    const getterEnd = menuSource.indexOf("\n}", getterStart);
    const getterSource = menuSource.slice(getterStart, getterEnd);

    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncEnd).toBeGreaterThan(syncStart);
    expect(syncSource).toContain("if (pos == null)");
    expect(syncSource).toContain("contextObjectTarget.value = null;");
    expect(syncIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(syncIndex);
    expect(getterStart).toBeGreaterThanOrEqual(0);
    expect(getterEnd).toBeGreaterThan(getterStart);
    expect(getterSource).toContain("return contextMenuItems.value;");
    expect(getterSource).not.toContain("nextTick");
    expect(getterSource).not.toContain("setTimeout");
    expect(menuSource).toContain(':items="currentContextMenuItems"');
    expect(source).toContain(':get-state="getContextMenuState"');
    expect(menuSource).not.toContain('<CustomContextMenu :items="contextMenuItems"');
  });

  it("uses the target synchronized in the current context-menu event", async () => {
    const target = ref<string | null>(null);
    const openedTargets: string[] = [];
    const items = computed<ContextMenuItem[]>(() => [
      {
        label: target.value ? `Inspect ${target.value}` : "Inspect",
        disabled: !target.value,
        action: () => {
          if (target.value) openedTargets.push(target.value);
        },
      },
    ]);
    const root = defineComponent({
      setup() {
        const currentItems = () => items.value;
        const contextTarget = (id: string, value: string | null) =>
          h(
            "div",
            {
              id,
              onContextmenu: (event: MouseEvent) => {
                target.value = value;
                onContextMenu(event);
              },
            },
            id,
          );
        let onContextMenu = (_event: MouseEvent) => {};
        return () =>
          h(
            CustomContextMenu,
            { items: currentItems },
            {
              default: (slot: { onContextMenu: (event: MouseEvent) => void }) => {
                onContextMenu = slot.onContextMenu;
                return [contextTarget("table-a", "table_a"), contextTarget("table-b", "table_b"), contextTarget("empty", null)];
              },
            },
          );
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp(root);
    app.mount(container);

    const open = async (id: string) => {
      container.querySelector(`#${id}`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await nextTick();
      return document.querySelector<HTMLButtonElement>("[data-dbx-context-menu] button");
    };

    expect(await open("table-a")).toMatchObject({ disabled: false, textContent: "Inspect table_a" });
    expect(await open("table-a")).toMatchObject({ disabled: false, textContent: "Inspect table_a" });
    const tableBItem = await open("table-b");
    expect(tableBItem).toMatchObject({ disabled: false, textContent: "Inspect table_b" });
    tableBItem?.click();
    expect(openedTargets).toEqual(["table_b"]);
    expect(await open("empty")).toMatchObject({ disabled: true, textContent: "Inspect" });

    app.unmount();
    container.remove();
  });
});

describe("QueryEditor batch column selection", () => {
  it("keeps the confirmation action visible during pinyin filtering and supports keyboard toggling", () => {
    const bypassFilterStart = completionSource.indexOf("function completionItemsForBypassedFilter");
    const bypassFilterEnd = completionSource.indexOf("\n  }\n\n  function localCompletionDatabaseNames", bypassFilterStart);
    const bypassFilterSource = completionSource.slice(bypassFilterStart, bypassFilterEnd);

    expect(bypassFilterStart).toBeGreaterThanOrEqual(0);
    expect(bypassFilterEnd).toBeGreaterThan(bypassFilterStart);
    expect(bypassFilterSource).toContain("if (isBatchColumnSelectionAction(item)) return true;");
    expect(source).toContain('key: "Space"');
    expect(source).toContain("run: toggleSelectedBatchColumnSelection");
    expect(completionKeysSource).toContain("codeMirrorSelectedCompletion?.(view.state)");
  });

  it("applies checked columns directly through Enter and the completion Tab shortcut", () => {
    const handleEnterStart = completionKeysSource.indexOf("function handleEnter");
    const handleEnterEnd = completionKeysSource.indexOf("\n  }", handleEnterStart);
    const tabStart = completionKeysSource.indexOf("function acceptCompletionOrNextSnippetField");
    const tabEnd = completionKeysSource.indexOf("\n  }", tabStart);

    expect(batchSource).toContain("function applySelectedBatchColumnSelection");
    expect(completionKeysSource.slice(handleEnterStart, handleEnterEnd)).toContain("if (isBatchColumnSelectionCompletionActive(codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state) ?? null) && applySelectedBatchColumnSelection(view)) return true;");
    expect(completionKeysSource.slice(handleEnterStart, handleEnterEnd)).toContain("if (codeMirrorRuntime.codeMirrorAcceptCompletion?.(view)) return true;");
    expect(completionKeysSource.slice(tabStart, tabEnd)).toContain("if (isBatchColumnSelectionCompletionActive(completionStatus) && applySelectedBatchColumnSelection(view)) return true;");
    expect(extensionsSource).toContain("defaultKeymap: false");
    expect(source).toContain('{ key: "ArrowDown", run: (view) => moveCompletion(view, true) }');
    expect(source).toContain('{ key: "ArrowUp", run: (view) => moveCompletion(view, false) }');
  });

  it("marks the insertion action so the completion menu can keep it sticky", () => {
    expect(completionSource).toContain("dbxBatchColumnSelectionAction: { sessionKey: item.sessionKey, ...(item.batchColumnSelectionToggleAll ? { toggleAll: true as const } : {}) }");
    expect(extensionsSource).toContain('optionClass: (completion) => ((completion as QueryCompletionOption).dbxBatchColumnSelectionAction ? "cm-batch-column-selection-action" : "")');
  });

  it("updates the insertion count while a mouse selection is still in progress", () => {
    const dragUpdateStart = batchSource.indexOf("function updateBatchColumnSelectionAtPoint");
    const dragUpdateEnd = batchSource.indexOf("\n  }\n\n  const BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX", dragUpdateStart);

    expect(batchSource).toContain("function updateBatchColumnSelectionActionLabel");
    expect(batchSource.slice(dragUpdateStart, dragUpdateEnd)).toContain("updateBatchColumnSelectionActionLabel(state.view, state.sessionKey);");
    expect(batchSource).toContain("const batchColumnSelectionTooltipParents = new WeakMap<EditorViewType, HTMLElement>();");
    expect(batchSource).toContain("batchColumnSelectionTooltipParents.set(currentView, tooltipParent);");
    expect(batchSource).toContain("const batchColumnSelectionActionMarkers = new WeakMap<HTMLElement, { sessionKey: string; toggleAll: boolean }>();");
    expect(batchSource).toContain("!markerState || markerState.sessionKey !== sessionKey");
    expect(batchSource).toContain("renderBatchColumnSelectionActionMarker");
  });

  it("cancels stale scroll restoration before a new drag can begin", () => {
    const refreshStart = batchSource.indexOf("function scheduleBatchColumnSelectionRefresh");
    const refreshEnd = batchSource.indexOf("\n  }\n\n  function finishBatchColumnSelectionDrag", refreshStart);
    const dragStart = batchSource.indexOf("function startBatchColumnSelectionDrag");
    const dragEnd = batchSource.indexOf("\n  }\n\n  function renderBatchColumnSelectionCheckbox", dragStart);

    expect(batchSource).toContain("let batchColumnSelectionRefreshCleanup: (() => void) | null = null;");
    expect(batchSource.slice(refreshStart, refreshEnd)).toContain("cancelBatchColumnSelectionRefresh();");
    expect(batchSource.slice(dragStart, dragEnd)).toContain("cancelBatchColumnSelectionRefresh();");
    expect(batchSource).toContain("if (restoreStartTimer) window.clearTimeout(restoreStartTimer);");
  });

  it("only expands rendering for batch field selection", () => {
    expect(batchSource).toContain("function setBatchColumnSelectionExpandedRendering");
    expect(batchSource).toContain("setBatchColumnSelectionExpandedRendering(true);");
    expect(batchSource).toContain("setBatchColumnSelectionExpandedRendering(false);");
    expect(extensionsSource).toContain("maxRenderedOptions: batchSelection.expandedRendering ? Number.MAX_SAFE_INTEGER : 100,");
  });
});
