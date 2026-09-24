// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditorContextMenu, { type QueryEditorContextMenuActions, type QueryEditorContextMenuState } from "../QueryEditorContextMenu.vue";
import { DEFAULT_SHORTCUT_SETTINGS } from "@/lib/editor/shortcutRegistry";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function mountMenu() {
  const state = reactive<QueryEditorContextMenuState>({ readOnly: false, hideExecutionControls: false, databaseType: "mysql", selectedSql: "", executableSql: "", previewContextSql: "", contextObjectTarget: null, shortcuts: { ...DEFAULT_SHORTCUT_SETTINGS }, expandSelectStar: undefined });
  const actions = {
    executeFromContextMenu: vi.fn(),
    executeInNewResultTabFromContextMenu: vi.fn(),
    requestPreviewChanges: vi.fn(),
    exportQueryFromContextMenu: vi.fn(),
    toggleCommentFromContextMenu: vi.fn(),
    toggleBlockCommentFromContextMenu: vi.fn(),
    formatCurrentSql: vi.fn(),
    compressCurrentSql: vi.fn(),
    copySelectedSqlFromContextMenu: vi.fn(),
    copySelectedSqlAsRichTextFromContextMenu: vi.fn(),
    cutSelectedSqlFromContextMenu: vi.fn(),
    pasteClipboardSqlFromContextMenu: vi.fn(),
    convertSelectedSqlCase: vi.fn(),
    convertSelectedNamingStyle: vi.fn(),
    openDelimitedListDialog: vi.fn(),
    addNextSelectionOccurrenceFromContextMenu: vi.fn(),
    selectAllSelectionOccurrencesFromContextMenu: vi.fn(),
    openFindReplaceFromContextMenu: vi.fn(),
    deleteEmptyLines: vi.fn(),
    selectAllSqlFromContextMenu: vi.fn(),
    emitContextObjectAction: vi.fn(),
    openCodeSnapshot: vi.fn(),
    sendSelectionToAi: vi.fn(),
  } satisfies QueryEditorContextMenuActions;
  const onClose = vi.fn();
  let synchronize = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () =>
      h(
        QueryEditorContextMenu,
        { getState: () => ({ ...state }), actions, onClose },
        {
          default: ({ onContextMenu }: { onContextMenu: (event: MouseEvent) => void }) =>
            h("div", {
              "data-editor-host": "",
              onContextmenu: (event: MouseEvent) => {
                synchronize();
                onContextMenu(event);
              },
            }),
        },
      ),
  });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  const open = async (update = () => {}) => {
    synchronize = update;
    host.querySelector("[data-editor-host]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    await nextTick();
  };
  return { state, actions, onClose, open, host };
}

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.includes(label));
  expect(found, label).toBeDefined();
  return found!;
}

