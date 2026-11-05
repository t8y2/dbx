// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { cacheObjectBrowserRows, createObjectBrowserRowsCacheWriteToken, getCachedObjectBrowserRows, getCachedObjectBrowserRowsForScaffold, invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  listObjectStatistics: vi.fn(),
  ensureConnected: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: (...args: unknown[]) => mocks.listObjectStatistics(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: mocks.ensureConnected,
    tableNameFilterForScope: () => undefined,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarCopyTableNameSeparator: "newline",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.({ onContextMenu: () => undefined, isOpen: false });
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "pg-stale-statistics",
  name: "Postgres",
  db_type: "postgres",
  database: "pgdemo",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

const scope = { connectionId: connection.id, database: "pgdemo", schema: "public" };
const cachedRows: ObjectBrowserRow[] = [
  {
    id: "table:orders",
    name: "orders",
    displayName: "orders",
    type: "TABLE",
    schema: "public",
    estimatedRows: 0,
    totalBytes: 24_576,
  },
];

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.resetAllMocks();
  connection.db_type = "postgres";
  mocks.listObjects.mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
  mocks.listSchemas.mockResolvedValue(["public"]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.listObjectStatistics.mockResolvedValue([{ name: "orders", schema: "public", estimated_rows: 901, total_bytes: 196_608 }]);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  vi.useRealTimers();
});

async function mountBrowser(schema = ref("public"), database = ref("pgdemo")) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: database.value, schema: schema.value }) });
  mountedApps.push({ app, host });
  app.mount(host);
  return host;
}

function primeRowsCache(cachedAt: number) {
  cacheObjectBrowserRows(createObjectBrowserRowsCacheWriteToken(scope), cachedRows, { cachedAt });
}

