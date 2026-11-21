// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SqlFileEntry } from "@/lib/backend/api";

const entries: SqlFileEntry[] = [
  {
    name: "dir1",
    path: "/sql/dir1",
    is_dir: true,
    children: [
      {
        name: "sub1.sql",
        path: "/sql/dir1/sub1.sql",
        is_dir: false,
        children: [],
      },
    ],
  },
  {
    name: "dir2",
    path: "/sql/dir2",
    is_dir: true,
    children: [
      {
        name: "sub2.sql",
        path: "/sql/dir2/sub2.sql",
        is_dir: false,
        children: [],
      },
    ],
  },
];

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
  listSqlFilesInFolder: vi.fn(async () => entries),
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function mountSqlFilePanel() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });

  // Wait for initial folder load
  await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/dir1"]')).not.toBeNull());
  return { host, app };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SqlFilePanel expanded directory state persistence (issue #13593)", () => {
  it("preserves expanded subdirectories across panel remounts", async () => {
    // 1st mount: opening panel
    const first = await mountSqlFilePanel();

    // Initially, sub1.sql is not rendered because dir1 is collapsed
    expect(first.host.querySelector('[data-sql-file-path="/sql/dir1/sub1.sql"]')).toBeNull();

    // Click on dir1 row to expand it
    const dir1Row = first.host.querySelector<HTMLElement>('[data-sql-file-path="/sql/dir1"]')!;
    dir1Row.click();
    await nextTick();

    // sub1.sql is now visible
    expect(first.host.querySelector('[data-sql-file-path="/sql/dir1/sub1.sql"]')).not.toBeNull();
    // dir2 remains collapsed
    expect(first.host.querySelector('[data-sql-file-path="/sql/dir2/sub2.sql"]')).toBeNull();

    // Unmount (simulating closing the panel)
    first.app.unmount();
    first.host.remove();
    mounted.length = 0;

    // 2nd mount (simulating reopening the panel)
    const second = await mountSqlFilePanel();

    // dir1 should STILL be expanded, so sub1.sql is immediately visible!
    expect(second.host.querySelector('[data-sql-file-path="/sql/dir1/sub1.sql"]')).not.toBeNull();
    // dir2 is still collapsed
    expect(second.host.querySelector('[data-sql-file-path="/sql/dir2/sub2.sql"]')).toBeNull();

    // Expand dir2 as well
    const dir2Row = second.host.querySelector<HTMLElement>('[data-sql-file-path="/sql/dir2"]')!;
    dir2Row.click();
    await nextTick();
    expect(second.host.querySelector('[data-sql-file-path="/sql/dir2/sub2.sql"]')).not.toBeNull();

    // Remount a 3rd time
    second.app.unmount();
    second.host.remove();
    mounted.length = 0;

    const third = await mountSqlFilePanel();
    expect(third.host.querySelector('[data-sql-file-path="/sql/dir1/sub1.sql"]')).not.toBeNull();
    expect(third.host.querySelector('[data-sql-file-path="/sql/dir2/sub2.sql"]')).not.toBeNull();
  });
});
