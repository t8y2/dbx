// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlFileEntry } from "@/lib/backend/api";
import { getSqlFileSortOrder, saveSqlFileSortOrder } from "@/lib/sql/sqlFileTreeFilter";
import { saveSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";
import { getSqlFileOrder, saveSqlFileOrder } from "@/lib/sqlFile/sqlFileOrder";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  open: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ tabs: [], activeTabId: "", openExternalSqlFile: mocks.open }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => undefined }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: {} }) }));
vi.mock("@/lib/backend/api", () => ({ listSqlFilesInFolder: mocks.list, readExternalSqlFileSnapshot: mocks.read }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

import SqlFilePanel from "../SqlFilePanel.vue";

function entry(path: string, children?: SqlFileEntry[]): SqlFileEntry {
  return { path, name: path.split("/").pop()!, is_dir: children !== undefined, children: children ?? [] };
}

const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function mountPanel() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(SqlFilePanel);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);
  mounted.push({ app, host });
  await vi.waitFor(() => expect(rootFileNames(host)).toHaveLength(3));
  return host;
}

function unmountPanels() {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
}

function row(host: HTMLElement, path: string) {
  const result = host.querySelector<HTMLElement>(`[data-sql-file-path="${path}"]`);
  expect(result).not.toBeNull();
  return result!;
}

function rootFileNames(host: HTMLElement) {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"))
    .map((item) => item.dataset.sqlFilePath!)
    .filter((path) => /^\/sql\/[^/]+\.sql$/.test(path))
    .map((path) => path.slice("/sql/".length));
}

async function beginDrag(host: HTMLElement, sourcePath: string, targetPath: string, position: "before" | "after" = "before") {
  const source = row(host, sourcePath);
  const target = row(host, targetPath);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ x: 0, y: 100, top: 100, bottom: 124, left: 0, right: 200, width: 200, height: 24, toJSON: () => ({}) });
  vi.spyOn(document, "elementFromPoint").mockReturnValue(target.querySelector(".truncate"));
  source.querySelector(".truncate")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 40, clientY: 20 }));
  const point = { clientX: 40, clientY: position === "before" ? 102 : 122 };
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, ...point }));
  await nextTick();
  return { source, target, point };
}

function releaseDrag(point: { clientX: number; clientY: number }) {
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, ...point }));
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  });
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([entry("/sql/sub", [entry("/sql/sub/child.sql")]), entry("/sql/c.sql"), entry("/sql/a.sql"), entry("/sql/b.sql")]);
  mocks.read.mockResolvedValue({ content: "SELECT 1", version: {} });
  saveSqlFileFolderPaths(["/sql"]);
});

