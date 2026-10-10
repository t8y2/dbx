// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportProgress, TableImportRequest, TableImportSummary } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["dbo", "sales", "analytics"]),
  listTables: vi.fn().mockResolvedValue([
    { name: "existing_target", table_type: "TABLE" },
    { name: "archived_target", table_type: "TABLE" },
  ]),
  getColumns: vi.fn().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true },
    { name: "name", data_type: "TEXT", nullable: true, is_primary_key: false },
  ]),
  listDataTypes: vi.fn().mockResolvedValue(["INTEGER", "TEXT"]),
  previewTableImportFile: vi.fn().mockResolvedValue({
    fileName: "rows.xlsx",
    filePath: "/tmp/rows.xlsx",
    fileType: "excel",
    sizeBytes: 24,
    columns: ["id", "name"],
    rows: [[1, "Alice"]],
    totalRows: 1,
    sourceFingerprint: "rows-xlsx",
    sheets: ["Data"],
  }),
  importTableFile: vi.fn<(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void) => Promise<TableImportSummary>>(),
  releaseTableImportSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => {
      if (id === "connection-1") return { id, name: "SQLite", db_type: "sqlite" };
      if (id === "postgres-1") return { id, name: "PostgreSQL", db_type: "postgres" };
      if (id === "sqlserver-1") return { id, name: "SQL Server", db_type: "sqlserver" };
      return undefined;
    },
    ensureConnected: mocks.ensureConnected,
    invalidateMetadataCache: vi.fn(),
    refreshObjectListTreeNode: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: {} }),
}));

vi.mock("@/lib/backend/api", () => ({
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listDataTypes: mocks.listDataTypes,
  previewTableImportFile: mocks.previewTableImportFile,
  releaseTableImportSource: mocks.releaseTableImportSource,
  importTableFile: mocks.importTableFile,
  cancelTableImport: vi.fn(),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { attrs, slots }) {
      return () => h("div", attrs, slots.default?.());
    },
  });
  return {
    Dialog: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogFooter: passthrough,
    DialogScrollContent: passthrough,
  };
});

vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      props: { disabled: Boolean },
      emits: ["click"],
      setup(props, { attrs, slots, emit }) {
        return () => h("button", { ...attrs, disabled: props.disabled, onClick: () => emit("click") }, slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: { modelValue: [String, Number], disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h("input", {
            ...attrs,
            value: props.modelValue,
            disabled: props.disabled,
            onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
          });
      },
    }),
  };
});

vi.mock("@/components/ui/label", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Label: defineComponent({
      setup(_props, { slots }) {
        return () => h("label", slots.default?.());
      },
    }),
  };
});

vi.mock("@/components/ui/select", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Select: passthrough,
    SelectContent: passthrough,
    SelectItem: passthrough,
    SelectTrigger: passthrough,
    SelectValue: passthrough,
  };
});

vi.mock("@/components/ui/searchable-select", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    SearchableSelect: defineComponent({
      props: {
        modelValue: { type: String, default: "" },
        options: { type: Array<string>, default: () => [] },
        disabled: Boolean,
      },
      emits: ["update:modelValue"],
      setup(props, { attrs, emit }) {
        return () =>
          h(
            "select",
            {
              ...attrs,
              class: attrs["data-testid"] === "target-schema-select" ? "existing-schema-select-stub" : "existing-table-select-stub",
              value: props.modelValue,
              disabled: props.disabled,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
            },
            [h("option", { value: "" }), ...(props.options as string[]).map((option) => h("option", { value: option }, option))],
          );
      },
    }),
  };
});

import TableImportDialog from "@/components/import/TableImportDialog.vue";

const mountedApps: App[] = [];

async function flushAsyncUpdates() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountDialog(
  options: {
    prefillTable?: string;
    connectionId?: string;
    database?: string;
    schema?: string;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(TableImportDialog, {
          open: true,
          prefillConnectionId: options.connectionId || "connection-1",
          prefillDatabase: options.database || "main",
          prefillSchema: options.schema,
          prefillTable: options.prefillTable,
        }),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushAsyncUpdates();
}

async function selectWorkbook(fileName = "rows.xlsx") {
  const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  expect(fileInput).toBeTruthy();
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [new File(["test workbook"], fileName)],
  });
  fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
  if (!mocks.previewTableImportFile.mock.calls.length) {
    buttonContaining("Load Preview")?.click();
  }
  await vi.waitFor(() => expect(mocks.previewTableImportFile).toHaveBeenCalled(), { timeout: 3000 });
  await flushAsyncUpdates();
}

