// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useQueryStore } from "@/stores/queryStore";

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "*.sql",
  getSqlFileFolderPaths: vi.fn(() => ["/sql"]),
  saveSqlFileFilter: vi.fn(),
  saveSqlFileFolderPaths: vi.fn(),
  notifySqlFileFoldersChanged: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listSqlFilesInFolder: vi.fn(async () => [
    { name: "nested", path: "/sql/nested", is_dir: true, children: [{ name: "deep", path: "/sql/nested/deep", is_dir: true, children: [{ name: "current.sql", path: "/sql/nested/deep/current.sql", is_dir: false, children: [] }] }] },
    { name: "other.sql", path: "/sql/other.sql", is_dir: false, children: [] },
  ]),
}));

import SqlFilePanel from "../SqlFilePanel.vue";
import { getSqlFileFolderPaths, saveSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";
import { listSqlFilesInFolder, type SqlFileEntry } from "@/lib/backend/api";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const scrollIntoView = vi.fn();

async function mountPanel(path?: string, options: { waitForLoad?: boolean; locateRequest?: { id: number; path: string } } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryStore = useQueryStore();
  if (path) queryStore.openExternalSqlFile("", "", path, "SELECT 1");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel, { locateRequest: options.locateRequest });
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  if (options.waitForLoad !== false) await vi.waitFor(() => expect(host.textContent).toContain("other.sql"));
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("sqlFileTree.locateActiveFile")}"]`);
  expect(button).not.toBeNull();
  return { app, host, button: button!, queryStore };
}

beforeEach(() => {
  vi.mocked(getSqlFileFolderPaths).mockReturnValue(["/sql"]);
  vi.mocked(saveSqlFileFolderPaths).mockClear();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
  scrollIntoView.mockClear();
});

describe("SQL file panel locate active file", () => {
  it("preserves every saved root when closed during the first scan", async () => {
    vi.mocked(getSqlFileFolderPaths).mockReturnValue(["/sql", "/second"]);
    let finishScan!: (entries: SqlFileEntry[]) => void;
    vi.mocked(listSqlFilesInFolder).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishScan = resolve;
        }),
    );
    const { app, host } = await mountPanel(undefined, { waitForLoad: false });
    expect(host.textContent).toContain("second");
    app.unmount();
    host.remove();
    mounted.splice(
      mounted.findIndex((item) => item.app === app),
      1,
    );
    finishScan([]);
    await nextTick();
    await nextTick();
    expect(saveSqlFileFolderPaths).not.toHaveBeenCalled();
    const reopened = await mountPanel();
    expect(reopened.host.textContent).toContain("second");
    expect(saveSqlFileFolderPaths).not.toHaveBeenCalled();
  });

  it("locates a requested DDL file after loading without switching the active query", async () => {
    vi.mocked(listSqlFilesInFolder).mockResolvedValueOnce([
      { name: "target.ddl", path: "/sql/target.ddl", is_dir: false, children: [] },
      { name: "other.sql", path: "/sql/other.sql", is_dir: false, children: [] },
    ]);
    const { host, queryStore } = await mountPanel("/sql/other.sql", { locateRequest: { id: 1, path: "/sql/target.ddl" } });
    const activeTabId = queryStore.activeTabId;
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/target.ddl"]')?.classList.contains("bg-accent")).toBe(true));
    expect(queryStore.activeTabId).toBe(activeTabId);
    expect(queryStore.tabs.find((tab) => tab.id === activeTabId)?.externalSqlPath).toBe("/sql/other.sql");
  });

  it("expands collapsed parents, highlights and scrolls without reopening the file", async () => {
    const { host, button, queryStore } = await mountPanel("/sql/nested/deep/current.sql");
    const openFile = vi.spyOn(queryStore, "openExternalSqlFile");
    const tabId = queryStore.activeTabId;
    const header = host.querySelector<HTMLElement>("[data-sql-file-row='true']")!;
    header.click();
    await nextTick();
    expect(host.textContent).not.toContain("current.sql");

    button.click();
    await nextTick();
    await nextTick();

    const row = host.querySelector<HTMLElement>('[data-sql-file-path="/sql/nested/deep/current.sql"]');
    expect(row).not.toBeNull();
    expect(row!.classList.contains("bg-accent")).toBe(true);
    expect(row!.parentElement!.parentElement!.style.display).not.toBe("none");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    const locateScrollIndex = scrollIntoView.mock.calls.findIndex(([options]) => options.block === "center");
    expect(scrollIntoView.mock.contexts[locateScrollIndex]).toBe(row);
    expect(openFile).not.toHaveBeenCalled();
    expect(queryStore.activeTabId).toBe(tabId);
  });

  it("follows the current tab and replaces the previous highlight", async () => {
    const { host, button, queryStore } = await mountPanel("/sql/nested/deep/current.sql");
    button.click();
    await nextTick();
    queryStore.openExternalSqlFile("", "", "/sql/other.sql", "SELECT 2");
    await nextTick();
    button.click();
    await nextTick();
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/other.sql"]')!.classList.contains("bg-accent")).toBe(true));
    expect(host.querySelector('[data-sql-file-path="/sql/nested/deep/current.sql"]')!.classList.contains("bg-accent")).toBe(false);
  });

  it.each([undefined, "/outside/current.sql"])("does not locate an unavailable file in the Web runtime: %s", async (path) => {
    const { button } = await mountPanel(path);
    expect(button.disabled).toBe(path === undefined);
    button.click();
    await nextTick();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("matches normalized path separators", async () => {
    const { host, button } = await mountPanel("\\sql\\nested\\deep\\current.sql");
    expect(button.disabled).toBe(false);
    button.click();
    await nextTick();
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/nested/deep/current.sql"]')?.classList.contains("bg-accent")).toBe(true));
  });

  it("disables locating after switching to an unsaved query", async () => {
    const { button, queryStore } = await mountPanel("/sql/other.sql");
    expect(button.disabled).toBe(false);
    queryStore.createTab("", "");
    await nextTick();
    expect(button.disabled).toBe(true);
  });
});
