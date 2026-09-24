// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportPreview, TableImportRequest, TableImportProgress, TableImportSummary } from "@/lib/backend/api";

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
  previewTableImportFile: vi.fn(),
  importTableFile: vi.fn<(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void) => Promise<TableImportSummary>>(),
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
const sheets = ["First", "Second", "Third"];

function workbookPreview(sheetName: string): TableImportPreview {
  const index = sheets.indexOf(sheetName);
  return {
    fileName: "rows.xlsx",
    filePath: "/tmp/rows.xlsx",
    sourceRef: "workbook-source",
    fileType: "excel",
    sizeBytes: [10, 20, 30][index]!,
    columns: ["id", "name"],
    rows: [[index + 1, sheetName]],
    totalRows: [2, 3, 5][index]!,
    totalRowsExact: true,
    sourceFingerprint: `rows-${sheetName}`,
    sheets,
  };
}

async function flushAsyncUpdates() {
  for (let index = 0; index < 4; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountDialog(files = [new File(["workbook"], "rows.xlsx")]) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TableImportDialog, { open: true, prefillConnectionId: "connection-1", prefillDatabase: "main" }) }));
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await flushAsyncUpdates();
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

function button(text: string) {
  const result = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  expect(result, `button ${text}`).toBeTruthy();
  return result!;
}