async function selectExistingTarget(tableName: string) {
  const tableSelect = document.body.querySelector<HTMLSelectElement>("select.existing-table-select-stub");
  expect(tableSelect).toBeTruthy();
  if (tableSelect) {
    tableSelect.value = tableName;
    tableSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await nextTick();
}

async function selectSchemaTarget(schemaName: string) {
  const schemaSelect = document.body.querySelector<HTMLSelectElement>("select.existing-schema-select-stub");
  expect(schemaSelect).toBeTruthy();
  if (schemaSelect) {
    schemaSelect.value = schemaName;
    schemaSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await nextTick();
  await flushAsyncUpdates();
}

function buttonContaining(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
}

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.listSchemas.mockReset().mockResolvedValue(["dbo", "sales", "analytics"]);
  mocks.listTables.mockReset().mockResolvedValue([
    { name: "existing_target", table_type: "TABLE" },
    { name: "archived_target", table_type: "TABLE" },
  ]);
  mocks.getColumns.mockReset().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true },
    { name: "name", data_type: "TEXT", nullable: true, is_primary_key: false },
  ]);
  mocks.listDataTypes.mockClear();
  mocks.previewTableImportFile.mockClear();
  mocks.importTableFile.mockReset().mockImplementation(async (request, onProgress) => {
    onProgress({ importId: request.importId, status: "done", rowsImported: 1, totalRows: 1, elapsedMs: 1 });
    return { importId: request.importId, rowsImported: 1, totalRows: 1, elapsedMs: 1 };
  });
  mocks.releaseTableImportSource.mockClear();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog existing targets", () => {
  it.each(["rows.csv", "rows.tsv", "rows.txt", "rows.xlsx"])("maps headerless %s by ordinal position and imports a manual adjustment", async (fileName) => {
    i18n.global.locale.value = "en";
    await mountDialog({ prefillTable: "existing_target" });
    await selectWorkbook(fileName);

    mocks.previewTableImportFile.mockResolvedValueOnce({
      fileName,
      filePath: `/tmp/${fileName}`,
      fileType: fileName.endsWith("xlsx") ? "excel" : "csv",
      sizeBytes: 24,
      columns: ["column_1", "column_2", "column_3"],
      rows: [[1, "Alice", "extra"]],
      totalRows: 1,
      sourceFingerprint: "headerless",
    });
    const titleInput = [...document.body.querySelectorAll<HTMLInputElement>('input[type="number"]')].find((input) => input.parentElement?.textContent?.includes("Title row"));
    expect(titleInput).toBeTruthy();
    titleInput!.value = "0";
    titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.previewTableImportFile.mock.calls.at(-1)?.[1]).toMatchObject({ parseOptions: { titleRow: 0 } }));
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    const mappings = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(mappings.map((select) => select.value)).toEqual(["id", "name", "__skip__"]);

    mappings[1]!.value = "__skip__";
    mappings[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Start Import")?.click();
    await flushAsyncUpdates();
    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0]).toMatchObject({ parseOptions: { titleRow: 0 }, mappings: [{ sourceColumn: "column_1", targetColumn: "id" }] });
  });

  it("lets a database-level import choose an existing table and loads its columns", async () => {
    i18n.global.locale.value = "en";
    await mountDialog();

    expect(mocks.listTables).not.toHaveBeenCalled();
    await selectWorkbook();

    await vi.waitFor(() => {
      expect(mocks.listTables).toHaveBeenCalledWith("connection-1", "main", "main", undefined, undefined, undefined, ["TABLE"]);
    });

    const existingTableButton = buttonContaining("Existing table");
    expect(existingTableButton).toBeTruthy();
    expect(existingTableButton?.disabled).toBe(false);
    existingTableButton?.click();
    await flushAsyncUpdates();
    await selectExistingTarget("existing_target");

    await vi.waitFor(() => {
      expect(mocks.getColumns).toHaveBeenCalledWith("connection-1", "main", "main", "existing_target");
    });
    await vi.waitFor(() => expect(buttonContaining("Next")?.disabled).toBe(false));

    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    const mappings = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(mappings.map((select) => select.value)).toEqual(["id", "name"]);
    expect(mappings.map((select) => [...select.options].map((option) => option.value))).toEqual([
      ["__skip__", "id", "name"],
      ["__skip__", "id", "name"],
    ]);
  });

  it("waits for the selected table metadata and ignores an older table response", async () => {
    let resolveExisting!: (columns: Array<Record<string, unknown>>) => void;
    let resolveArchived!: (columns: Array<Record<string, unknown>>) => void;
    const existingColumns = new Promise<Array<Record<string, unknown>>>((resolve) => (resolveExisting = resolve));
    const archivedColumns = new Promise<Array<Record<string, unknown>>>((resolve) => (resolveArchived = resolve));
    mocks.getColumns.mockImplementation((_connectionId, _database, _schema, tableName) => (tableName === "existing_target" ? existingColumns : archivedColumns));

    i18n.global.locale.value = "en";
    await mountDialog({ schema: "main" });
    await selectWorkbook();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalled());
    buttonContaining("Existing table")?.click();
    await flushAsyncUpdates();

    await selectExistingTarget("existing_target");
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalledWith("connection-1", "main", "main", "existing_target"));
    expect(buttonContaining("Next")?.disabled).toBe(true);

    await selectExistingTarget("archived_target");
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalledWith("connection-1", "main", "main", "archived_target"));
    resolveArchived([{ name: "name", data_type: "TEXT", nullable: true }]);
    await flushAsyncUpdates();
    expect(buttonContaining("Next")?.disabled).toBe(false);

    resolveExisting([{ name: "id", data_type: "INTEGER", nullable: false }]);
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();

    const mappings = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(mappings.map((select) => select.value)).toEqual(["__skip__", "name"]);
    expect(mappings.every((select) => [...select.options].every((option) => option.value !== "id"))).toBe(true);
  });

  it("keeps navigation disabled when loading existing-table columns fails", async () => {
    mocks.getColumns.mockRejectedValueOnce(new Error("metadata unavailable"));
    i18n.global.locale.value = "en";
    await mountDialog({ schema: "main" });
    await selectWorkbook();
    await vi.waitFor(() => expect(mocks.listTables).toHaveBeenCalled());
    buttonContaining("Existing table")?.click();
    await flushAsyncUpdates();
    await selectExistingTarget("existing_target");

    await vi.waitFor(() => expect(document.body.textContent).toContain("metadata unavailable"));
    expect(buttonContaining("Next")?.disabled).toBe(true);
    expect(buttonContaining("Mapping")?.disabled).toBe(true);
  });

  it("uses the connection-aware default schema for a database-level import", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "postgres-1", database: "dbx_test" });
    await selectWorkbook();

    await vi.waitFor(() => {
      expect(mocks.listTables).toHaveBeenCalledWith("postgres-1", "dbx_test", "", undefined, undefined, undefined, ["TABLE"]);
    });
  });

  it("keeps a table-level import prefilled without loading the table list", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ prefillTable: "existing_target", schema: "main" });

    expect(mocks.listTables).not.toHaveBeenCalled();
    expect(mocks.getColumns).toHaveBeenCalledWith("connection-1", "main", "main", "existing_target");
  });

  it("offers update only with primary-key metadata and serializes the explicit policy", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ schema: "main" });
    await selectWorkbook();
    buttonContaining("Existing table")?.click();
    await flushAsyncUpdates();
    await selectExistingTarget("existing_target");
    await vi.waitFor(() => expect(buttonContaining("Next")?.disabled).toBe(false));

    const policySelect = document.body.querySelector<HTMLSelectElement>('[data-testid="table-import-conflict-policy"]');
    expect(policySelect).toBeTruthy();
    const updateOption = policySelect?.querySelector<HTMLOptionElement>('option[value="updateExisting"]');
    await vi.waitFor(() => expect(updateOption?.disabled, document.body.textContent || "").toBe(false));
    if (policySelect) {
      policySelect.value = "updateExisting";
      policySelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await flushAsyncUpdates();

    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Start Import")?.click();
    await flushAsyncUpdates();

    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0]).toMatchObject({
      conflictPolicy: "updateExisting",
      skipDuplicateRows: false,
      mappings: [
        { sourceColumn: "id", targetColumn: "id" },
        { sourceColumn: "name", targetColumn: "name" },
      ],
    });
  });

  it("disables update when target primary-key metadata is absent", async () => {
    mocks.getColumns.mockResolvedValueOnce([
      { name: "id", data_type: "INTEGER", nullable: false, is_primary_key: false },
      { name: "name", data_type: "TEXT", nullable: true, is_primary_key: false },
    ]);
    i18n.global.locale.value = "en";
    await mountDialog({ schema: "main" });
    await selectWorkbook();
    buttonContaining("Existing table")?.click();
    await flushAsyncUpdates();
    await selectExistingTarget("existing_target");
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalled());
    await flushAsyncUpdates();

    const updateOption = document.body.querySelector<HTMLOptionElement>('option[value="updateExisting"]');
    expect(updateOption?.disabled).toBe(true);
    expect(document.body.textContent).toContain("requires primary-key metadata");
  });

  it("allows selecting target schema on schema-aware databases and reloads tables", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "sqlserver-1", database: "mydb" });
    await selectWorkbook();

    await vi.waitFor(() => {
      expect(mocks.listSchemas).toHaveBeenCalledWith("sqlserver-1", "mydb");
      expect(mocks.listTables).toHaveBeenCalledWith("sqlserver-1", "mydb", "dbo", undefined, undefined, undefined, ["TABLE"]);
    });

    const schemaSelect = document.body.querySelector<HTMLSelectElement>("select.existing-schema-select-stub");
    expect(schemaSelect).toBeTruthy();
    expect(schemaSelect?.value).toBe("dbo");

    mocks.listTables.mockClear();
    mocks.listTables.mockResolvedValueOnce([{ name: "sales_orders", table_type: "TABLE" }]);

    await selectSchemaTarget("sales");

    await vi.waitFor(() => {
      expect(mocks.listTables).toHaveBeenCalledWith("sqlserver-1", "mydb", "sales", undefined, undefined, undefined, ["TABLE"]);
    });

    buttonContaining("Existing table")?.click();
    await flushAsyncUpdates();
    await selectExistingTarget("sales_orders");

    await vi.waitFor(() => {
      expect(mocks.getColumns).toHaveBeenCalledWith("sqlserver-1", "mydb", "sales", "sales_orders");
      expect(buttonContaining("Next")?.disabled).toBe(false);
    });

    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Start Import")?.click();
    await flushAsyncUpdates();

    expect(mocks.importTableFile).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "sqlserver-1",
        database: "mydb",
        schema: "sales",
        table: "sales_orders",
      }),
      expect.any(Function),
    );
  });

  it("uses the selected schema when creating a new table on a schema-aware database", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "sqlserver-1", database: "mydb" });
    await selectWorkbook();

    await vi.waitFor(() => expect(mocks.listSchemas).toHaveBeenCalledWith("sqlserver-1", "mydb"));

    await selectSchemaTarget("analytics");

    const tableNameInput = document.body.querySelector<HTMLInputElement>("input.font-mono");
    expect(tableNameInput).toBeTruthy();
    tableNameInput!.value = "analytics_summary";
    tableNameInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushAsyncUpdates();

    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Next")?.click();
    await flushAsyncUpdates();
    buttonContaining("Start Import")?.click();
    await flushAsyncUpdates();

    expect(mocks.importTableFile).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "sqlserver-1",
        database: "mydb",
        schema: "analytics",
        table: "analytics_summary",
        createTable: true,
      }),
      expect.any(Function),
    );
  });

  it("renders read-only schema when prefillTable is provided on schema-aware connection", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "sqlserver-1", database: "mydb", schema: "sales", prefillTable: "existing_target" });
    await selectWorkbook();

    expect(document.body.querySelector("select.existing-schema-select-stub")).toBeNull();
    expect(document.body.textContent).toContain("sales");
  });

  it("does not render schema selector for non-schema-aware connections", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "connection-1", database: "main" });
    await selectWorkbook();

    expect(document.body.querySelector("select.existing-schema-select-stub")).toBeNull();
  });

  it("does not repeat the database as schema in the target label", async () => {
    i18n.global.locale.value = "en";
    await mountDialog({ connectionId: "connection-1", database: "main", prefillTable: "existing_target" });
    await selectWorkbook();

    expect(document.body.textContent).toContain("SQLite / main / existing_target");
    expect(document.body.textContent).not.toContain("main / main");
  });

  it("defaults to position mapping when source column names do not match target table columns, and supports mapping actions", async () => {
    i18n.global.locale.value = "en";
    mocks.previewTableImportFile.mockResolvedValue({
      fileName: "unmatched.csv",
      filePath: "/tmp/unmatched.csv",
      fileType: "csv",
      sizeBytes: 24,
      columns: ["col_1", "col_2"],
      rows: [["1", "Alice"]],
      totalRows: 1,
      sourceFingerprint: "unmatched",
    });

    await mountDialog({ prefillTable: "existing_target" });
    await selectWorkbook("unmatched.csv");
    await vi.waitFor(() => expect(buttonContaining("Next")?.disabled).toBe(false));

    buttonContaining("Next")?.click();
    await flushAsyncUpdates();

    const selects = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(selects.map((s) => s.value)).toEqual(["id", "name"]);

    const skipAllBtn = document.body.querySelector<HTMLButtonElement>('button[data-action="skip-all"]');
    expect(skipAllBtn).toBeTruthy();
    skipAllBtn?.click();
    await flushAsyncUpdates();
    const skippedSelects = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(skippedSelects.map((s) => s.value)).toEqual(["__skip__", "__skip__"]);

    const mapByPositionBtn = document.body.querySelector<HTMLButtonElement>('button[data-action="map-by-position"]');
    expect(mapByPositionBtn).toBeTruthy();
    mapByPositionBtn?.click();
    await flushAsyncUpdates();
    const positionSelects = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(positionSelects.map((s) => s.value)).toEqual(["id", "name"]);

    const mapByNameBtn = document.body.querySelector<HTMLButtonElement>('button[data-action="map-by-name"]');
    expect(mapByNameBtn).toBeTruthy();
    mapByNameBtn?.click();
    await flushAsyncUpdates();
    const nameSelects = [...document.body.querySelectorAll<HTMLSelectElement>("select")];
    expect(nameSelects.map((s) => s.value)).toEqual(["__skip__", "__skip__"]);
  });
});
