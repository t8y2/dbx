// @vitest-environment happy-dom

import { createApp, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  listSqlFilesInFolder: vi.fn(),
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
  listSqlFilesInFolder: mocks.listSqlFilesInFolder,
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const file = (name: string) => ({ name, path: `/sql/${name}`, is_dir: false, children: [] });

const mounted: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  mocks.listSqlFilesInFolder.mockReset();
  mocks.listSqlFilesInFolder.mockImplementation(async () => [file("a.sql")]);
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

async function mountPanel() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/a.sql"]')).not.toBeNull());
  return host;
}

describe("SQL file panel refresh keeps the list mounted", () => {
  // Regression for #13038: `loadFolderEntries` used to flip `folder.loading` on
  // for every re-scan, which swapped the row list for a "loading" line. The rows
  // live in the panel's only scroll container, so tearing them down reset
  // `scrollTop` and the panel jumped back to the top after every add/rename.
  it("reuses the existing rows while a folder re-scan is in flight", async () => {
    const host = await mountPanel();
    const firstRow = host.querySelector<HTMLElement>('[data-sql-file-path="/sql/a.sql"]')!;
    expect(mocks.listSqlFilesInFolder).toHaveBeenCalledTimes(1);

    // The refresh button is the first button in the sticky folder header.
    const header = host.querySelector<HTMLElement>(".sticky")!;
    const refreshButton = header.querySelectorAll<HTMLButtonElement>("button")[0];
    refreshButton.click();

    // Mid-flight the row list must still be on screen: the "loading" placeholder
    // may only replace rows for a folder that has never been scanned.
    await vi.waitFor(() => expect(mocks.listSqlFilesInFolder).toHaveBeenCalledTimes(2));
    expect(host.querySelector('[data-sql-file-path="/sql/a.sql"]')).toBe(firstRow);
    expect(firstRow.isConnected).toBe(true);

    mocks.listSqlFilesInFolder.mockImplementation(async () => [file("a.sql"), file("b.sql")]);
    refreshButton.click();
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/b.sql"]')).not.toBeNull());
    expect(host.querySelector('[data-sql-file-path="/sql/a.sql"]')).toBe(firstRow);
    expect(firstRow.isConnected).toBe(true);
  });

  it("still shows the loading placeholder for a folder that has never been scanned", async () => {
    // A never-resolving scan keeps the folder in its initial state, so the
    // placeholder must stay visible instead of flashing "no SQL files".
    mocks.listSqlFilesInFolder.mockImplementation(() => new Promise(() => {}));
    const pinia = createPinia();
    setActivePinia(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(SqlFilePanel);
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    mounted.push({ app, host });

    await vi.waitFor(() => expect(host.textContent).toContain(i18n.global.t("sqlFileTree.loading")));
    expect(host.textContent).not.toContain(i18n.global.t("sqlFileTree.noSqlFiles"));
    expect(host.querySelector('[data-sql-file-path="/sql/a.sql"]')).toBeNull();
  });
});