describe("ObjectBrowser table statistics on a cached scaffold (#10461)", () => {
  it("ignores late statistics from the previous schema", async () => {
    let resolveOld!: (value: unknown[]) => void;
    const oldStatistics = new Promise<unknown[]>((resolve) => {
      resolveOld = resolve;
    });
    mocks.listSchemas.mockResolvedValue(["public", "other"]);
    mocks.listObjectStatistics.mockImplementation((_id, _database, schema) => (schema === "public" ? oldStatistics : Promise.resolve([{ name: "orders", schema: "other", estimated_rows: 22, total_bytes: 2048 }])));
    primeRowsCache(Date.now() - 31_000);
    const schema = ref("public");
    const host = await mountBrowser(schema);
    await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledWith(connection.id, "pgdemo", "public"));
    schema.value = "other";
    await vi.waitFor(() => expect(getCachedObjectBrowserRows({ ...scope, schema: "other" })?.[0]).toMatchObject({ estimatedRows: 22, totalBytes: 2048 }));
    resolveOld([{ name: "orders", schema: "public", estimated_rows: 999999, total_bytes: 999999 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedObjectBrowserRows({ ...scope, schema: "other" })?.[0]).toMatchObject({ estimatedRows: 22, totalBytes: 2048 });
    expect(host.textContent).not.toContain("999,999");
  });

  it.each([null, 0])("replaces stale statistics with %s without confusing unknown and zero", async (value) => {
    mocks.listObjectStatistics.mockResolvedValue([{ name: "orders", schema: "public", estimated_rows: value, total_bytes: value }]);
    primeRowsCache(Date.now() - 31_000);
    const host = await mountBrowser();
    await vi.waitFor(() => {
      expect(getCachedObjectBrowserRows(scope)?.[0]).toMatchObject({ estimatedRows: value, totalBytes: value });
    });
    expect(host.textContent).not.toContain("24 KB");
    if (value === 0) expect(host.textContent).toContain("0 B");
  });

  it("backfills row/size statistics when the restored scaffold is stale", async () => {
    primeRowsCache(Date.now() - 31_000);

    const host = await mountBrowser();

    // 行数/大小 随对象列表一起缓存，陈旧条目必须在后台补一次统计。
    await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledWith("pg-stale-statistics", "pgdemo", "public"));
    await vi.waitFor(() => expect(host.textContent).toContain("901"));
    expect(host.textContent).toContain("192 KB");
    // 陈旧缓存仍然直接渲染，且不重新拉对象列表。
    expect(mocks.listObjects).not.toHaveBeenCalled();
  });

  it("leaves a fresh scaffold alone so tab switches stay quiet", async () => {
    primeRowsCache(Date.now());

    const host = await mountBrowser();

    await vi.waitFor(() => expect(host.textContent).toContain("orders"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mocks.listObjectStatistics).not.toHaveBeenCalled();
    expect(mocks.listObjects).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mysqlScope = { ...scope, schema: "pgdemo" };
const names = [{ name: "orders", object_type: "TABLE", schema: "pgdemo" }];
const details = [{ ...names[0], comment: "order details" }];

function retryButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent?.includes("common.retry"));
}

describe("MySQL automatic progressive metadata", () => {
  beforeEach(() => {
    connection.db_type = "mysql";
    mocks.listObjectStatistics.mockResolvedValue([{ name: "orders", schema: "pgdemo", estimated_rows: 901, total_bytes: 196_608 }]);
  });

  it("shows names before details resolve, then automatically fills details and statistics", async () => {
    const pending = deferred<unknown[]>();
    mocks.listObjects.mockResolvedValueOnce(names).mockReturnValueOnce(pending.promise);
    const host = await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(host.textContent).toContain("orders");
    expect(host.textContent).not.toContain("objects.loadDetails");
    expect(host.textContent).not.toContain("objects.loading");
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ lightweight: true });
    expect(mocks.listObjects.mock.calls[1][10]).toEqual({ lightweight: false });
    expect(mocks.listObjectStatistics).not.toHaveBeenCalled();
    expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(false);
    pending.resolve(details);
    await vi.waitFor(() => expect(host.textContent).toContain("901"));
    expect(host.textContent).toContain("192 KB");
    expect(getCachedObjectBrowserRows(mysqlScope)?.[0].comment).toBe("order details");
    expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(true);
    expect(retryButton(host)).toBeUndefined();
  });

  it("shares both enumeration and automatic details across equivalent browsers", async () => {
    const enumeration = deferred<unknown[]>();
    const enrichment = deferred<unknown[]>();
    mocks.listObjects.mockReturnValueOnce(enumeration.promise).mockReturnValueOnce(enrichment.promise);
    const first = await mountBrowser();
    const second = await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(1));
    enumeration.resolve(names);
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    expect(first.textContent).toContain("orders");
    expect(second.textContent).toContain("orders");
    enrichment.resolve(details);
    await vi.waitFor(() => expect(first.textContent).toContain("901"));
    expect(second.textContent).toContain("901");
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
    expect(mocks.listObjectStatistics).toHaveBeenCalledTimes(1);
  });

  it.each(["details", "statistics"])("keeps names on %s failure and retries only when requested", async (stage) => {
    mocks.listObjects.mockResolvedValueOnce(names);
    if (stage === "details") mocks.listObjects.mockRejectedValueOnce(new Error("details unavailable"));
    else {
      mocks.listObjects.mockResolvedValueOnce(details);
      mocks.listObjectStatistics.mockRejectedValueOnce(new Error("statistics unavailable"));
    }
    const host = await mountBrowser();
    await vi.waitFor(() => expect(host.textContent).toContain(`${stage} unavailable`));
    expect(host.textContent).toContain("orders");
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
    expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(false);
    const retry = deferred<unknown[]>();
    mocks.listObjects.mockReturnValueOnce(retry.promise);
    retryButton(host)!.click();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(3));
    expect(mocks.listObjects.mock.calls[2][10]).toEqual({ lightweight: false });
    expect(host.textContent).toContain("orders");
    expect(retryButton(host)).toBeUndefined();
    retry.resolve(details);
    await vi.waitFor(() => expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(true));
    expect(host.textContent).not.toContain("unavailable");
  });

  it("resumes incomplete cached names after unmount without enumerating again", async () => {
    const enrichment = deferred<unknown[]>();
    mocks.listObjects.mockResolvedValueOnce(names).mockReturnValueOnce(enrichment.promise);
    await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    const first = mountedApps.shift()!;
    first.app.unmount();
    first.host.remove();
    const second = await mountBrowser();
    await vi.waitFor(() => expect(second.textContent).toContain("orders"));
    enrichment.resolve(details);
    await vi.waitFor(() => expect(second.textContent).toContain("901"));
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
  });

  it("explicit refresh starts new reads and ignores pre-refresh details", async () => {
    const oldDetails = deferred<unknown[]>();
    mocks.listObjects.mockResolvedValueOnce(names).mockReturnValueOnce(oldDetails.promise).mockResolvedValueOnce(names).mockResolvedValueOnce(details);
    const host = await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    (host.querySelector('button[title="grid.refresh (F5)"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(true));
    expect(mocks.listObjects).toHaveBeenCalledTimes(4);
    oldDetails.resolve([{ ...names[0], comment: "obsolete" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedObjectBrowserRows(mysqlScope)?.[0].comment).toBe("order details");
    expect(host.textContent).not.toContain("obsolete");
  });

  it("does not publish details or start statistics after unmount", async () => {
    const pending = deferred<unknown[]>();
    mocks.listObjects.mockResolvedValueOnce(names).mockReturnValueOnce(pending.promise);
    await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    const mounted = mountedApps.shift()!;
    mounted.app.unmount();
    mounted.host.remove();
    pending.resolve(details);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.listObjectStatistics).not.toHaveBeenCalled();
    expect(getCachedObjectBrowserRows(mysqlScope)?.[0].comment).toBeUndefined();
    expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(false);
  });

  it("does not re-query a complete fresh cache on remount", async () => {
    mocks.listObjects.mockResolvedValueOnce(names).mockResolvedValueOnce(details);
    await mountBrowser();
    await vi.waitFor(() => expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(true));
    const second = await mountBrowser();
    await vi.waitFor(() => expect(second.textContent).toContain("901"));
    expect(mocks.listObjects).toHaveBeenCalledTimes(2);
    expect(mocks.listObjectStatistics).toHaveBeenCalledTimes(1);
  });

  it("enriches stale cached membership without adding objects from the detail response", async () => {
    cacheObjectBrowserRows(createObjectBrowserRowsCacheWriteToken(mysqlScope), [{ ...cachedRows[0], id: "pgdemo:orders:TABLE:0", schema: "pgdemo" }], { cachedAt: Date.now() - 31_000 });
    mocks.listObjects.mockResolvedValue([...details, { name: "new_table", object_type: "TABLE", schema: "pgdemo" }]);
    const host = await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledTimes(1));
    expect(mocks.listObjects).toHaveBeenCalledTimes(1);
    expect(mocks.listObjects.mock.calls[0][10]).toEqual({ lightweight: false });
    expect(host.textContent).toContain("orders");
    expect(host.textContent).not.toContain("new_table");
  });

  it.each(["details", "statistics"])("ignores late %s after switching database", async (stage) => {
    const pending = deferred<unknown[]>();
    mocks.listObjects.mockImplementation((_id, database, ...args) => {
      if (database === "other") return Promise.resolve([{ name: "new_table", object_type: "TABLE", schema: "other" }]);
      return args[8]?.lightweight ? Promise.resolve(names) : stage === "details" ? pending.promise : Promise.resolve(details);
    });
    mocks.listObjectStatistics.mockImplementation((_id, database) => (database === "pgdemo" ? pending.promise : Promise.resolve([{ name: "new_table", schema: "other", estimated_rows: 22, total_bytes: 2048 }])));
    const database = ref("pgdemo");
    const host = await mountBrowser(ref("public"), database);
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    if (stage === "statistics") await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledTimes(1));
    database.value = "other";
    await vi.waitFor(() => expect(host.textContent).toContain("22"));
    pending.resolve(stage === "details" ? [{ ...names[0], comment: "obsolete" }] : [{ name: "orders", schema: "pgdemo", estimated_rows: 999999, total_bytes: 999999 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.textContent).toContain("new_table");
    expect(host.textContent).not.toContain("obsolete");
    expect(host.textContent).not.toContain("999,999");
    expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(false);
  });

  it.each(["details", "statistics"])("releases a locally timed-out %s read for retry and ignores its late response", async (stage) => {
    vi.useFakeTimers();
    const pending = deferred<unknown[]>();
    mocks.listObjects
      .mockResolvedValueOnce(names)
      .mockImplementationOnce(() => (stage === "details" ? pending.promise : Promise.resolve(details)))
      .mockResolvedValue(details);
    if (stage === "statistics") mocks.listObjectStatistics.mockReturnValueOnce(pending.promise);
    const host = await mountBrowser();
    await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalledTimes(2));
    if (stage === "statistics") await vi.waitFor(() => expect(mocks.listObjectStatistics).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(36_000);
    expect(host.textContent).toContain("timed out");
    expect(host.textContent).toContain("orders");
    retryButton(host)!.click();
    await vi.waitFor(() => expect(getCachedObjectBrowserRowsForScaffold(mysqlScope)?.detailsComplete).toBe(true));
    expect(mocks.listObjects).toHaveBeenCalledTimes(3);
    pending.resolve(stage === "details" ? [{ ...names[0], comment: "obsolete" }] : [{ name: "orders", schema: "pgdemo", estimated_rows: 999999, total_bytes: 999999 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.textContent).not.toContain("obsolete");
    expect(host.textContent).not.toContain("999,999");
    expect(getCachedObjectBrowserRows(mysqlScope)?.[0].comment).toBe("order details");
  });
});
