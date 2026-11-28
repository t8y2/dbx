// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualForeignKeyRule } from "@/lib/dataGrid/virtualForeignKeys";

const apiMocks = vi.hoisted(() => ({
  listDatabases: vi.fn(async () => [{ name: "trade_db" }, { name: "account_db" }]),
  listSchemas: vi.fn(async () => ["PUBLIC", "CRM"]),
  listTables: vi.fn(async () => [
    { name: "DS_CUSTOMER", table_type: "TABLE" },
    { name: "DS_ORDER", table_type: "TABLE" },
  ]),
  getColumns: vi.fn(async (_conn: string, _db: string, _schema: string, table: string) =>
    table === "DS_CUSTOMER"
      ? [
          { name: "ID", data_type: "INTEGER", nullable: false, is_primary_key: true },
          { name: "DISPLAY_NAME", data_type: "VARCHAR", nullable: false, is_primary_key: false },
        ]
      : [
          { name: "ID", data_type: "INTEGER", nullable: false, is_primary_key: true },
          { name: "CUSTOMER_ID", data_type: "INTEGER", nullable: true, is_primary_key: false },
        ],
  ),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

vi.mock("@/lib/backend/api", () => apiMocks);

vi.mock("@/components/ui/dialog", () => {
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  return {
    Dialog: defineComponent({
      props: ["open"],
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", slots.default?.()) : null,
    }),
    DialogContent: passthrough,
    DialogDescription: passthrough,
    DialogFooter: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
  };
});

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    props: ["modelValue", "options", "placeholder"],
    emits: ["update:modelValue"],
    setup:
      (props, { emit }) =>
      () =>
        h(
          "select",
          {
            value: props.modelValue,
            "data-placeholder": props.placeholder,
            onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value),
          },
          [h("option", { value: "" }, ""), ...(props.options ?? []).map((opt: string) => h("option", { value: opt }, opt))],
        ),
  }),
}));

import DataGridVirtualForeignKeyDialog from "../DataGridVirtualForeignKeyDialog.vue";

const mounted: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    entry.app.unmount();
    entry.host.remove();
  }
  vi.clearAllMocks();
});

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function mountDialog(overrides: Partial<{ databaseTreeHierarchy: boolean; rules: VirtualForeignKeyRule[] }> = {}) {
  const state = reactive({
    open: true,
    connectionId: "conn-h2",
    database: "DATASKIP_DEMO",
    schema: "PUBLIC",
    tableName: "DS_ORDER",
    columns: ["ID", "CUSTOMER_ID", "AMOUNT"],
    initialColumn: "CUSTOMER_ID",
    databaseTreeHierarchy: overrides.databaseTreeHierarchy ?? false,
    rules: overrides.rules ?? ([] as VirtualForeignKeyRule[]),
  });
  const onSave = vi.fn();
  const onRemove = vi.fn();
  const onImportRules = vi.fn();
  const onCopy = vi.fn();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () =>
      h(DataGridVirtualForeignKeyDialog, {
        ...state,
        onSave,
        onRemove,
        onImportRules,
        onCopy,
      }),
  });
  app.mount(host);
  mounted.push({ app, host });
  return { state, host, onSave, onRemove, onImportRules, onCopy };
}

describe("DataGridVirtualForeignKeyDialog", () => {
  it("loads schemas, tables, and target columns and emits a bidirectional rule on save", async () => {
    const { host, onSave } = mountDialog();
    await flushPromises();

    expect(apiMocks.listSchemas).toHaveBeenCalledWith("conn-h2", "DATASKIP_DEMO");
    expect(apiMocks.listTables).toHaveBeenCalled();

    const selects = host.querySelectorAll("select");
    expect(selects).toHaveLength(4);
    const targetTableSelect = selects[2]!;
    targetTableSelect.value = "DS_CUSTOMER";
    targetTableSelect.dispatchEvent(new Event("change"));
    await flushPromises();

    expect(apiMocks.getColumns).toHaveBeenCalledWith("conn-h2", "DATASKIP_DEMO", "PUBLIC", "DS_CUSTOMER", undefined);

    const addButton = host.querySelector("[data-virtual-fk-add]") as HTMLButtonElement;
    expect(addButton.disabled).toBe(false);
    addButton.click();
    await nextTick();

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      connectionId: "conn-h2",
      source: { database: "DATASKIP_DEMO", schema: "PUBLIC", table: "DS_ORDER", column: "CUSTOMER_ID" },
      target: { database: "DATASKIP_DEMO", schema: "PUBLIC", table: "DS_CUSTOMER", column: "ID" },
      bidirectional: true,
    });
  });

  it("validates and imports portable JSON bundles and rejects invalid payloads", async () => {
    const { host, onImportRules } = mountDialog();
    await flushPromises();

    const importToggle = Array.from(host.querySelectorAll("button")).find((btn) => btn.textContent?.includes("grid.virtualForeignKeyImportJson"))!;
    importToggle.click();
    await nextTick();

    const textarea = host.querySelector("[data-virtual-fk-import-input]") as HTMLTextAreaElement;
    const submit = host.querySelector("[data-virtual-fk-import-submit]") as HTMLButtonElement;

    textarea.value = "{bad json";
    textarea.dispatchEvent(new Event("input"));
    await nextTick();
    submit.click();
    await nextTick();
    expect(onImportRules).not.toHaveBeenCalled();
    expect(host.textContent).toContain("JSON");

    textarea.value = JSON.stringify({
      version: 1,
      rules: [
        {
          source: { schema: "PUBLIC", table: "DS_ORDER", column: "CUSTOMER_ID" },
          target: { schema: "PUBLIC", table: "DS_CUSTOMER", column: "ID" },
          bidirectional: true,
        },
      ],
    });
    textarea.dispatchEvent(new Event("input"));
    await nextTick();
    submit.click();
    await nextTick();

    expect(onImportRules).toHaveBeenCalledTimes(1);
    expect(onImportRules.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("renders saved rules and supports copy export and removal", async () => {
    const existing: VirtualForeignKeyRule[] = [
      {
        id: "vfk_demo",
        connectionId: "conn-h2",
        source: { database: "DATASKIP_DEMO", schema: "PUBLIC", table: "DS_ORDER", column: "CUSTOMER_ID" },
        target: { database: "DATASKIP_DEMO", schema: "PUBLIC", table: "DS_CUSTOMER", column: "ID" },
        bidirectional: true,
        note: "Order customer",
      },
    ];
    const { host, onRemove, onCopy } = mountDialog({ rules: existing });
    await flushPromises();

    expect(host.querySelectorAll("[data-virtual-fk-rule-row]")).toHaveLength(1);
    expect(host.textContent).toContain("Order customer");

    const exportBtn = Array.from(host.querySelectorAll("button")).find((btn) => btn.textContent?.includes("grid.virtualForeignKeyExportJson"))!;
    exportBtn.click();
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy.mock.calls[0]?.[0]).toContain('"version": 1');

    const removeBtn = host.querySelector('[title="grid.virtualForeignKeyRemove"]') as HTMLButtonElement;
    removeBtn.click();
    expect(onRemove).toHaveBeenCalledWith("vfk_demo");
  });
});
