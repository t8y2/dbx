// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportProgress, TableImportRequest, TableImportSummary } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([]),
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
    getConfig: (id: string) => ({ id, name: "SQLite", db_type: "sqlite" }),
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
  const { defineComponent, h, inject, provide } = await import("vue");
  const passthrough = defineComponent({
    setup(_props, { slots }) {
      return () => h("div", slots.default?.());
    },
  });
  return {
    Select: defineComponent({
      props: { modelValue: String },
      emits: ["update:modelValue"],
      setup(_props, { emit, slots }) {
        provide("selectOption", (value: string) => emit("update:modelValue", value));
        return () => h("div", slots.default?.());
      },
    }),
    SelectContent: passthrough,
    SelectItem: defineComponent({
      props: { value: String },
      setup(props, { slots }) {
        const selectOption = inject<(value: string) => void>("selectOption");
        return () => h("span", { "data-select-option": props.value, onClick: () => selectOption?.(props.value || "") }, slots.default?.());
      },
    }),
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
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
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

function workbookPreview(sheetName: string) {
  const index = sheets.indexOf(sheetName);
  return {
    fileName: "rows.xlsx",
    filePath: "/tmp/rows.xlsx",
    sourceRef: "workbook-source",
    fileType: "excel" as const,
    sizeBytes: [10, 20, 30][index]!,
    columns: ["id", "name"],
    rows: [[index + 1, sheetName]],
    totalRows: [2, 3, 5][index]!,
    totalRowsExact: true,
    sourceFingerprint: `rows-${sheetName}`,
    sheets,
  };
}

function delimitedPreview() {
  return {
    fileName: "rows.csv",
    filePath: "/tmp/rows.csv",
    sourceRef: "delimited-source",
    fileType: "csv" as const,
    sizeBytes: 10,
    columns: ["id", "name"],
    rows: [[1, "a"]],
    totalRows: 2,
    totalRowsExact: true,
    sourceFingerprint: "rows-csv",
  };
}

async function flushAsyncUpdates() {
  for (let index = 0; index < 4; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountDialog(files: File[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TableImportDialog, { open: true, prefillConnectionId: "connection-1", prefillDatabase: "main" }) }));
  mountedApps.push(app);
  app.use(i18n);
  i18n.global.locale.value = "en";
  app.mount(container);
  await flushAsyncUpdates();
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

function currentFileValue(): string | undefined {
  const label = [...document.body.querySelectorAll("span")].find((item) => item.textContent?.trim() === "Current file");
  if (!label) return undefined;
  return label.nextElementSibling?.textContent ?? "";
}

async function startImport() {
  const clickButton = (text: string) => {
    const result = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
    expect(result, `button ${text}`).toBeTruthy();
    result!.click();
  };
  clickButton("Next");
  await flushAsyncUpdates();
  clickButton("Next");
  await flushAsyncUpdates();
  clickButton("Start Import");
  await flushAsyncUpdates();
}

let resolveRunningImport: (() => void) | null = null;
function holdImportInProgress() {
  mocks.importTableFile.mockImplementation(async (request, onProgress) => {
    onProgress({ importId: request.importId, status: "running", phase: "writing", rowsImported: 1, totalRows: 5, totalRowsExact: true, bytesRead: 1, totalBytes: 10, elapsedMs: 1 });
    await new Promise<void>((resolve) => {
      resolveRunningImport = resolve;
    });
    onProgress({ importId: request.importId, status: "done", phase: "done", rowsImported: 5, totalRows: 5, elapsedMs: 2 });
    return { importId: request.importId, rowsImported: 5, totalRows: 5, elapsedMs: 2 };
  });
}

beforeEach(() => {
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.previewTableImportFile.mockReset().mockImplementation((_source, options) => Promise.resolve(workbookPreview(options.parseOptions.sheetName || "First")));
  mocks.importTableFile.mockReset().mockImplementation(async (request, onProgress) => {
    onProgress({ importId: request.importId, status: "done", phase: "done", rowsImported: 5, totalRows: 5, elapsedMs: 1 });
    return { importId: request.importId, rowsImported: 5, totalRows: 5, elapsedMs: 1 };
  });
  mocks.releaseTableImportSource.mockReset().mockResolvedValue(undefined);
  resolveRunningImport = null;
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog current source file display (#13164)", () => {
  it("keeps the source file on screen after a batch import finishes", async () => {
    holdImportInProgress();
    await mountDialog([new File(["workbook"], "rows.xlsx")]);
    await startImport();

    expect(currentFileValue()).toBe("/tmp/rows.xlsx");

    resolveRunningImport?.();
    await flushAsyncUpdates();
    // The queue advances to the next sheet of the same workbook, so the row
    // stays on the running source.
    expect(currentFileValue()).toBe("/tmp/rows.xlsx");

    resolveRunningImport?.();
    await flushAsyncUpdates();
    expect(currentFileValue()).toBe("/tmp/rows.xlsx");

    resolveRunningImport?.();
    await flushAsyncUpdates();
    // The completion screen still names the file that was imported (#13495).
    expect(currentFileValue()).toBe("/tmp/rows.xlsx");
    expect(mocks.importTableFile).toHaveBeenCalledTimes(3);
  });

  it("shows the single-file source while its import runs and after it finishes", async () => {
    mocks.previewTableImportFile.mockImplementation(() => Promise.resolve(delimitedPreview()));
    holdImportInProgress();
    await mountDialog([new File(['amount,note\n"12,50",plain'], "rows.csv")]);
    await startImport();

    expect(currentFileValue()).toBe("/tmp/rows.csv");

    resolveRunningImport?.();
    await flushAsyncUpdates();
    expect(currentFileValue()).toBe("/tmp/rows.csv");
  });

  it("keeps the current file visible on the minimized floating indicator", async () => {
    holdImportInProgress();
    await mountDialog([new File(["workbook"], "rows.xlsx")]);
    await startImport();

    const minimize = document.body.querySelector<HTMLButtonElement>('button[aria-label="Minimize import"]');
    expect(minimize).toBeTruthy();
    minimize!.click();
    await flushAsyncUpdates();

    const floating = document.body.querySelector<HTMLSpanElement>('button[aria-label="Restore import"]')?.parentElement;
    expect(floating?.textContent).toContain("/tmp/rows.xlsx");

    resolveRunningImport?.();
    await flushAsyncUpdates();
  });
});
