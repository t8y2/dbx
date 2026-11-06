// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { clearObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { clearMetadataRuntimeCache } from "@/lib/metadata/metadataRuntimeCache";
import type { ConnectionConfig, ObjectInfo } from "@/types/database";

const mocks = vi.hoisted(() => ({ listObjects: vi.fn(), listSchemas: vi.fn().mockResolvedValue(["public"]), store: { databaseExportSource: null as unknown } }));
vi.mock("@/lib/backend/api", () => ({
  listObjects: mocks.listObjects,
  listSchemas: mocks.listSchemas,
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn(),
  deleteSchemaCachePrefix: vi.fn(),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () =>
    Object.assign(mocks.store, {
      getConfig: () => connection,
      completionCacheRevision: () => 0,
      readVisibleSchemaSelection: async () => {
        const names = await mocks.listSchemas();
        return { names, infos: [], systemNames: new Set<string>(), visibleNames: names, oracleMaintainedSchemas: undefined };
      },
      ensureConnected: vi.fn().mockResolvedValue(undefined),
      tableNameFilterForScope: () => undefined,
      orderByPinnedTreeNodes: (rows: unknown[]) => rows,
    }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: {},
    editorSettings: { shortcuts: { refreshData: "F5" }, objectBrowserViewMode: "list", objectBrowserShowCheckbox: true },
    updateEditorSettings: vi.fn(),
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = { id: "pg-export-selection", name: "fixture", db_type: "postgres", database: "app", transport_layers: [] } as unknown as ConnectionConfig;
const mounted: { app: App; host: HTMLElement }[] = [];
// A table, a function overload and a sequence that share names across types.
const objects: ObjectInfo[] = [
  { name: "orders", object_type: "TABLE", schema: "public" },
  { name: "orders", object_type: "FUNCTION", schema: "public", signature: "integer" },
  { name: "orders_seq", object_type: "SEQUENCE", schema: "public" },
] as ObjectInfo[];

beforeEach(() => {
  mocks.store.databaseExportSource = null;
  mocks.listObjects.mockReset().mockResolvedValue(objects);
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
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "app", schema: "public" }) });
  mounted.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector("[data-object-filter-chips]")).not.toBeNull());
  return host;
}

async function showType(host: HTMLElement, labelKey: string, rowName: string) {
  const chip = [...host.querySelectorAll<HTMLButtonElement>("[data-object-filter-chips] button")].find((button) => button.textContent?.includes(labelKey));
  expect(chip, labelKey).toBeDefined();
  chip!.click();
  await vi.waitFor(() => expect(host.querySelector(`[title="${rowName}"]`)).not.toBeNull());
}

async function selectAllVisible(host: HTMLElement) {
  host.querySelector<HTMLButtonElement>(".object-browser-table button")!.click();
  await nextTick();
}

function exportSelectedButton(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.exportSelected"));
}

describe("object browser export selection (#13940)", () => {
  it("clears the selection when the type filter changes", async () => {
    const host = await mountBrowser();
    await showType(host, "objects.sequences", "orders_seq");
    await selectAllVisible(host);
    expect(exportSelectedButton(host)).toBeDefined();

    await showType(host, "objects.functions", "orders(integer)");

    expect(exportSelectedButton(host)).toBeUndefined();
  });

  it("exports the picked objects with their types, not just their names", async () => {
    const host = await mountBrowser();
    await showType(host, "objects.sequences", "orders_seq");
    await selectAllVisible(host);
    await showType(host, "objects.functions", "orders(integer)");
    await selectAllVisible(host);

    exportSelectedButton(host)!.click();
    await nextTick();

    expect(mocks.store.databaseExportSource).toMatchObject({
      connectionId: "pg-export-selection",
      database: "app",
      schema: "public",
      objects: [{ objectType: "FUNCTION", name: "orders", signature: "integer" }],
    });
  });
});
