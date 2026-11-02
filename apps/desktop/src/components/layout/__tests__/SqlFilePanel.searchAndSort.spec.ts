// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useQueryStore } from "@/stores/queryStore";

const mocks = vi.hoisted(() => ({
  savedSortOrder: "asc",
  saveSqlFileSortOrder: vi.fn((order: string) => {
    mocks.savedSortOrder = order;
    return true;
  }),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "*.sql",
  getSqlFileFolderPaths: () => ["/sql"],
  saveSqlFileFilter: vi.fn(),
  saveSqlFileFolderPaths: vi.fn(),
  notifySqlFileFoldersChanged: vi.fn(),
}));

vi.mock("@/lib/sql/sqlFileTreeFilter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sql/sqlFileTreeFilter")>();
  return {
    ...actual,
    getSqlFileSortOrder: () => mocks.savedSortOrder,
    saveSqlFileSortOrder: mocks.saveSqlFileSortOrder,
  };
});

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

const testEntries = [
  {
    name: "queries",
    path: "/sql/queries",
    is_dir: true,
    children: [
      { name: "01_find_user.sql", path: "/sql/queries/01_find_user.sql", is_dir: false, children: [] },
      { name: "02_orders.sql", path: "/sql/queries/02_orders.sql", is_dir: false, children: [] },
    ],
  },
  {
    name: "migrations",
    path: "/sql/migrations",
    is_dir: true,
    children: [{ name: "01_init.sql", path: "/sql/migrations/01_init.sql", is_dir: false, children: [] }],
  },
  { name: "zebra.sql", path: "/sql/zebra.sql", is_dir: false, children: [] },
  { name: "alpha.sql", path: "/sql/alpha.sql", is_dir: false, children: [] },
];

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  listSqlFilesInFolder: vi.fn(async () => JSON.parse(JSON.stringify(testEntries))),
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function mountPanel(activeFilePath?: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const queryStore = useQueryStore();
  if (activeFilePath) {
    queryStore.openExternalSqlFile("", "", activeFilePath, "SELECT 1");
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(SqlFilePanel);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await vi.waitFor(() => expect(host.textContent).toContain("alpha.sql"));
  return { host, queryStore };
}

beforeEach(() => {
  mocks.savedSortOrder = "asc";
  mocks.saveSqlFileSortOrder.mockClear();
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SqlFilePanel search and sort", () => {
  it("renders search input and sort button, sorts entries in ascending order initially", async () => {
    const { host } = await mountPanel();

    const searchInput = host.querySelector<HTMLInputElement>("input[data-sql-file-search]");
    expect(searchInput).not.toBeNull();

    const sortBtn = host.querySelector<HTMLButtonElement>("button[data-sql-file-sort-btn]");
    expect(sortBtn).not.toBeNull();

    // Check row order: directories (migrations, queries) then files (alpha.sql, zebra.sql)
    const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"));
    const renderedNames = rows.map((r) => r.querySelector(".truncate")?.textContent?.trim());
    expect(renderedNames).toEqual(["migrations", "queries", "alpha.sql", "zebra.sql"]);
  });

  it("selects asc and desc from the sort menu, updating rendered order and persisting", async () => {
    const { host } = await mountPanel();
    const sortBtn = host.querySelector<HTMLButtonElement>("button[data-sql-file-sort-btn]")!;

    async function selectSortOrder(order: "asc" | "desc") {
      sortBtn.click();
      const label = i18n.global.t(order === "asc" ? "sqlLibrary.sortNameAsc" : "sqlLibrary.sortNameDesc");
      // Dropdown content is teleported outside the mounted panel.
      const item = await vi.waitFor(() => {
        const menuId = sortBtn.getAttribute("aria-controls");
        const menu = menuId ? document.getElementById(menuId) : null;
        const option = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).find((entry) => entry.textContent?.trim() === label);
        expect(option).toBeDefined();
        return option!;
      });
      item.click();
      await vi.waitFor(() => expect(sortBtn.getAttribute("aria-expanded")).toBe("false"));
    }

    await selectSortOrder("desc");

    expect(mocks.saveSqlFileSortOrder).toHaveBeenLastCalledWith("desc");
    expect(mocks.savedSortOrder).toBe("desc");

    // Order should now be: queries, migrations, zebra.sql, alpha.sql
    let rows = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"));
    let renderedNames = rows.map((r) => r.querySelector(".truncate")?.textContent?.trim());
    expect(renderedNames).toEqual(["queries", "migrations", "zebra.sql", "alpha.sql"]);

    await selectSortOrder("asc");

    expect(mocks.saveSqlFileSortOrder).toHaveBeenLastCalledWith("asc");
    expect(mocks.savedSortOrder).toBe("asc");
    rows = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"));
    renderedNames = rows.map((r) => r.querySelector(".truncate")?.textContent?.trim());
    expect(renderedNames).toEqual(["migrations", "queries", "alpha.sql", "zebra.sql"]);
  });

  it("filters file tree by search query, auto-expands matching directories, and restores on clear", async () => {
    const { host } = await mountPanel();
    const searchInput = host.querySelector<HTMLInputElement>("input[data-sql-file-search]")!;

    // Type "user" into search input
    searchInput.value = "user";
    searchInput.dispatchEvent(new Event("input"));
    await nextTick();

    // Should auto-expand queries and display 01_find_user.sql
    const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"));
    const renderedNames = rows.map((r) => r.querySelector(".truncate")?.textContent?.trim());
    expect(renderedNames).toEqual(["queries", "01_find_user.sql"]);

    // Clear search using clear button
    const clearBtn = host.querySelector<HTMLButtonElement>("button.absolute.right-1\\.5")!;
    expect(clearBtn).not.toBeNull();
    clearBtn.click();
    await nextTick();

    // Reverted to full tree
    const restoredRows = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]"));
    const restoredNames = restoredRows.map((r) => r.querySelector(".truncate")?.textContent?.trim());
    expect(restoredNames).toEqual(["migrations", "queries", "alpha.sql", "zebra.sql"]);
  });

  it("shows empty search result message when no items match", async () => {
    const { host } = await mountPanel();
    const searchInput = host.querySelector<HTMLInputElement>("input[data-sql-file-search]")!;

    searchInput.value = "nonexistent_query";
    searchInput.dispatchEvent(new Event("input"));
    await nextTick();

    const emptyMsg = host.querySelector<HTMLElement>("[data-sql-file-empty-search]");
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg!.textContent?.trim()).toBe(i18n.global.t("grid.noSearchResults"));
  });

  it("clears search input when locating an active file that is currently filtered out", async () => {
    const { host } = await mountPanel("/sql/zebra.sql");
    const searchInput = host.querySelector<HTMLInputElement>("input[data-sql-file-search]")!;
    const locateBtn = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("sqlFileTree.locateActiveFile")}"]`)!;

    // Search for "user" so zebra.sql is hidden
    searchInput.value = "user";
    searchInput.dispatchEvent(new Event("input"));
    await nextTick();

    expect(host.textContent).not.toContain("zebra.sql");
    expect(searchInput.value).toBe("user");

    // Click locate button
    locateBtn.click();
    await nextTick();
    await nextTick();

    // Search should have been cleared and zebra.sql highlighted
    expect(searchInput.value).toBe("");
    expect(host.textContent).toContain("zebra.sql");
    const zebraRow = host.querySelector<HTMLElement>('[data-sql-file-path="/sql/zebra.sql"]');
    expect(zebraRow).not.toBeNull();
    await vi.waitFor(() => expect(zebraRow!.classList.contains("bg-accent")).toBe(true));
  });
});
