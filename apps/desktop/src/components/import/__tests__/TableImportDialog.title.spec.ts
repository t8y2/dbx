// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { TableImportPreview } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([{ name: "existing_target", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "id", data_type: "INTEGER", nullable: false }]),
  listDataTypes: vi.fn().mockResolvedValue(["INTEGER"]),
  previewTableImportFile: vi.fn(),
  importTableFile: vi.fn(),
  releaseTableImportSource: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: (id: string) => (id === "connection-1" ? { id, name: "SQLite", db_type: "sqlite" } : undefined),
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
        return () => h("input", { ...attrs, value: props.modelValue, disabled: props.disabled, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) });
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
      props: { modelValue: { type: String, default: "" }, options: { type: Array<string>, default: () => [] }, disabled: Boolean },
      emits: ["update:modelValue"],
      setup(props, { emit }) {
        return () =>
          h("select", { class: "existing-table-select-stub", value: props.modelValue, disabled: props.disabled, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) }, [
            h("option", { value: "" }),
            ...(props.options as string[]).map((option) => h("option", { value: option }, option)),
          ]);
      },
    }),
  };
});

import TableImportDialog from "@/components/import/TableImportDialog.vue";

const mountedApps: App[] = [];

const preview: TableImportPreview = {
  fileName: "rows.csv",
  filePath: "/tmp/rows.csv",
  sourceRef: "delimited-source",
  fileType: "csv",
  sizeBytes: 10,
  columns: ["id", "name"],
  rows: [[1, "a"]],
  totalRows: 1,
  totalRowsExact: true,
  sourceFingerprint: "rows-csv",
};

async function mountDialog(options: { prefillTable?: string } = {}) {
  mocks.previewTableImportFile.mockResolvedValue(preview);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(defineComponent({ setup: () => () => h(TableImportDialog, { open: true, prefillConnectionId: "connection-1", prefillDatabase: "main", ...(options.prefillTable ? { prefillTable: options.prefillTable } : {}) }) }));
  mountedApps.push(app);
  app.use(i18n);
  app.mount(container);
  await nextTick();
  await nextTick();
  return { header: document.body.querySelector("[data-dialog-title]")?.textContent?.trim() ?? document.body.textContent ?? "" };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("TableImportDialog title", () => {
  it("names the table when it is opened for one table", async () => {
    const { header } = await mountDialog({ prefillTable: "existing_target" });

    expect(header).toContain("Import Table Data");
  });

  it("drops the table wording when it is opened from the database-level entry (#13029)", async () => {
    const { header } = await mountDialog();

    expect(header).toContain("Import Data");
    expect(header).not.toContain("Import Table Data");
  });
});
