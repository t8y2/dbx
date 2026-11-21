// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SqlFileContentSearchResult } from "@/lib/backend/api";
import { useQueryStore } from "@/stores/queryStore";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  search: vi.fn(async (..._args: unknown[]): Promise<SqlFileContentSearchResult> => ({ files: [], skippedFiles: [], truncated: false })),
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
  searchSqlFileContents: mocks.search,
}));

vi.mock("@/components/ui/select", () => import("./sqlSearchTestUtils"));
import { changeSearchMode } from "./sqlSearchTestUtils";
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

function result(path: string, lines = [3], column = 8): SqlFileContentSearchResult {
  return {
    files: [
      {
        path,
        totalMatches: lines.length,
        matches: lines.map((lineNumber) => ({
          lineNumber,
          column,
          lineText: "SELECT needle FROM t",
          segments: [
            { text: "SELECT ", matched: false },
            { text: "needle", matched: true },
            { text: " FROM t", matched: false },
          ],
        })),
      },
    ],
    skippedFiles: [],
    truncated: false,
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.isTauri = true;
  mocks.search.mockReset();
  mocks.search.mockResolvedValue({ files: [], skippedFiles: [], truncated: false });
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
    mocks.search.mockResolvedValue(result("/sql/queries/02_orders.sql"));

    await changeSearchMode(host, "content");
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

    // Search uses the exact same file filter as the tree.
    expect(mocks.search).toHaveBeenCalledWith(["/sql"], "needle", "*.sql");
  });

  it("opens the file at the hit line and column when a snippet is clicked", async () => {
    const { host, queryStore } = await mountPanel();
    mocks.search.mockResolvedValue(result("/sql/queries/02_orders.sql"));
    const openExternalSqlFile = vi.spyOn(queryStore, "openExternalSqlFile");

    await changeSearchMode(host, "content");
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
    mocks.search.mockResolvedValue(result("/sql/queries/02_orders.sql", [1, 2, 3, 4, 5], 1));

    await changeSearchMode(host, "content");
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
    await changeSearchMode(host, "content");
    typeQuery(host, "n");
    typeQuery(host, "ne");
    typeQuery(host, "needle");

    expect(mocks.search).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));
    expect(mocks.search).toHaveBeenCalledWith(["/sql"], "needle", "*.sql");
  });

  it("discards results from a superseded query", async () => {
    const { host } = await mountPanel();
    let resolveFirst: ((matches: SqlFileContentSearchResult) => void) | undefined;
    mocks.search.mockImplementationOnce(
      () =>
        new Promise<SqlFileContentSearchResult>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mocks.search.mockResolvedValueOnce(result("/sql/migrations/01_init.sql", [2], 1));

    await changeSearchMode(host, "content");
    typeQuery(host, "needle");
    await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1));

    // Disk scans are serialized; the latest query waits for the in-flight scan.
    typeQuery(host, "other");
    await nextTick();
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).toBeNull();
    resolveFirst!(result("/sql/queries/02_orders.sql", [1], 1));
    await nextTick();
    await nextTick();
    // Invalidate on the first new keystroke, before the debounce commits "other".
    expect(host.querySelector("[data-sql-file-content-snippet]")).toBeNull();
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/migrations/01_init.sql"]')).not.toBeNull());

    // The late answer for "needle" must not widen the tree for "other".
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).toBeNull();
  });

  it("restores the full tree when the query is cleared", async () => {
    const { host } = await mountPanel();
    mocks.search.mockResolvedValue(result("/sql/queries/02_orders.sql", [1], 1));

    await changeSearchMode(host, "content");
    typeQuery(host, "needle");
    await vi.waitFor(() => expect(host.querySelector("[data-sql-file-content-snippet]")).not.toBeNull());

    host.querySelector<HTMLButtonElement>("button.absolute.right-1\\.5")!.click();
    await nextTick();

    const restored = Array.from(host.querySelectorAll<HTMLElement>("[data-sql-file-path]")).map((row) => row.querySelector(".truncate")?.textContent?.trim());
    expect(restored).toEqual(["migrations", "queries", "alpha.sql", "zebra.sql"]);
    expect(host.querySelector("[data-sql-file-content-snippet]")).toBeNull();
  });

  it("keeps the two scopes separate and removes content snippets on switching to names", async () => {
    const { host } = await mountPanel();
    typeQuery(host, "orders");
    await nextTick();
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).not.toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
    mocks.search.mockResolvedValue(result("/sql/alpha.sql"));
    await changeSearchMode(host, "content");
    await vi.waitFor(() => expect(host.querySelector('[data-sql-file-path="/sql/alpha.sql"]')).not.toBeNull());
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).toBeNull();
    await changeSearchMode(host, "name");
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).not.toBeNull();
    expect(host.querySelector("[data-sql-file-content-snippet]")).toBeNull();
  });

  it("reports a failed content search without silently matching names", async () => {
    const { host } = await mountPanel();
    mocks.search.mockRejectedValue(new Error("Search unavailable"));
    await changeSearchMode(host, "content");
    typeQuery(host, "orders");
    await vi.waitFor(() => expect(host.textContent).toContain("Search unavailable"));
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).toBeNull();
    expect(host.querySelector("[data-sql-file-empty-search]")).toBeNull();
  });

  it("defaults to name filtering without scanning, including outside the desktop runtime", async () => {
    mocks.isTauri = false;
    const { host } = await mountPanel();

    typeQuery(host, "orders");
    await nextTick();
    await nextTick();

    // Name matching still works instantly, and no backend search is attempted.
    expect(host.querySelector('[data-sql-file-path="/sql/queries/02_orders.sql"]')).not.toBeNull();
    expect(mocks.search).not.toHaveBeenCalled();
  });
});

it("remembers the file search mode independently of the SQL library", async () => {
  localStorage.setItem("dbx-sql-library-search-mode", "name");
  const first = await mountPanel();
  await changeSearchMode(first.host, "content");
  const mountedFirst = mounted.pop()!;
  mountedFirst.app.unmount();
  mountedFirst.host.remove();
  const second = await mountPanel();
  expect(second.host.querySelector<HTMLSelectElement>("[data-search-mode]")!.value).toBe("content");
  expect(localStorage.getItem("dbx-sql-library-search-mode")).toBe("name");
  expect(mocks.search).not.toHaveBeenCalled();
});