function taskCheckbox(name: string) {
  const result = document.body.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="Import ${name}"]`);
  expect(result, `import selection for ${name}`).toBeTruthy();
  return result!;
}

async function selectTask(name: string, selected: boolean) {
  const checkbox = taskCheckbox(name);
  checkbox.checked = selected;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

async function click(text: string) {
  button(text).click();
  await flushAsyncUpdates();
}

async function editInputWithValue(value: string, replacement: string) {
  const input = [...document.body.querySelectorAll<HTMLInputElement>("input")].find((item) => item.value === value);
  expect(input, `input ${value}`).toBeTruthy();
  input!.value = replacement;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await flushAsyncUpdates();
}

async function startImport() {
  await click("Next");
  await click("Next");
  expect(button("Start Import").disabled).toBe(false);
  await click("Start Import");
}

beforeEach(() => {
  i18n.global.locale.value = "en";
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.previewTableImportFile.mockReset().mockImplementation((_source, options) => Promise.resolve(workbookPreview(options.parseOptions.sheetName || "First")));
  mocks.importTableFile.mockReset().mockImplementation(async (request, onProgress) => {
    const rowsImported = request.preparedSource!.totalRows;
    onProgress({ importId: request.importId, status: "done", phase: "done", rowsImported, totalRows: rowsImported, elapsedMs: 1 });
    return { importId: request.importId, rowsImported, totalRows: rowsImported, elapsedMs: 1 };
  });
  mocks.releaseTableImportSource.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog batch selection", () => {
  it("keeps every worksheet selected by default and imports them in workbook order", async () => {
    await mountDialog();
    for (const name of ["rows_First", "rows_Second", "rows_Third"]) expect(taskCheckbox(name).checked).toBe(true);
    await startImport();
    expect(mocks.importTableFile.mock.calls.map(([request]) => request.table)).toEqual(["rows_First", "rows_Second", "rows_Third"]);
    expect(mocks.importTableFile.mock.calls.map(([request]) => request.parseOptions?.sheetName)).toEqual([null, "Second", "Third"]);
  });

  it("imports only the selected worksheet even when the active preview is excluded", async () => {
    await mountDialog();
    await selectTask("rows_First", false);
    await selectTask("rows_Third", false);
    await startImport();
    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0]).toMatchObject({ table: "rows_Second", parseOptions: { sheetName: "Second" }, preparedSource: { rows: [[2, "Second"]] } });
    expect(mocks.releaseTableImportSource.mock.calls).toEqual([["workbook-source"]]);
  });

  it("blocks empty selection and lets selecting one item restore import", async () => {
    await mountDialog();
    for (const name of ["rows_First", "rows_Second", "rows_Third"]) await selectTask(name, false);
    expect(button("Next").disabled).toBe(true);
    const reviewStep = [...document.body.querySelectorAll<HTMLButtonElement>("nav button")].find((item) => item.textContent?.includes("Review"));
    expect(reviewStep?.disabled).toBe(true);
    expect(mocks.importTableFile).not.toHaveBeenCalled();
    await selectTask("rows_Third", true);
    await startImport();
    expect(mocks.importTableFile.mock.calls.map(([request]) => request.table)).toEqual(["rows_Third"]);
  });

  it("shows the actual worksheet name as read-only while switching batch previews", async () => {
    await mountDialog();
    const sheetInput = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Sheet"]');
    expect(sheetInput()?.value).toBe("First");
    expect(sheetInput()?.readOnly).toBe(true);
    await click("rows_Third");
    expect(sheetInput()?.value).toBe("Third");
  });

  it("preserves table names and mappings while an active task is excluded and reselected", async () => {
    await mountDialog();
    await editInputWithValue("rows_First", "custom_first");
    await click("Next");
    await editInputWithValue("name", "display_name");
    await selectTask("custom_first", false);
    await click("rows_Second");
    await click("custom_first");
    expect([...document.body.querySelectorAll<HTMLInputElement>("input")].some((input) => input.value === "display_name")).toBe(true);
    await selectTask("custom_first", true);
    await selectTask("rows_Second", false);
    await selectTask("rows_Third", false);
    await click("Next");
    await click("Start Import");
    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0]).toMatchObject({
      table: "custom_first",
      mappings: [
        { sourceColumn: "id", targetColumn: "id" },
        { sourceColumn: "name", targetColumn: "display_name" },
      ],
    });
  });

  it("ignores excluded invalid mappings but rejects invalid selected tasks", async () => {
    await mountDialog();
    await click("Next");
    await editInputWithValue("name", "id");
    expect(button("Next").disabled).toBe(true);
    await selectTask("rows_First", false);
    expect(button("Next").disabled).toBe(false);
    await click("Next");
    expect(button("Start Import").disabled).toBe(false);
    await selectTask("rows_First", true);
    expect(button("Start Import").disabled).toBe(true);
    await selectTask("rows_First", false);
    await click("Start Import");
    expect(mocks.importTableFile.mock.calls.map(([request]) => request.table)).toEqual(["rows_Second", "rows_Third"]);
  });

  it("checks duplicate target names only among selected tasks", async () => {
    await mountDialog();
    await editInputWithValue("rows_First", "rows_Second");
    expect(button("Next").disabled).toBe(true);
    await selectTask("rows_Second", false);
    await startImport();
    expect(mocks.importTableFile.mock.calls.map(([request]) => request.table)).toEqual(["rows_Second", "rows_Third"]);
  });

  it("disables the start button when the last item is deselected on the review step", async () => {
    await mountDialog();
    await selectTask("rows_First", false);
    await selectTask("rows_Third", false);
    await click("Next");
    await click("Next");
    await selectTask("rows_Second", false);
    expect(button("Start Import").disabled).toBe(true);
    button("Start Import").click();
    await flushAsyncUpdates();
    expect(mocks.importTableFile).not.toHaveBeenCalled();
    await selectTask("rows_Second", true);
    expect(button("Start Import").disabled).toBe(false);
  });

  it("counts only selected rows and keeps the batch running until its last selected task", async () => {
    const pending: Array<{ request: TableImportRequest; progress: (progress: TableImportProgress) => void; resolve: (summary: TableImportSummary) => void }> = [];
    mocks.previewTableImportFile.mockImplementation((_source, options) => {
      const preview = workbookPreview(options.parseOptions.sheetName || "First");
      if (options.parseOptions.sheetName === "Second") preview.totalRowsExact = false;
      return Promise.resolve(preview);
    });
    mocks.importTableFile.mockImplementation((request, progress) => new Promise((resolve) => pending.push({ request, progress, resolve })));
    await mountDialog();
    await selectTask("rows_Second", false);
    await startImport();
    expect(pending).toHaveLength(1);
    expect(taskCheckbox("rows_First").disabled).toBe(true);
    pending[0]!.progress({ importId: pending[0]!.request.importId, status: "done", phase: "done", rowsImported: 2, totalRows: 2, elapsedMs: 1 });
    await flushAsyncUpdates();
    expect(document.body.textContent).toContain("2 / 7");
    expect(document.body.textContent).not.toContain("Import complete");
    pending[0]!.resolve({ importId: pending[0]!.request.importId, rowsImported: 2, totalRows: 2, elapsedMs: 1 });
    await flushAsyncUpdates();
    expect(pending[1]!.request.table).toBe("rows_Third");
    pending[1]!.resolve({ importId: pending[1]!.request.importId, rowsImported: 5, totalRows: 5, elapsedMs: 1 });
    await flushAsyncUpdates();
    expect(document.body.textContent).toContain("7 / 7");
    expect(document.body.textContent).toContain("Import complete");
  });

  it("uses selected source bytes when the selected worksheet has no exact row count", async () => {
    mocks.previewTableImportFile.mockImplementation((_source, options) => Promise.resolve({ ...workbookPreview(options.parseOptions.sheetName || "First"), totalRowsExact: false }));
    let finish!: () => void;
    mocks.importTableFile.mockImplementation((request, onProgress) => {
      onProgress({ importId: request.importId, status: "running", phase: "reading", rowsImported: 0, totalRows: 0, totalRowsExact: false, bytesRead: 15, totalBytes: 30, elapsedMs: 1 });
      return new Promise((resolve) => {
        finish = () => resolve({ importId: request.importId, rowsImported: 5, totalRows: 5, elapsedMs: 1 });
      });
    });
    await mountDialog();
    await selectTask("rows_First", false);
    await selectTask("rows_Second", false);
    await startImport();
    expect(document.body.textContent).toContain("50%");
    finish();
    await flushAsyncUpdates();
  });

  it("marks the actual failed task after skipping a worksheet", async () => {
    mocks.importTableFile.mockRejectedValueOnce(new Error("write failed"));
    await mountDialog();
    await selectTask("rows_First", false);
    await selectTask("rows_Second", false);
    await startImport();
    expect(mocks.importTableFile.mock.calls[0]![0].table).toBe("rows_Third");
    expect(taskCheckbox("rows_Third").parentElement?.querySelector("svg.text-destructive")).toBeTruthy();
    expect(taskCheckbox("rows_First").parentElement?.querySelector("svg.text-destructive")).toBeNull();
    expect(document.body.textContent).toContain("write failed");
  });

  it("retains multi-file CSV selection and releases excluded uploaded sources", async () => {
    mocks.previewTableImportFile.mockImplementation((file: File) => Promise.resolve({ ...workbookPreview("First"), fileName: file.name, filePath: `/tmp/${file.name}`, fileType: "csv", sourceRef: `${file.name}-source`, sheets: [], effectiveEncoding: "utf8" }));
    await mountDialog([new File(["id,name"], "first.csv"), new File(["id,name"], "second.csv")]);
    expect(taskCheckbox("first").checked).toBe(true);
    expect(taskCheckbox("second").checked).toBe(true);
    await selectTask("first", false);
    await startImport();
    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0]).toMatchObject({ table: "second", sourceFormat: "csv", parseOptions: { encoding: "utf8", sheetName: null } });
    expect(mocks.releaseTableImportSource.mock.calls.map(([source]) => source).sort()).toEqual(["first.csv-source", "second.csv-source"]);
  });
});
