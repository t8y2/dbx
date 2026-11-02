// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  documentFindDocuments: vi.fn(),
  documentCountDocuments: vi.fn(),
  cancelQuery: vi.fn(),
  closeQuerySession: vi.fn(),
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  documentInsertDocument: vi.fn(),
  documentUpdateDocument: vi.fn(),
  documentDeleteDocument: vi.fn(),
  documentSaveMeilisearchBatch: vi.fn(),
}));

const dataGrid = vi.hoisted(() => ({
  reload: undefined as (() => Promise<void>) | undefined,
  rows: [] as unknown[],
  columns: [] as string[],
  captureExport: undefined as (() => ((progress?: unknown, control?: { signal: AbortSignal }) => Promise<unknown>) | undefined) | undefined,
}));

const settings = vi.hoisted(() => ({
  editorSettings: {
    pageSize: 2,
    tableOpenPageSize: 5,
    infiniteScroll: true,
    mongoViewMode: "table" as "document" | "table",
    columnWidthDensity: "standard" as "compact" | "standard" | "comfortable",
    dataGridRenderMode: "canvas" as "canvas" | "dom",
    tableFontFamily: "system-ui",
    tableFontSize: 12,
    numericColumnRightAlign: true,
    confirmDangerousSqlExecution: true,
    exportBatchSize: 2,
    exportRowLimitEnabled: false,
    exportRowLimit: 100_000,
  },
  updateEditorSettings: vi.fn(),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  getColumns: vi.fn(),
  documentFindDocuments: backend.documentFindDocuments,
  documentCountDocuments: backend.documentCountDocuments,
  dynamodbDescribeTable: vi.fn(),
  cancelQuery: backend.cancelQuery,
  closeQuerySession: backend.closeQuerySession,
  documentInsertDocument: backend.documentInsertDocument,
  documentUpdateDocument: backend.documentUpdateDocument,
  documentDeleteDocument: backend.documentDeleteDocument,
  documentSaveMeilisearchBatch: backend.documentSaveMeilisearchBatch,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ ensureConnected: backend.ensureConnected, getConfig: backend.getConfig }),
}));

vi.mock("@/stores/settingsStore", () => ({
  TABLE_FONT_SIZE_MIN: 8,
  TABLE_FONT_SIZE_MAX: 16,
  useSettingsStore: () => settings,
}));

vi.mock("@/components/grid/DataGrid.vue", () => {
  return {
    default: defineComponent({
      name: "DataGridStub",
      inheritAttrs: false,
      props: {
        result: { type: Object, required: true },
        customSaveHandler: { type: Object, required: false },
        pageOffset: { type: Number, required: false },
        pageLimit: { type: Number, required: false },
        pageSizePreference: { type: String, required: false },
        captureFullExportResult: { type: Function, required: false },
      },
      setup(props, { attrs, expose }) {
        dataGrid.reload = attrs.onReload as typeof dataGrid.reload;
        expose({
          visibleColumnCount: 0,
          displayableColumnCount: 0,
          hiddenColumnCount: 0,
          orderedColumnLayoutOptions: [],
          filteredColumnLayoutOptions: () => [],
          toggleColumnVisibility: vi.fn(),
          showAllColumns: vi.fn(),
          invertColumnVisibility: vi.fn(),
          hasCustomColumnOrder: false,
          moveDisplayableColumn: vi.fn(),
          resetColumnOrder: vi.fn(),
          nullColumnsHidden: false,
          canToggleAllNullColumns: false,
          allNullColumnCount: 0,
          toggleAllNullColumns: vi.fn(),
          multiRowTranspose: false,
          setMultiRowTranspose: vi.fn(),
          resetInfiniteScrollState: vi.fn(),
        });
        return () => {
          dataGrid.captureExport = props.captureFullExportResult as typeof dataGrid.captureExport;
          const result = props.result as { rows: unknown[]; columns?: string[] };
          dataGrid.rows = result.rows;
          dataGrid.columns = result.columns ?? [];
          return h("div", { "data-testid": "data-grid" });
        };
      },
    }),
  };
});

