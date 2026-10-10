// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import QueryEditorContextMenu, { type QueryEditorContextMenuActions, type QueryEditorContextMenuState } from "../QueryEditorContextMenu.vue";
import { DEFAULT_SHORTCUT_SETTINGS } from "@/lib/editor/shortcutRegistry";
import { createPinia } from "pinia";
import { DEFAULT_EDITOR_SETTINGS, useSettingsStore } from "@/stores/settingsStore";

vi.mock("@/lib/backend/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/backend/api")>()), loadEditorSettings: vi.fn(async () => DEFAULT_EDITOR_SETTINGS), saveEditorSettings: vi.fn(async () => undefined) }));

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function mountMenu(layout: "full" | "grouped" = "full") {
  const state = reactive<QueryEditorContextMenuState>({ readOnly: false, hideExecutionControls: false, databaseType: "mysql", selectedSql: "", executableSql: "", previewContextSql: "", contextObjectTarget: null, shortcuts: { ...DEFAULT_SHORTCUT_SETTINGS }, expandSelectStar: undefined });
  const actions = {
    executeFromContextMenu: vi.fn(),
    executeInNewResultTabFromContextMenu: vi.fn(),
    explainFromContextMenu: vi.fn(),
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
    toggleFoldFromContextMenu: vi.fn(),
    foldAllFromContextMenu: vi.fn(),
    unfoldAllFromContextMenu: vi.fn(),
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
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: { editor: { contextMenu: { exportQueryResultTo: "Export {format}" } } } }, missingWarn: false, fallbackWarn: false }));
  const pinia = createPinia();
  app.use(pinia);
  const settings = useSettingsStore(pinia);
  settings.editorSettings.sidebarMenuLayout = layout;
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
  return { state, actions, onClose, open, host, settings };
}

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.includes(label));
  expect(found, label).toBeDefined();
  return found!;
}

