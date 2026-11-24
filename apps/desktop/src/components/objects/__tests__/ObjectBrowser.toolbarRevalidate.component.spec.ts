// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from "vue";
import type { Ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  toolbarStore: { clipboard: null as Ref<unknown> | null },
}));
const ddlSettings = vi.hoisted(() => ({ separateDdlIndexes: false, includeDdlStorage: true, compactDdlSql: false, sidebarMenuLayout: "grouped" }));
vi.mock("@/lib/backend/api", () => ({
  ...mocks,
  listSchemas: vi.fn().mockResolvedValue([]),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
}));
vi.mock("@/stores/connectionStore", async () => {
  const { reactive, ref } = await import("vue");
  mocks.toolbarStore.clipboard = ref(null);
  // reactive() unwraps the ref like a Pinia store does, so the component sees
  // the clipboard value and its revalidate getter tracks the ref itself.
  const store = reactive({
    treeClipboard: mocks.toolbarStore.clipboard!,
    getConfig: () => connection,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    tableNameFilterForScope: () => undefined,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  });
  return { useConnectionStore: () => store };
});
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: { sidebar_table_page_size: 2 },
    editorSettings: Object.assign(reactive(ddlSettings), { shortcuts: {}, objectBrowserViewMode: "list", objectBrowserShowCheckbox: true, sidebarActivation: "double" }),
    updateEditorSettings: (patch: object) => Object.assign(reactive(ddlSettings), patch),
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup:
      (props, { slots }) =>
      () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        ),
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: defineComponent({
    props: ["modelValue", "options"],
    emits: ["update:modelValue"],
    setup:
      (props, { emit, attrs }) =>
      () =>
        h(
          "select",
          { ...attrs, value: props.modelValue, onChange: (event: Event) => emit("update:modelValue", (event.target as HTMLSelectElement).value) },
          (props.options ?? []).map((option: string) => h("option", { value: option }, option)),
        ),
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const passthrough = {
    render(this: { $slots: { default?: () => unknown } }) {
      return h("div", this.$slots.default?.() as never);
    },
  };
  return {
    Dialog: defineComponent({
      props: ["open"],
      setup:
        (props, { slots }) =>
        () =>
          props.open ? h("div", slots.default?.()) : null,
    }),
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogFooter: passthrough,
  };
});
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { clearObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";

const connection = { id: "mysql-a", name: "fixture", db_type: "mysql", database: "app", transport_layers: [] } as unknown as ConnectionConfig;
const mounted: Array<{ app: App; host: HTMLElement }> = [];

function clipboardRef() {
  return mocks.toolbarStore.clipboard as { value: unknown };
}

async function flush(ticks = 6) {
  for (let index = 0; index < ticks; index += 1) await nextTick();
}

/**
 * happy-dom's ResizeObserver is a no-op, so the only thing that can re-measure
 * after mount is the revalidate watch. Widths are stubbed on the real row to
 * model "the control set grew past the available width".
 */
function stubRowWidth(row: HTMLElement, contentAt: () => number, clientWidth = 320) {
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => clientWidth });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => Math.max(clientWidth, contentAt()) });
}

beforeEach(() => {
  vi.clearAllMocks();
  clipboardRef().value = null;
  mocks.listObjects.mockReset().mockResolvedValue([]);
  clearObjectBrowserRowsCache();
  clearMetadataRuntimeCache();
});
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
});

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "app", selectedObjectFilter: "all" }) });
  mounted.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(mocks.listObjects).toHaveBeenCalled());
  await flush();
  return host;
}

function overflowTrigger(host: HTMLElement) {
  return host.querySelector('[aria-label="toolbar.moreActions"]');
}

function pasteButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("objects.pasteTableSelected")) ?? null;
}

describe("ObjectBrowser toolbar revalidation", () => {
  it("re-measures when the table clipboard adds and removes the paste button", async () => {
    const host = await mountBrowser();
    const row = host.querySelector<HTMLElement>("[data-toolbar-row]")!;
    expect(row).not.toBeNull();
    stubRowWidth(row, () => (clipboardRef().value ? 520 : 260));

    expect(overflowTrigger(host)).toBeNull();
    expect(pasteButton(host)).toBeNull();

    // Copying a table in another object browser adds a control to this row
    // without resizing it; the stale tier would keep the row condensed layout.
    clipboardRef().value = { kind: "table-copy", tables: [{ connectionId: "mysql-a", database: "app", tableName: "t1" }] };
    await flush();
    expect(pasteButton(host)).not.toBeNull();
    expect(overflowTrigger(host)).not.toBeNull();

    clipboardRef().value = null;
    await flush();
    expect(pasteButton(host)).toBeNull();
    expect(overflowTrigger(host)).toBeNull();
  });
});
