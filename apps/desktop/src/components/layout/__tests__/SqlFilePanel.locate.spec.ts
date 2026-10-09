// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useQueryStore } from "@/stores/queryStore";

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "*.sql",
  getSqlFileFolderPaths: () => ["/sql"],
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

const mounted: Array<{ app: App; host: HTMLElement }> = [];
const scrollIntoView = vi.fn();

async function mountPanel(path?: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryStore = useQueryStore();
  if (path) queryStore.openExternalSqlFile("", "", path, "SELECT 1");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await vi.waitFor(() => expect(host.textContent).toContain("other.sql"));
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("sidebar.locateActiveTab")}"]`);
  expect(button).not.toBeNull();
  return { host, button: button!, queryStore };
}

beforeEach(() => {
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
    expect(scrollIntoView.mock.contexts[0]).toBe(row);
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
    expect(host.querySelector('[data-sql-file-path="/sql/other.sql"]')!.classList.contains("bg-accent")).toBe(true);
    expect(host.querySelector('[data-sql-file-path="/sql/nested/deep/current.sql"]')!.classList.contains("bg-accent")).toBe(false);
  });

  it.each([undefined, "/outside/current.sql"])("disables locating when the active file is unavailable: %s", async (path) => {
    const { button } = await mountPanel(path);
    expect(button.disabled).toBe(true);
    button.click();
    await nextTick();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("matches normalized path separators", async () => {
    const { host, button } = await mountPanel("\\sql\\nested\\deep\\current.sql");
    expect(button.disabled).toBe(false);
    button.click();
    await nextTick();
    expect(host.querySelector('[data-sql-file-path="/sql/nested/deep/current.sql"]')!.classList.contains("bg-accent")).toBe(true);
  });

  it("disables locating after switching to an unsaved query", async () => {
    const { button, queryStore } = await mountPanel("/sql/other.sql");
    expect(button.disabled).toBe(false);
    queryStore.createTab("", "");
    await nextTick();
    expect(button.disabled).toBe(true);
  });
});