describe("QueryEditor extracted context menu", () => {
  it("keeps primary actions direct and groups clipboard, structure and result operations", async () => {
    const { state, actions, open } = mountMenu("grouped");
    state.selectedSql = "SELECT * FROM orders";
    state.executableSql = state.selectedSql;
    state.contextObjectTarget = { type: "table", name: "orders", database: "demo" };
    await open();
    const labels = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].map((entry) => entry.textContent!);
    expect(labels.indexOf("sidebarMenu.groups.structure")).toBeLessThan(labels.indexOf("sidebarMenu.groups.execution"));
    expect(labels.indexOf("sidebarMenu.groups.copy")).toBeLessThan(labels.indexOf("sidebarMenu.groups.execution"));
    expect(labels.some((label) => label.includes("editor.contextMenu.uppercaseSelection"))).toBe(true);
    button("sidebarMenu.groups.sqlEditor").click();
    await nextTick();
    button("editor.contextMenu.uppercaseSelection").click();
    expect(actions.convertSelectedSqlCase).toHaveBeenCalledExactlyOnceWith("upper");
    await open();
    button("sidebarMenu.groups.structure").click();
    await nextTick();
    button("contextMenu.editStructure").click();
    expect(actions.emitContextObjectAction).toHaveBeenCalledExactlyOnceWith("edit-table-structure");
  });

  it("updates the open menu when switching layouts without clearing the accepted target", async () => {
    const { state, open, onClose } = mountMenu("grouped");
    state.selectedSql = "SELECT * FROM orders";
    state.executableSql = state.selectedSql;
    state.contextObjectTarget = { type: "table", name: "orders", database: "demo" };
    await open();
    state.contextObjectTarget = null;
    button("sidebarMenu.useFull").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(onClose).not.toHaveBeenCalled();
    expect(button("sidebarMenu.useFull").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector("[data-dbx-context-menu]")?.textContent).not.toContain("sidebarMenu.customize");
    expect(button("contextMenu.editStructure").disabled).toBe(false);
    button("sidebarMenu.useFull").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(onClose).not.toHaveBeenCalled();
    expect(button("sidebarMenu.useFull").getAttribute("aria-pressed")).toBe("false");
    button("sidebarMenu.groups.structure").click();
    await nextTick();
    expect(button("contextMenu.editStructure").disabled).toBe(false);
  });

  it("recommends explain, uppercase, lowercase and screenshot while permitting opt-out", async () => {
    const { state, open, settings } = mountMenu("grouped");
    state.selectedSql = "SELECT 1";
    state.executableSql = state.selectedSql;
    await open();
    for (const label of ["toolbar.explainPlan", "editor.contextMenu.uppercaseSelection", "editor.contextMenu.lowercaseSelection", "editor.contextMenu.screenshotSelection"]) expect(button(label).disabled).toBe(false);
    settings.editorSettings.sidebarMenuHiddenPrimaryActions["sql-editor"] = ["editor.contextMenu.uppercaseSelection"];
    await open();
    expect([...document.querySelectorAll("[data-dbx-context-menu] button")].some((entry) => entry.textContent === "editor.contextMenu.uppercaseSelection")).toBe(false);
    button("sidebarMenu.groups.sqlEditor").click();
    await nextTick();
    expect(button("editor.contextMenu.uppercaseSelection").disabled).toBe(false);
  });

  it("promotes saved editor actions without changing the preferences of table menus", async () => {
    const { state, open, settings } = mountMenu("grouped");
    settings.editorSettings.sidebarMenuPinnedActions = { "sql-editor": ["editor.contextMenu.export"], table: ["contextMenu.exportData"] };
    state.executableSql = "SELECT 1";
    await open();
    button("editor.contextMenu.export").click();
    await nextTick();
    expect(button("CSV").disabled).toBe(false);
    expect(settings.editorSettings.sidebarMenuPinnedActions.table).toEqual(["contextMenu.exportData"]);
  });

  it("preserves disabled export guards when flattening the result submenu", async () => {
    const { open } = mountMenu("grouped");
    await open();
    button("sidebarMenu.groups.execution").click();
    await nextTick();
    expect(button("CSV").disabled).toBe(true);
  });
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
    ["toolbar.explainPlan", "explainFromContextMenu"],
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

  it("enables explain plan only when executable SQL exists and explain is permitted", async () => {
    const { state, actions, open } = mountMenu();
    await open();
    expect(button("toolbar.explainPlan").disabled).toBe(true);

    await open(() => {
      state.executableSql = "SELECT * FROM users";
    });
    expect(button("toolbar.explainPlan").disabled).toBe(false);
    button("toolbar.explainPlan").click();
    expect(actions.explainFromContextMenu).toHaveBeenCalledTimes(1);

    await open(() => {
      state.canExplain = false;
    });
    expect(button("toolbar.explainPlan").disabled).toBe(true);
  });

  it("dynamically switches format SQL label and enablement between selection and whole document", async () => {
    const { state, actions, open } = mountMenu();
    await open();
    expect(button("toolbar.formatSql").disabled).toBe(true);

    await open(() => {
      state.hasContent = true;
      state.executableSql = "SELECT 1";
    });
    expect(button("toolbar.formatSql").disabled).toBe(false);
    button("toolbar.formatSql").click();
    expect(actions.formatCurrentSql).toHaveBeenCalledTimes(1);

    await open(() => {
      state.selectedSql = "SELECT 1";
    });
    expect(button("editor.contextMenu.formatSelectionSql").disabled).toBe(false);
    button("editor.contextMenu.formatSelectionSql").click();
    expect(actions.formatCurrentSql).toHaveBeenCalledTimes(2);

    await open(() => {
      state.readOnly = true;
    });
    expect(button("editor.contextMenu.formatSelectionSql").disabled).toBe(true);
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

  it("routes folding actions from the folding submenu", async () => {
    const { actions, open } = mountMenu();
    await open();
    button("editor.contextMenu.folding").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextTick();
    button("editor.contextMenu.toggleFold").click();
    expect(actions.toggleFoldFromContextMenu).toHaveBeenCalledTimes(1);

    await open();
    button("editor.contextMenu.folding").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextTick();
    button("editor.contextMenu.foldAll").click();
    expect(actions.foldAllFromContextMenu).toHaveBeenCalledTimes(1);

    await open();
    button("editor.contextMenu.folding").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await nextTick();
    button("editor.contextMenu.unfoldAll").click();
    expect(actions.unfoldAllFromContextMenu).toHaveBeenCalledTimes(1);
  });
});