vi.mock("@/components/redis/RedisJsonEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { modelValue: { type: String, required: true } },
      setup(props) {
        return () => h("div", {}, props.modelValue);
      },
    }),
  };
});

vi.mock("@/components/ui/popover", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Popover: passthrough("PopoverStub"), PopoverTrigger: passthrough("PopoverTriggerStub"), PopoverContent: passthrough("PopoverContentStub") };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = (name: string) =>
    defineComponent({
      name,
      setup(_, { slots }) {
        return () => h("div", slots.default?.());
      },
    });
  return { Select: passthrough("SelectStub"), SelectContent: passthrough("SelectContentStub"), SelectItem: passthrough("SelectItemStub"), SelectTrigger: passthrough("SelectTriggerStub"), SelectValue: passthrough("SelectValueStub") };
});

import DocumentBrowser from "@/components/document/DocumentBrowser.vue";

let app: App<Element> | null = null;
let root: HTMLDivElement | null = null;

async function flushUi() {
  for (let index = 0; index < 4; index++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountBrowser(databaseType = "mongodb") {
  app = createApp(DocumentBrowser, {
    connectionId: "mongo-1",
    database: "test",
    collection: "docs",
    databaseType,
  });
  app.mount(root!);
  await flushUi();
}

function documentResult(start: number, count: number, total: number) {
  return {
    documents: Array.from({ length: count }, (_, index) => {
      const id = start + index;
      return { _id: String(id), name: `row_${id}` };
    }),
    total,
    total_is_exact: true,
  };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  backend.documentFindDocuments.mockReset();
  backend.documentCountDocuments.mockReset();
  backend.cancelQuery.mockReset();
  backend.closeQuerySession.mockReset().mockResolvedValue(undefined);
  backend.ensureConnected.mockReset();
  backend.documentInsertDocument.mockReset();
  backend.documentUpdateDocument.mockReset();
  backend.documentDeleteDocument.mockReset();
  backend.documentSaveMeilisearchBatch.mockReset();
  backend.ensureConnected.mockResolvedValue(undefined);
  backend.getConfig.mockReturnValue({ id: "mongo-1", name: "Mongo", db_type: "mongodb" });
  backend.documentCountDocuments.mockResolvedValue(0);
  dataGrid.reload = undefined;
  dataGrid.rows = [];
  dataGrid.columns = [];
  dataGrid.captureExport = undefined;

  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  app = null;
  root = null;
  vi.unstubAllGlobals();
});

describe("DocumentBrowser empty collection refresh entry (issue #8093)", () => {
  it("preserves Extended JSON across all captured Mongo export pages", async () => {
    backend.documentFindDocuments.mockResolvedValue(documentResult(1, 1, 1));
    await mountBrowser();
    const fetch = dataGrid.captureExport!()!;
    backend.documentFindDocuments.mockClear();
    const extended = [1, 2, 3].map((id) => ({ _id: { $oid: String(id).padStart(24, "0") }, value: { $numberLong: String(id) } }));
    backend.documentFindDocuments.mockResolvedValueOnce({ ...documentResult(1, 2, 3), extended_documents: extended.slice(0, 2) });
    backend.documentFindDocuments.mockResolvedValueOnce({ ...documentResult(3, 1, 3), extended_documents: extended.slice(2) });
    const result = (await fetch()) as { mongo_copy_documents: unknown[]; rows: unknown[]; has_more: boolean };
    expect(backend.documentFindDocuments).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(3);
    expect(result.mongo_copy_documents).toEqual(extended);
    expect(result.has_more).toBe(false);
    expect(backend.closeQuerySession).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("waits for captured Elasticsearch cursor cleanup (%s)", async (completion) => {
    backend.getConfig.mockReturnValue({ id: "mongo-1", name: "ES", db_type: "elasticsearch" });
    backend.documentFindDocuments.mockResolvedValue(documentResult(1, 1, 1));
    await mountBrowser("elasticsearch");
    const fetch = dataGrid.captureExport!()!;
    backend.documentFindDocuments.mockClear();
    backend.documentFindDocuments.mockResolvedValueOnce({ ...documentResult(1, 2, 3), next_cursor: "export-cursor" });
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(3, 1, 3));
    let close!: () => void;
    let fail!: (error: Error) => void;
    backend.closeQuerySession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          close = resolve;
          fail = reject;
        }),
    );
    let settled = false;
    const pending = fetch()
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(backend.closeQuerySession).toHaveBeenCalledWith("mongo-1", "test", "export-cursor"));
    expect(settled).toBe(false);
    if (completion === "resolve") close();
    else fail(new Error("cursor close reply lost"));
    const result = await pending;
    if (completion === "resolve") expect(result).toMatchObject({ rows: expect.any(Array), has_more: false });
    else expect(result).toMatchObject({ status: "unknown" });
  });

  it.each(["resolve", "reject"] as const)("waits for a captured document request after cancellation (%s)", async (completion) => {
    backend.documentFindDocuments.mockResolvedValue(documentResult(1, 1, 1));
    await mountBrowser();
    const fetch = dataGrid.captureExport!()!;
    backend.documentFindDocuments.mockClear();
    let resolveRead!: (value: unknown) => void;
    let rejectRead!: (error: Error) => void;
    backend.documentFindDocuments.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
    );
    const controller = new AbortController();
    const pending = fetch(undefined, { signal: controller.signal }).catch((error) => error);
    await vi.waitFor(() => expect(backend.documentFindDocuments).toHaveBeenCalledOnce());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    controller.abort();
    await flushUi();
    expect(settled).toBe(false);
    if (completion === "resolve") resolveRead(documentResult(1, 2, 4));
    else rejectRead(new Error("transport lost"));
    expect(await pending).toMatchObject({ status: completion === "resolve" ? "cancelled" : "unknown" });
    expect(backend.documentFindDocuments).toHaveBeenCalledOnce();
    expect(backend.cancelQuery).not.toHaveBeenCalled();
  });

  it("keeps a captured export bound to its original database and collection", async () => {
    backend.documentFindDocuments.mockResolvedValue(documentResult(1, 1, 1));
    const props = reactive({ connectionId: "mongo-1", database: "test", collection: "docs", databaseType: "mongodb" as const });
    app = createApp({ render: () => h(DocumentBrowser, props) });
    app.mount(root!);
    await flushUi();
    const fetch = dataGrid.captureExport!()!;
    props.database = "other";
    props.collection = "private_docs";
    await flushUi();
    backend.documentFindDocuments.mockClear();
    await fetch();
    expect(backend.documentFindDocuments).toHaveBeenCalledOnce();
    expect(backend.documentFindDocuments.mock.calls[0]!.slice(0, 3)).toEqual(["mongo-1", "test", "docs"]);
  });

  it("still reports non-empty columns for a collection that has never returned any document", async () => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 0, 0));

    await mountBrowser();

    // `DataGrid.vue` only renders its toolbar (and thus the refresh button)
    // when `result.columns.length > 0`. A collection that was empty from the
    // very first load must not leave that array empty forever.
    expect(dataGrid.rows).toHaveLength(0);
    expect(dataGrid.columns.length).toBeGreaterThan(0);
  });

  it("keeps reporting non-empty columns across a second empty reload of the same collection", async () => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 0, 0)).mockResolvedValueOnce(documentResult(1, 0, 0));

    await mountBrowser();
    expect(dataGrid.columns.length).toBeGreaterThan(0);

    await dataGrid.reload!();
    await flushUi();

    expect(dataGrid.rows).toHaveLength(0);
    expect(dataGrid.columns.length).toBeGreaterThan(0);
  });

  it("keeps the real columns (not the empty-collection fallback) after a collection that had data is emptied and reloaded", async () => {
    backend.documentFindDocuments.mockResolvedValueOnce(documentResult(1, 2, 2)).mockResolvedValueOnce(documentResult(1, 0, 0));

    await mountBrowser();
    expect(dataGrid.columns).toEqual(["_id", "name"]);

    await dataGrid.reload!();
    await flushUi();

    // Reproduces the reported "recovers only after closing and reopening the
    // tab" case: the columns learned while data existed must survive an
    // in-place reload that now returns zero rows.
    expect(dataGrid.rows).toHaveLength(0);
    expect(dataGrid.columns).toEqual(["_id", "name"]);
  });
});
