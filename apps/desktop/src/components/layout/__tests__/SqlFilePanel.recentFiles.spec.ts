// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useQueryStore } from "@/stores/queryStore";
import { RECENT_SQL_FILES_STORAGE_KEY } from "@/lib/sql/recentSqlFiles";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listSqlFilesInFolder: vi.fn(async () => []),
  readExternalSqlFileSnapshot: vi.fn(async () => ({
    content: "SELECT 1",
    version: { size: 8, modifiedAt: 1 },
    encoding: "utf-8",
  })),
}));
vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "*.sql",
  getSqlFileFolderPaths: () => [],
  saveSqlFileFilter: vi.fn(),
  saveSqlFileFolderPaths: vi.fn(),
  notifySqlFileFoldersChanged: vi.fn(),
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

function mountPanel() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryStore = useQueryStore();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  return { host, queryStore };
}

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  localStorage.removeItem(RECENT_SQL_FILES_STORAGE_KEY);
});

describe("SQL file panel recent files", () => {
  it("shows persisted recent SQL files and reopens the selected file", async () => {
    localStorage.setItem(RECENT_SQL_FILES_STORAGE_KEY, JSON.stringify(["C:/work/query.sql"]));
    const { host, queryStore } = mountPanel();

    const recentFile = host.querySelector<HTMLButtonElement>("[data-recent-sql-file]");
    expect(recentFile?.textContent).toContain("query.sql");
    recentFile!.click();

    await vi.waitFor(() => expect(queryStore.tabs.some((tab) => tab.externalSqlPath === "C:/work/query.sql")).toBe(true));
    expect(queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId)?.externalSqlPath).toBe("C:/work/query.sql");
  });

  it("clears the persisted recent file list", async () => {
    localStorage.setItem(RECENT_SQL_FILES_STORAGE_KEY, JSON.stringify(["C:/work/query.sql"]));
    const { host } = mountPanel();

    host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("sqlFileTree.clearRecentFiles")}"]`)!.click();
    await nextTick();

    expect(localStorage.getItem(RECENT_SQL_FILES_STORAGE_KEY)).toBeNull();
    expect(host.querySelector("[data-recent-sql-file]")).toBeNull();
  });
});
