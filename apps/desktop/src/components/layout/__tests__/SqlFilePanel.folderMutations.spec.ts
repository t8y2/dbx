// @vitest-environment happy-dom

import { createApp, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  deleteSqlFolderInFolder: vi.fn(),
  forgetExternalSqlFolderTargets: vi.fn(),
}));

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
  listSqlFilesInFolder: vi.fn(async () => [{ name: "archive", path: "/sql/archive", is_dir: true, children: [] }]),
  deleteSqlFolderInFolder: mocks.deleteSqlFolderInFolder,
}));
vi.mock("@/lib/sql/externalSqlFileTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sql/externalSqlFileTarget")>()),
  forgetExternalSqlFolderTargets: mocks.forgetExternalSqlFolderTargets,
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  mocks.deleteSqlFolderInFolder.mockReset().mockRejectedValue(new Error("partial deletion"));
  mocks.forgetExternalSqlFolderTargets.mockReset();
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SQL file panel folder mutations", () => {
  it("clears persisted subtree targets when recursive deletion partially fails without open tabs", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(SqlFilePanel);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    mounted.push({ app, host });
    await vi.waitFor(() => expect(host.textContent).toContain("archive"));

    const folderRow = host.querySelector<HTMLElement>('[data-sql-file-path="/sql/archive"]')!;
    const rowButtons = folderRow.querySelectorAll<HTMLButtonElement>("button");
    rowButtons[rowButtons.length - 1].click();
    const dialog = await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
      expect(content).not.toBeNull();
      return content!;
    });
    const deleteButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(i18n.global.t("dangerDialog.deleteConfirm")))!;
    deleteButton.click();

    await vi.waitFor(() => expect(mocks.deleteSqlFolderInFolder).toHaveBeenCalledWith("/sql", "/sql/archive"));
    expect(mocks.forgetExternalSqlFolderTargets).toHaveBeenCalledWith("/sql/archive");
  });
});
