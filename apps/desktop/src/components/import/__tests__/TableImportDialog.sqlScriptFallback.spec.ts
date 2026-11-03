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

const connectionStore = vi.hoisted(() => ({
  sqlFileSource: null as unknown,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => ({ id, name: "SQLite", db_type: "sqlite" }),
    ensureConnected: mocks.ensureConnected,
    invalidateMetadataCache: vi.fn(),
    refreshObjectListTreeNode: vi.fn().mockResolvedValue(undefined),
    get sqlFileSource() {
      return connectionStore.sqlFileSource;
    },
    set sqlFileSource(value: unknown) {
      connectionStore.sqlFileSource = value;
    },
  }),
}));

vi.mock("@/lib/backend/http", () => ({
  previewSqlFile: vi.fn().mockResolvedValue({ uploadId: "uploaded-dump" }),
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

const MULTI_TABLE_ERROR = "SQL import supports one table per file; found 'orders' and 'users'";

async function flushAsyncUpdates() {
  for (let index = 0; index < 4; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
}

async function mountDialogWithSqlFile(extraProps: Record<string, unknown> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TableImportDialog, { open: true, prefillConnectionId: "connection-1", prefillDatabase: "main", ...extraProps }) }));
  mountedApps.push(app);
  app.use(i18n);
  i18n.global.locale.value = "en";
  app.mount(container);
  await flushAsyncUpdates();
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["INSERT INTO orders VALUES (1);"], "dump.sql")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flushAsyncUpdates();
}

beforeEach(() => {
  connectionStore.sqlFileSource = null;
  mocks.listTables.mockReset().mockResolvedValue([]);
  mocks.previewTableImportFile.mockReset();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
});

describe("TableImportDialog SQL script fallback", () => {
  it("offers the SQL file executor when a SQL file is not a single-table INSERT script", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));

    await mountDialogWithSqlFile();

    expect(document.body.textContent).toContain(MULTI_TABLE_ERROR);
    const run = findButton("Execute SQL File");
    expect(run, "executor hand-off button").toBeTruthy();
    run!.click();
    await flushAsyncUpdates();

    expect(connectionStore.sqlFileSource).toMatchObject({ connectionId: "connection-1", database: "main", preview: { uploadId: "uploaded-dump" } });
  });

  it("offers the SQL file executor when importing into an existing table", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error(MULTI_TABLE_ERROR));

    await mountDialogWithSqlFile({ prefillTable: "orders" });

    const run = findButton("Execute SQL File");
    expect(run, "executor hand-off button").toBeTruthy();
    run!.click();
    await flushAsyncUpdates();

    expect(connectionStore.sqlFileSource).toMatchObject({ connectionId: "connection-1", database: "main", preview: { uploadId: "uploaded-dump" } });
  });

  it("does not offer the executor for a delimited file that fails to preview", async () => {
    mocks.previewTableImportFile.mockRejectedValue(new Error("boom"));
    await mountDialogWithSqlFile();
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["id\n1"], "rows.csv")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsyncUpdates();

    expect(document.body.textContent).toContain("boom");
    expect(findButton("Execute SQL File")).toBeUndefined();
  });
});