afterEach(() => {
  unmountPanels();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SqlFilePanel drag sorting", () => {
  it.each([
    { mode: "default", source: "c.sql", initial: ["a.sql", "b.sql", "c.sql"], expected: ["a.sql", "c.sql", "b.sql"] },
    { mode: "desc", source: "a.sql", initial: ["c.sql", "b.sql", "a.sql"], expected: ["c.sql", "a.sql", "b.sql"] },
    { mode: "manual", source: "a.sql", initial: ["c.sql", "b.sql", "a.sql"], expected: ["c.sql", "a.sql", "b.sql"] },
  ] as const)("drags directly from $mode sorting and restores the result after reopening", async ({ mode, source, initial, expected }) => {
    if (mode !== "default") saveSqlFileSortOrder(mode);
    saveSqlFileOrder({ "/sql": ["/sql/c.sql", "/sql/hidden.txt", "/sql/b.sql", "/sql/a.sql"], "/other": ["/other/saved.sql"] });
    const host = await mountPanel();
    expect(rootFileNames(host)).toEqual(initial);

    const drag = await beginDrag(host, `/sql/${source}`, "/sql/b.sql");
    expect(drag.source.classList.contains("opacity-50")).toBe(true);
    expect(drag.target.querySelector(".border-t-2")).not.toBeNull();
    releaseDrag(drag.point);
    // Browsers can generate a click after the release; it must not open a file.
    drag.target.click();
    await nextTick();

    expect(rootFileNames(host)).toEqual(expected);
    expect(getSqlFileSortOrder()).toBe("manual");
    expect(host.querySelector("[data-sql-file-sort-btn]")?.getAttribute("aria-label")).toBe("sqlFileTree.sortManual");
    expect(getSqlFileOrder()["/sql"].filter((path) => path.endsWith(".sql"))).toEqual(expected.map((name) => `/sql/${name}`));
    expect(getSqlFileOrder()["/sql"]).toContain("/sql/hidden.txt");
    expect(getSqlFileOrder()["/other"]).toEqual(["/other/saved.sql"]);
    expect(mocks.read).not.toHaveBeenCalled();

    unmountPanels();
    expect(rootFileNames(await mountPanel())).toEqual(expected);
  });

  it("places a file after the target's lower half", async () => {
    const host = await mountPanel();
    const drag = await beginDrag(host, "/sql/a.sql", "/sql/c.sql", "after");
    expect(drag.target.querySelector(".border-b-2")).not.toBeNull();
    releaseDrag(drag.point);
    await nextTick();
    expect(rootFileNames(host)).toEqual(["b.sql", "c.sql", "a.sql"]);
  });

  it("keeps name sorting and ordinary file clicks when movement stays below the drag threshold", async () => {
    const host = await mountPanel();
    const source = row(host, "/sql/a.sql");
    source.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 40, clientY: 20 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1, clientX: 42, clientY: 22 }));
    releaseDrag({ clientX: 42, clientY: 22 });
    source.click();
    await nextTick();
    expect(mocks.read).toHaveBeenCalledOnce();
    expect(rootFileNames(host)).toEqual(["a.sql", "b.sql", "c.sql"]);
    expect(getSqlFileSortOrder()).toBe("asc");
    expect(getSqlFileOrder()).toEqual({});
  });

  it("cancels without changing sort preferences or opening a file on release", async () => {
    const host = await mountPanel();
    const drag = await beginDrag(host, "/sql/c.sql", "/sql/a.sql");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(drag.source.classList.contains("opacity-50")).toBe(false);
    expect(drag.target.querySelector(".border-t-2")).toBeNull();
    releaseDrag(drag.point);
    drag.target.click();
    await nextTick();
    expect(rootFileNames(host)).toEqual(["a.sql", "b.sql", "c.sql"]);
    expect(getSqlFileSortOrder()).toBe("asc");
    expect(getSqlFileOrder()).toEqual({});
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("rejects a drop onto a file in another directory", async () => {
    const host = await mountPanel();
    row(host, "/sql/sub").click();
    await nextTick();
    const drag = await beginDrag(host, "/sql/c.sql", "/sql/sub/child.sql");
    expect(drag.target.querySelector(".border-t-2")).toBeNull();
    releaseDrag(drag.point);
    await nextTick();
    expect(rootFileNames(host)).toEqual(["a.sql", "b.sql", "c.sql"]);
    expect(getSqlFileSortOrder()).toBe("asc");
    expect(getSqlFileOrder()).toEqual({});
  });

  it.each(["dbx-sql-file-manual-order", "dbx-sql-file-sort-order"])("keeps the previous order and reports a failure when saving %s fails", async (failedKey) => {
    const previous = { "/sql": ["/sql/c.sql", "/sql/b.sql", "/sql/a.sql"] };
    saveSqlFileOrder(previous);
    const host = await mountPanel();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === failedKey) throw new Error("storage unavailable");
      setItem(key, value);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const drag = await beginDrag(host, "/sql/c.sql", "/sql/a.sql");
    releaseDrag(drag.point);
    await nextTick();
    expect(rootFileNames(host)).toEqual(["a.sql", "b.sql", "c.sql"]);
    expect(getSqlFileSortOrder()).toBe("asc");
    expect(getSqlFileOrder()).toEqual(previous);
    expect(mocks.toast).toHaveBeenCalledWith("sqlFileTree.sortSaveFailed", 5000);
  });
});