describe("QueryEditor extracted context menu", () => {
  it("routes the upstream table structure peek action through the extracted menu", async () => {
    const { state, actions, open } = mountMenu();
    state.contextObjectTarget = { name: "users", database: "demo", schema: "public", type: "table" };
    await open();
    expect(button("contextMenu.peekStructure").disabled).toBe(false);
    button("contextMenu.peekStructure").click();
    expect(actions.emitContextObjectAction).toHaveBeenCalledExactlyOnceWith("peek-table-structure");
  });

  it("reads freshly synchronized state before Vue flushes child props", async () => {
    const { state, open } = mountMenu();
    await open();
    expect(button("editor.contextMenu.executeCurrent").disabled).toBe(true);
    expect(button("editor.contextMenu.copySelection").disabled).toBe(true);
    await open(() => {
      state.selectedSql = "SELECT 1";
      state.executableSql = "SELECT 1";
    });
    expect(button("editor.contextMenu.executeSelection").disabled).toBe(false);
    expect(button("editor.contextMenu.copySelection").disabled).toBe(false);
    await open(() => {
      state.selectedSql = "";
      state.executableSql = "";
    });
    expect(button("editor.contextMenu.executeCurrent").disabled).toBe(true);
  });

  it("keeps whitespace copyable without treating it as executable SQL", async () => {
    const { state, open } = mountMenu();
    await open(() => {
      state.selectedSql = " \n ";
      state.executableSql = " \n ";
    });
    expect(button("editor.contextMenu.executeCurrent").disabled).toBe(true);
    expect(button("editor.contextMenu.copySelection").disabled).toBe(false);
  });

  it("keeps read-only and hidden-execution controls independent", async () => {
    const { state, open } = mountMenu();
    await open(() => {
      state.readOnly = true;
      state.hideExecutionControls = true;
      state.selectedSql = "SELECT 1";
    });
    expect(document.querySelector("[data-dbx-context-menu]")!.textContent).not.toContain("editor.contextMenu.executeSelection");
    for (const name of ["cutSelection", "pasteFromClipboard", "commentSelection", "blockCommentSelection", "formatSelectionSql", "compressSelectionSql", "delimitedList", "deleteEmptyLines"]) {
      expect(button(`editor.contextMenu.${name}`).disabled, name).toBe(true);
    }
    expect(button("editor.contextMenu.copySelection").disabled).toBe(false);
  });

  it.each(["redis", "mongodb"] as const)("preserves unsupported SQL controls for %s", async (databaseType) => {
    const { state, open } = mountMenu();
    await open(() => {
      state.databaseType = databaseType;
      state.selectedSql = "command";
    });
    expect(button("editor.contextMenu.blockCommentSelection").disabled).toBe(true);
    expect(button("editor.contextMenu.formatSelectionSql").disabled).toBe(databaseType === "redis");
  });

  it("retains the resolved star expansion after the menu close callback clears it", async () => {
    const { state, open, onClose } = mountMenu();
    const expand = vi.fn();
    onClose.mockImplementation(() => {
      state.expandSelectStar = undefined;
    });
    await open(() => {
      state.expandSelectStar = expand;
    });
    button("editor.contextMenu.expandSelectStar").click();
    await nextTick();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("reads the current preview SQL when invoking the action", async () => {
    const { state, actions, open } = mountMenu();
    state.previewContextSql = "UPDATE users SET name = 'before'";
    await open();
    state.previewContextSql = "UPDATE users SET name = 'after'";
    button("editor.previewChanges").click();
    expect(actions.requestPreviewChanges).toHaveBeenCalledExactlyOnceWith(state.previewContextSql);
  });

  it.each([
    ["editor.contextMenu.executeCurrent", "executeFromContextMenu"],
    ["settings.shortcutExecuteSqlInNewResultTab", "executeInNewResultTabFromContextMenu"],
    ["editor.contextMenu.screenshotSelection", "openCodeSnapshot"],
    ["editor.contextMenu.delimitedList", "openDelimitedListDialog"],
    ["editor.contextMenu.sendToAi", "sendSelectionToAi"],
    ["editor.contextMenu.findReplace", "openFindReplaceFromContextMenu"],
  ] as const)("forwards %s exactly once", async (label, action) => {
    const { state, actions, open } = mountMenu();
    state.selectedSql = "SELECT 1";
    state.executableSql = "SELECT 1";
    if (label.endsWith("executeCurrent")) state.selectedSql = "";
    await open();
    button(label).click();
    expect(actions[action]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["table", "contextMenu.editStructure", "edit-table-structure"],
    ["view", "contextMenu.editView", "edit-view"],
    ["materialized_view", "contextMenu.viewSource", "view-source"],
  ] as const)("keeps object routing for %s targets", async (type, label, action) => {
    const { state, actions, open } = mountMenu();
    await open(() => {
      state.contextObjectTarget = { type, name: "users", schema: "public", database: "db" };
    });
    button(label).click();
    expect(actions.emitContextObjectAction).toHaveBeenCalledExactlyOnceWith(action);
    await open(() => {
      state.contextObjectTarget = null;
    });
    expect(button("contextMenu.viewData").disabled).toBe(true);
  });
});
