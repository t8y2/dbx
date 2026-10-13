// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), updateOpen: vi.fn(), read: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [], treeNodes: [], connectedIds: new Set() }) }));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({ allFiles: [] }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { shortcuts: {}, fontSize: 13, fontFamily: "monospace", theme: "app" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ editorFontTheme: () => [], loadEditorTheme: async () => [] }));
vi.mock("@/lib/backend/safeStorage", () => ({ safeLocalStorageGet: () => null, safeLocalStorageSet: vi.fn() }));
vi.mock("@/components/plugins/PluginIcon.vue", () => ({ default: { render: () => null } }));
vi.mock("@/lib/plugins/pluginCommandPalette", async () => {
  const { ref } = await import("vue");
  return { usePluginCommandPalette: () => ({ items: ref([]), refresh: vi.fn(), open: vi.fn() }) };
});
vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return { getSqlFileFolderPaths: () => [], getSqlFileFilter: () => "*.sql", sqlFileFoldersVersion: ref(0) };
});
vi.mock("@/lib/globalSearch/globalSearchSettings", async () => {
  const { ref } = await import("vue");
  return { composeGlobalSearchRoots: () => ["/sql"], getGlobalSearchRoots: () => ["/sql"], getGlobalSearchExtensions: () => ["sql"], globalSearchSettingsVersion: ref(0), saveGlobalSearchRoots: vi.fn(), saveGlobalSearchExtensions: vi.fn() };
});
vi.mock("@/lib/backend/api", () => ({
  listPlugins: async () => [],
  readExternalSqlFile: mocks.read,
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
  return { Dialog: passthrough, DialogContent: passthrough };
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
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull());
  return { input, props, rows: [...host.querySelectorAll<HTMLElement>("[data-selected]")] };
}

beforeEach(() => {
  mocks.select.mockReset();
  mocks.updateOpen.mockReset();
  mocks.read.mockReset().mockResolvedValue("-- heading\nSELECT needle;");
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
});

describe("content search preview navigation", () => {
  it("previews clicked and hovered results while keeping the dialog open", async () => {
    const { rows } = await mountSearch();
    rows[1]!.click();
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

  it("opens a result with a double click and hides preview when changing modes", async () => {
    const { rows, props } = await mountSearch();
    rows[1]!.dispatchEvent(new MouseEvent("dblclick"));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
    props.initialContentMode = false;
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBeNull();
  });
});
