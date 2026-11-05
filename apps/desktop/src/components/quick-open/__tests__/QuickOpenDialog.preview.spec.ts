// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";

const mocks = vi.hoisted(() => ({ select: vi.fn(), updateOpen: vi.fn(), read: vi.fn(), write: vi.fn(), toast: vi.fn(), folders: [] as string[], listFiles: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [], treeNodes: [], connectedIds: new Set() }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({ allFiles: [] }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { shortcuts: {}, fontSize: 13, fontFamily: "monospace", theme: "app" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ editorFontTheme: () => [], loadEditorTheme: async () => [] }));
vi.mock("@/lib/backend/safeStorage", () => ({ safeLocalStorageGet: () => null, safeLocalStorageSet: vi.fn() }));
vi.mock("@/components/plugins/PluginIcon.vue", () => ({ default: { render: () => null } }));
vi.mock("@/lib/plugins/pluginCommandPalette", async () => {
  const { ref } = await import("vue");
  return { usePluginCommandPalette: () => ({ items: ref([]), refresh: vi.fn(), open: vi.fn() }) };
});
vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return { getSqlFileFolderPaths: () => mocks.folders, getSqlFileFilter: () => "*.sql", sqlFileFoldersVersion: ref(0) };
});
vi.mock("@/lib/globalSearch/globalSearchSettings", async () => {
  const { ref } = await import("vue");
  return { composeGlobalSearchRoots: () => ["/sql"], getGlobalSearchRoots: () => ["/sql"], getGlobalSearchExtensions: () => ["sql"], globalSearchSettingsVersion: ref(0), saveGlobalSearchRoots: vi.fn(), saveGlobalSearchExtensions: vi.fn() };
});
vi.mock("@/lib/backend/api", () => ({
  listPlugins: async () => [],
  listSqlFilesInFolder: mocks.listFiles,
  readExternalSqlFileSnapshot: async (...args: unknown[]) => ({ content: await mocks.read(...args), version: { contentHash: "original", modifiedNs: "1", sizeBytes: 26 }, encoding: "utf8" }),
  writeExternalSqlFile: mocks.write,
  globalSearch: async () => [
    { path: "/sql/first.sql", fileName: "first.sql", line: 2, column: 8, lineText: "SELECT needle;", matchText: "needle" },
    { path: "/sql/second.sql", fileName: "second.sql", line: 1, column: 8, lineText: "SELECT needle, 2;", matchText: "needle" },
  ],
}));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  const dialog = defineComponent({
    emits: ["update:open"],
    setup:
      (_, { slots, emit }) =>
      () =>
        h("div", [h("button", { "data-close-search": "", onClick: () => emit("update:open", false) }, "Close search"), slots.default?.()]),
  });
  return { Dialog: dialog, DialogContent: passthrough };
});

import QuickOpenDialog from "../QuickOpenDialog.vue";
import i18n from "@/i18n";

let app: App;
let host: HTMLElement;

async function mountSearch() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = reactive({ open: false, initialContentMode: true, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
  app = createApp({ render: () => h(QuickOpenDialog, props) });
  app.use(i18n);
  app.mount(host);
  props.open = true;
  await nextTick();
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = "needle";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(host.querySelectorAll("[data-selected]")).toHaveLength(2));
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 10000 });
  return { input, props, rows: [...host.querySelectorAll<HTMLElement>("[data-selected]")] };
}

beforeEach(() => {
  mocks.folders = [];
  mocks.listFiles.mockReset().mockResolvedValue([]);
  mocks.select.mockReset();
  mocks.updateOpen.mockReset();
  mocks.read.mockReset().mockResolvedValue("-- heading\nSELECT needle;");
  mocks.write.mockReset().mockResolvedValue({ kind: "written", version: { contentHash: "saved", modifiedNs: "2", sizeBytes: 30 } });
  mocks.toast.mockReset();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
});

