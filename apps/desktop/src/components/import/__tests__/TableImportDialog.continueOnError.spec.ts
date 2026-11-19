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
  toast: vi.fn(),
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
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

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
      props: { modelValue: { type: String, default: "" }, options: { type: Array<string>, default: () => [] }, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h(
            "select",
            {
              value: props.modelValue,
              disabled: props.disabled,
              onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value),
            },
            [(props.options as string[]).map((option) => h("option", { value: option }, option))],
          );
      },
    }),
  };
});

import TableImportDialog from "@/components/import/TableImportDialog.vue";

const mountedApps: App[] = [];

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

function clickButton(text: string): boolean {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
  if (!button) return false;
  button.click();
  return true;
}

async function mountDialog() {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TableImportDialog, { open: true, prefillConnectionId: "connection-1", prefillDatabase: "main" }) }));
  mountedApps.push(app);
  app.use(i18n);
  i18n.global.locale.value = "en";
  app.mount(container);
  await flushAsyncUpdates();
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["id,name\n1,a"], "rows.csv")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

async function enableContinueOnErrorAndStart() {
  const findToggle = () => document.body.querySelector<HTMLInputElement>('[data-testid="table-import-continue-on-error"]');
  let checkbox = findToggle();
  if (!checkbox) {
    expect(clickButton("Next"), "options step").toBe(true);
    await flushAsyncUpdates();
    checkbox = findToggle();
  }
  expect(checkbox, "continue-on-error toggle").toBeTruthy();
  expect(checkbox!.checked).toBe(false);
  checkbox!.click();
  await flushAsyncUpdates();
  for (let step = 0; step < 5 && !clickButton("Start Import"); step += 1) {
    expect(clickButton("Next"), `wizard step ${step}`).toBe(true);
    await flushAsyncUpdates();
  }
  await flushAsyncUpdates();
}

beforeEach(() => {
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.previewTableImportFile.mockReset().mockImplementation(() => Promise.resolve(delimitedPreview()));
  mocks.importTableFile.mockReset().mockImplementation(async (request, onProgress) => {
    onProgress({ importId: request.importId, status: "done", phase: "done", rowsImported: 2, totalRows: 3, elapsedMs: 1, rowsFailed: 0, failures: [], failuresTruncated: false });
    return { importId: request.importId, rowsImported: 2, totalRows: 3, elapsedMs: 1, rowsFailed: 0, failures: [], failuresTruncated: false };
  });
  mocks.releaseTableImportSource.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog continue on error (#13683)", () => {
  it("passes continueOnError to the backend only after the toggle is enabled", async () => {
    await mountDialog();
    await enableContinueOnErrorAndStart();

    expect(mocks.importTableFile).toHaveBeenCalledTimes(1);
    expect(mocks.importTableFile.mock.calls[0]![0].continueOnError).toBe(true);
  });

  it("lists failed rows after a continue-on-error import finishes", async () => {
    mocks.importTableFile.mockImplementation(async (request, onProgress) => {
      const failures = [{ table: "items", row: 2, error: "UNIQUE constraint failed: items.id" }];
      onProgress({ importId: request.importId, status: "done", phase: "done", rowsImported: 2, totalRows: 3, elapsedMs: 1, rowsFailed: 1, failures, failuresTruncated: false });
      return { importId: request.importId, rowsImported: 2, totalRows: 3, elapsedMs: 1, rowsFailed: 1, failures, failuresTruncated: false };
    });

    await mountDialog();
    await enableContinueOnErrorAndStart();

    const failures = document.body.querySelector('[data-testid="table-import-failures"]');
    expect(failures, "failed rows list").toBeTruthy();
    expect(failures!.textContent).toContain("Data row 2");
    expect(failures!.textContent).toContain("UNIQUE constraint failed: items.id");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("failed"), 2500);
  });

  it("keeps failed rows visible when a fatal error stops the import", async () => {
    mocks.importTableFile.mockImplementation(async (request, onProgress) => {
      const failures = [{ table: "items", row: 3, error: "value too long for column" }];
      onProgress({
        importId: request.importId,
        status: "error",
        phase: "done",
        rowsImported: 1,
        totalRows: 3,
        elapsedMs: 1,
        error: "connection lost",
        rowsFailed: 1,
        failures,
        failuresTruncated: false,
      });
      throw new Error("connection lost");
    });

    await mountDialog();
    await enableContinueOnErrorAndStart();

    const failures = document.body.querySelector('[data-testid="table-import-failures"]');
    expect(failures, "failed rows list survives the error").toBeTruthy();
    expect(failures!.textContent).toContain("Data row 3");
    expect(failures!.textContent).toContain("value too long for column");
  });
});
