// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { GlobalSearchMatch } from "@/lib/backend/api";
import { useQueryStore } from "@/stores/queryStore";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  globalSearch: vi.fn(async (_request: unknown): Promise<GlobalSearchMatch[]> => []),
  readSnapshot: vi.fn(async () => ({ content: "SELECT 1;", version: { mtimeMs: 1, size: 9 } })),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", () => ({
  getSqlFileFilter: () => "*.sql",
  getSqlFileFolderPaths: () => ["/sql"],
  saveSqlFileFilter: vi.fn(),
  saveSqlFileFolderPaths: vi.fn(),
  notifySqlFileFoldersChanged: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.isTauri }));

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
  readExternalSqlFileSnapshot: mocks.readSnapshot,
  globalSearch: mocks.globalSearch,
}));

import SqlFilePanel from "../SqlFilePanel.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

async function mountPanel() {
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
  await vi.waitFor(() => expect(host.textContent).toContain("alpha.sql"));
  return { host, queryStore };
}

function typeQuery(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>("input[data-sql-file-search]")!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function hit(overrides: Partial<GlobalSearchMatch> & { path: string; line: number; column: number }): GlobalSearchMatch {
  return {
    fileName: overrides.path.split("/").pop() ?? overrides.path,
    matchText: "needle",
    lineText: "SELECT needle FROM t",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.isTauri = true;
  mocks.globalSearch.mockReset();
  mocks.globalSearch.mockResolvedValue([]);
  mocks.readSnapshot.mockClear();
});

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("SqlFilePanel content search", () => {
  it("shows content-only matches with their snippet and auto-expands the parent folder", async () => {
    const { host } = await mountPanel();
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/queries/02_orders.sql", line: 3, column: 8 })]);

    typeQuery(host, "needle");
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).not.toBeNull());

    // The folder name does not match "needle" but must be visible and expanded.
    expect(host.querySelector('[data-sql-file-path="/sql/queries"]')).not.toBeNull();
    expect(host.querySelector('[data-sql-file-path="/sql/alpha.sql"]')).toBeNull();

    const snippet = host.querySelector<HTMLElement>('[data-sql-file-content-snippet="/sql/queries/02_orders.sql"]');
    expect(snippet).not.toBeNull();
    expect(snippet!.textContent).toContain("L3");
    expect(snippet!.querySelector("mark")?.textContent).toBe("needle");

    // Content results must not be mistaken for "no results".
    expect(host.querySelector("[data-sql-file-empty-search]")).toBeNull();

    // The backend is asked for the panel's file set, ignore rules disabled, and
    // only as deep as the tree itself: fixture files sit at tree depth 1
    // (queries/01_find_user.sql, alpha.sql…), i.e. WalkBuilder depth 2.
    expect(mocks.globalSearch).toHaveBeenCalledWith(expect.objectContaining({ roots: ["/sql"], query: "needle", extensions: ["sql"], respectIgnoreRules: false, maxDepth: 2 }));
  });

  it("opens the file at the hit line and column when a snippet is clicked", async () => {
    const { host, queryStore } = await mountPanel();
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/queries/02_orders.sql", line: 3, column: 8 })]);
    const openExternalSqlFile = vi.spyOn(queryStore, "openExternalSqlFile");

    typeQuery(host, "needle");
    const snippetRow = await vi.waitFor(() => {
      const row = host.querySelector<HTMLElement>('[data-sql-file-content-snippet="/sql/queries/02_orders.sql"] .group\\/snippet');
      expect(row).not.toBeNull();
      return row!;
    });

    snippetRow.click();
    await vi.waitFor(() => expect(openExternalSqlFile).toHaveBeenCalledTimes(1));

    const args = openExternalSqlFile.mock.calls[0];
    expect(args[2]).toBe("/sql/queries/02_orders.sql");
    expect(args[7]).toEqual({ line: 3, column: 8 });

    // The clicked file becomes the active row, like the SQL library panel.
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')!.getAttribute("aria-current")).toBe("true"));
  });

  it("shows truncated snippets and expands to the full match list", async () => {
    const { host } = await mountPanel();
    mocks.globalSearch.mockResolvedValue([1, 2, 3, 4, 5].map((line) => hit({ path: "/sql/queries/02_orders.sql", line, column: 1 })));

    typeQuery(host, "needle");
    const snippet = await vi.waitFor(() => {
      const element = host.querySelector<HTMLElement>('[data-sql-file-content-snippet="/sql/queries/02_orders.sql"]');
      expect(element).not.toBeNull();
      return element!;
    });

    expect(snippet.querySelectorAll(".group\\/snippet")).toHaveLength(3);
    const moreButton = [...snippet.querySelectorAll("button")].find((button) => button.textContent?.includes("2"));
    expect(moreButton).toBeDefined();
    moreButton!.click();
    await nextTick();
    expect(snippet.querySelectorAll(".group\\/snippet")).toHaveLength(5);
  });

  it("debounces lookups so fast typing issues a single final request", async () => {
    const { host } = await mountPanel();
    typeQuery(host, "n");
    typeQuery(host, "ne");
    typeQuery(host, "needle");

    expect(mocks.globalSearch).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.globalSearch).toHaveBeenCalledTimes(1));
    expect(mocks.globalSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "needle" }));
  });

  it("discards results from a superseded query", async () => {
    const { host } = await mountPanel();
    let resolveFirst: ((matches: GlobalSearchMatch[]) => void) | undefined;
    mocks.globalSearch.mockImplementationOnce(
      () =>
        new Promise<GlobalSearchMatch[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mocks.globalSearch.mockResolvedValueOnce([hit({ path: "/sql/migrations/01_init.sql", line: 2, column: 1 })]);

    typeQuery(host, "needle");
    await vi.waitFor(() => expect(mocks.globalSearch).toHaveBeenCalledTimes(1));

    // Second query starts (and finishes) before the first response arrives.
    typeQuery(host, "other");
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/migrations/01_init.sql"]')).not.toBeNull());

    resolveFirst!([hit({ path: "/sql/queries/02_orders.sql", line: 1, column: 1 })]);
    await nextTick();
    await nextTick();

    // The late answer for "needle" must not widen the tree for "other".
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).toBeNull();
  });

  it("restores the full tree when the query is cleared", async () => {
    const { host } = await mountPanel();
    mocks.globalSearch.mockResolvedValue([hit({ path: "/sql/queries/02_orders.sql", line: 1, column: 1 })]);

    typeQuery(host, "needle");
    await vi.waitFor(() => expect(host.querySelector("[data-sql-file-content-snippet]")).not.toBeNull());

    host.querySelector<HTMLButtonElement>("button.absolute.right-1\\.5")!.click();
    await nextTick();

    const restored = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]")).map((row) => row.querySelector(".truncate")?.textContent?.trim());
    expect(restored).toEqual(["migrations", "queries", "alpha.sql", "zebra.sql"]);
    expect(host.querySelector("[data-sql-file-content-snippet]")).toBeNull();
  });

  it("degrades to name-only filtering outside the desktop runtime", async () => {
    mocks.isTauri = false;
    const { host } = await mountPanel();

    typeQuery(host, "orders");
    await nextTick();
    await nextTick();

    // Name matching still works instantly, and no backend search is attempted.
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).not.toBeNull();
    expect(mocks.globalSearch).not.toHaveBeenCalled();
  });
});