describe("object search metadata regression", () => {
  it("removes false matches and opens the correct file after keyboard navigation", async () => {
    mocks.folders = ["/order-reports"];
    const firstName = "report-v2024-07-customer-order-detail-export.sql";
    const firstPath = `/order-reports/export/${firstName}`;
    const secondPath = "/order-reports/export/summary.sql";
    mocks.listFiles.mockResolvedValue([
      { name: firstName, path: firstPath, is_dir: false, children: [] },
      { name: "summary.sql", path: secondPath, is_dir: false, children: [] },
    ]);
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    const input = host.querySelector<HTMLInputElement>("input")!;
    async function search(query: string) {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
    }
    await vi.waitFor(() => expect(host.querySelectorAll("[data-selected]")).toHaveLength(2));
    await search("cordetxprep");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).not.toHaveBeenCalled();
    await search("cordetxp");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: firstPath, label: firstName }));
    mocks.select.mockClear();
    await search("ORDER-REPORTS");
    const rows = [...host.querySelectorAll<HTMLElement>("[data-selected]")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("summary.sql");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(rows[1].dataset.selected).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: firstPath }));
    await search("missing-file");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
    await search("summary");
    expect(host.querySelector('[data-selected="true"]')?.textContent).toContain("summary.sql");
  });
});

describe("content search preview navigation", () => {
  it("pins the preview while editing and resumes navigation after saving", async () => {
    const { input, rows, props } = await mountSearch();
    host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click();
    await nextTick();
    await nextTick();
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSELECT 3;" } });
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    rows[1]!.click();
    await nextTick();
    expect(input.disabled).toBe(true);
    expect(rows[0]!.dataset.selected).toBe("true");
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    props.initialContentMode = false;
    await nextTick();
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Save")!;
    save.click();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(mocks.write).toHaveBeenCalledWith("/sql/first.sql", "-- heading\nSELECT needle;\nSELECT 3;", expect.objectContaining({ expectedContentHash: "original" }));
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
  });

  it("keeps edits after a save error and allows closing after cancellation", async () => {
    mocks.write.mockRejectedValue(new Error("write failed"));
    await mountSearch();
    host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click();
    await nextTick();
    await nextTick();
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "my draft" } });
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Save")!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("my draft");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Cancel")!.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("-- heading\nSELECT needle;");
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("previews hovered results while keeping the dialog open", async () => {
    const { rows } = await mountSearch();
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    rows[0]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/first.sql", 32 * 1024 * 1024));
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("moves the preview with arrow keys and opens the selected file with Enter", async () => {
    const { input, rows } = await mountSearch();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(rows[1]!.dataset.selected).toBe("true");
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql", line: 1 }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("hides preview when changing modes", async () => {
    const { props } = await mountSearch();
    props.initialContentMode = false;
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBeNull();
  });

  // File-content search is not connection-scoped, so offering the picker there would be a
  // control that silently does nothing.
  it("shows the connection scope picker only in object mode", async () => {
    const { props } = await mountSearch();
    const scopeTitle = i18n.global.t("quickOpen.scope");
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(0);

    props.initialContentMode = false;
    await nextTick();
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(1);

    props.initialContentMode = true;
    await nextTick();
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(0);
  });

  it("preserves single-click opening a search result", async () => {
    const { rows } = await mountSearch();
    rows[1]!.click();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("navigates from preview focus, returns focus to search, and opens with Enter", async () => {
    const { input, rows } = await mountSearch();
    const preview = host.querySelector<HTMLElement>(".cm-content")!;
    preview.focus();
    preview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();
    expect(rows[1]!.dataset.selected).toBe("true");
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    await vi.waitFor(() => expect(host.querySelector(".cm-content")).not.toBeNull());
    const nextPreview = host.querySelector<HTMLElement>(".cm-content")!;
    nextPreview.focus();
    nextPreview.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("closes with Escape while the preview has focus", async () => {
    await mountSearch();
    const preview = host.querySelector<HTMLElement>(".cm-content")!;
    preview.focus();
    preview.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });
});
