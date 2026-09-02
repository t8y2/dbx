// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([
    { name: "existing_target", table_type: "TABLE" },
    { name: "archived_target", table_type: "TABLE" },
  ]),
  getColumns: vi.fn().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false },
    { name: "name", data_type: "TEXT", nullable: true },
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
  releaseTableImportSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => {
      if (id === "connection-1") return { id, name: "SQLite", db_type: "sqlite" };
      if (id === "postgres-1") return { id, name: "PostgreSQL", db_type: "postgres" };
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
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listDataTypes: mocks.listDataTypes,
  previewTableImportFile: mocks.previewTableImportFile,
  releaseTableImportSource: mocks.releaseTableImportSource,
  importTableFile: vi.fn(),
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
      setup(props, { emit }) {
        return () =>
          h(
            "select",
            {
              class: "existing-table-select-stub",
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

async function selectWorkbook() {
  const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  expect(fileInput).toBeTruthy();
  Object.defineProperty(fileInput, "files", {
    configurable: true,
    value: [new File(["test workbook"], "rows.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
  });
  fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(mocks.previewTableImportFile).toHaveBeenCalled());
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

function buttonContaining(text: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
}

beforeEach(() => {
  mocks.ensureConnected.mockReset().mockResolvedValue(undefined);
  mocks.listTables.mockReset().mockResolvedValue([
    { name: "existing_target", table_type: "TABLE" },
    { name: "archived_target", table_type: "TABLE" },
  ]);
  mocks.getColumns.mockReset().mockResolvedValue([
    { name: "id", data_type: "INTEGER", nullable: false },
    { name: "name", data_type: "TEXT", nullable: true },
  ]);
  mocks.listDataTypes.mockClear();
  mocks.previewTableImportFile.mockClear();
  mocks.releaseTableImportSource.mockClear();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog existing targets", () => {
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
});
