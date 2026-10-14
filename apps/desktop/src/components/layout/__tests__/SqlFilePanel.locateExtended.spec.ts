// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlFileEntry } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  query: { tabs: [] as Array<{ id: string; mode: string; externalSqlPath?: string }>, activeTabId: "" },
  list: vi.fn(),
  read: vi.fn(),
  toast: vi.fn(),
  desktop: true,
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks.query }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: {} }) }));
vi.mock("@/lib/backend/api", () => ({ listSqlFilesInFolder: mocks.list, readExternalSqlFileSnapshot: mocks.read }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import SqlFilePanel from "../SqlFilePanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_SQL_FILE_FILTER, getSqlFileFolderPaths, saveSqlFileFilter, saveSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";

function entry(path: string, children?: SqlFileEntry[]): SqlFileEntry {
  return { path, name: path.split(/[\\/]/).pop()!, is_dir: children !== undefined, children: children ?? [] };
}

const filePath = "C:/repo/sql/reports/current.sql";
const tree = [entry("C:/repo/sql", [entry("C:/repo/sql/reports", [entry(filePath)])])];
const apps: App[] = [];
const scroll = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

async function mount(paths = ["C:/repo"]) {
  saveSqlFileFolderPaths(paths);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(defineComponent({ setup: () => () => h(TooltipProvider, null, { default: () => h(SqlFilePanel) }) }));
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  apps.push(app);
  await vi.waitFor(() => expect(locateButton(host).disabled).toBe(!mocks.query.tabs.find((tab) => tab.id === mocks.query.activeTabId)?.externalSqlPath));
  return host;
}

function locateButton(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>("[data-sidebar-locate-button]");
  if (!button) throw new Error("Locate button was not rendered");
  return button;
}

function fileRow(host: HTMLElement, path = filePath) {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]")).find((row) => row.dataset.sqlFilePath === path);
}

async function locate(host: HTMLElement) {
  locateButton(host).click();
  await nextTick();
  await vi.waitFor(() => expect(locateButton(host).disabled).toBe(false));
  await nextTick();
}

describe("SQL file panel current file location", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.clearAllMocks();
    mocks.desktop = true;
    mocks.query = reactive({ tabs: [{ id: "current", mode: "query", externalSqlPath: filePath }], activeTabId: "current" });
    mocks.list.mockResolvedValue(tree);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  });

  afterEach(() => {
    for (const app of apps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  it("expands a collapsed root and all parents, selects and scrolls without reopening the file", async () => {
    const host = await mount();
    const root = host.querySelector<HTMLElement>("[data-sql-file-row]")!;
    root.click();
    await nextTick();
    expect(fileRow(host)).toBeUndefined();
    await locate(host);

    const row = fileRow(host)!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.closest<HTMLElement>("[style*='display: none']")).toBeNull();
    expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    expect(scroll.mock.contexts.at(-1)).toBe(row);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("uses the currently focused tab and replaces the previous selection", async () => {
    const otherPath = "C:/repo/other.sql";
    mocks.list.mockResolvedValue([...tree, entry(otherPath)]);
    const host = await mount();
    await locate(host);
    mocks.query.tabs.push({ id: "other", mode: "query", externalSqlPath: otherPath });
    mocks.query.activeTabId = "other";
    await nextTick();
    await locate(host);

    expect(fileRow(host)?.hasAttribute("aria-current")).toBe(false);
    expect(fileRow(host, otherPath)?.getAttribute("aria-current")).toBe("true");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["C:/outside/current.sql", "C:\\outside\\current.sql"])("matches Windows scan path %s and locates on the first click", async (scanPath) => {
    mocks.query.tabs[0].externalSqlPath = "C:\\outside\\current.sql";
    mocks.list.mockResolvedValue([entry(scanPath)]);
    const host = await mount([]);
    await locate(host);

    expect(mocks.list).toHaveBeenCalledWith("C:/outside/", DEFAULT_SQL_FILE_FILTER, true);
    expect(getSqlFileFolderPaths()).toEqual(["C:/outside/"]);
    const row = fileRow(host, scanPath)!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(scroll.mock.contexts.at(-1)).toBe(row);
  });

  it("refreshes a known folder to locate a newly added file without adding another root", async () => {
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce(tree);
    const host = await mount();
    await locate(host);

    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(getSqlFileFolderPaths()).toEqual(["C:/repo"]);
    expect(fileRow(host)?.getAttribute("aria-current")).toBe("true");
    expect(scroll.mock.contexts.at(-1)).toBe(fileRow(host));
  });

  it("keeps the file filter and reports hidden or missing files", async () => {
    saveSqlFileFilter("*.py");
    mocks.list.mockResolvedValue([]);
    const host = await mount();
    await locate(host);

    expect(mocks.list).toHaveBeenLastCalledWith("C:/repo", "*.py", true);
    expect(mocks.toast).toHaveBeenCalledWith("sqlFileTree.activeFileNotFound", 5000);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("reports refresh errors and releases the locate button", async () => {
    mocks.list.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("Folder unavailable"));
    const host = await mount();
    await locate(host);

    expect(mocks.toast).toHaveBeenCalledWith("sqlFileTree.loadFailed", 5000);
    expect(mocks.toast).not.toHaveBeenCalledWith("sqlFileTree.activeFileNotFound", 5000);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("disables location for unsaved queries and enables it when a file tab becomes active", async () => {
    mocks.query.tabs.push({ id: "unsaved", mode: "query" });
    mocks.query.activeTabId = "unsaved";
    const host = await mount([]);
    expect(locateButton(host).disabled).toBe(true);
    mocks.query.activeTabId = "current";
    await nextTick();
    expect(locateButton(host).disabled).toBe(false);
  });

  it("does not list local files from the Web runtime", async () => {
    mocks.desktop = false;
    const host = await mount([]);
    await locate(host);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("sqlFileTree.desktopOnly", 3000);
  });
});
