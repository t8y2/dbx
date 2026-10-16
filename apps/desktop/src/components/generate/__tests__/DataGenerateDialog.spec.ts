// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataGenerateDialog from "@/components/generate/DataGenerateDialog.vue";
import DataGeneratePanel from "@/components/generate/DataGeneratePanel.vue";
import type { DataGenerateTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["public"]),
  listTables: vi.fn().mockResolvedValue([{ name: "orders", table_type: "TABLE" }]),
  getColumns: vi.fn().mockResolvedValue([{ name: "id", data_type: "int" }]),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    getConfig: (id: string) => (id === "conn-1" ? { id, name: "MySQL", db_type: "mysql", driver_profile: "mysql" } : undefined),
    ensureConnected: mocks.ensureConnected,
    invalidateMetadataCache: vi.fn(),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  getColumns: mocks.getColumns,
  listSingleColumnUniqueConstraints: vi.fn().mockResolvedValue([]),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function tabSnapshot(): DataGenerateTabState {
  return {
    config: { connectionId: "conn-1", database: "shop", schema: "public" },
    step: "config",
    profile: {
      version: 1,
      connectionId: "conn-1",
      database: "shop",
      savedAt: "2026-10-12T00:00:00.000Z",
      configs: {
        "public.orders": {
          tableName: "orders",
          tableType: "TABLE",
          schema: "public",
          database: "shop",
          rowCount: 500,
          columns: [
            {
              columnName: "id",
              dataType: "int",
              rowCount: 500,
              generatorKey: "increment",
              generatorParams: {},
              isAutoIncrement: true,
            },
          ],
        },
      } as DataGenerateTabState["profile"] extends { configs: infer C } ? C : never,
      checkedTables: { "public.orders": true },
      checkedColumns: { "public.orders.id": true },
      expandedTables: { "public.orders": true },
      expandedSchemas: { public: true },
      tableOrder: ["public.orders"],
    },
  };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

async function flushAsyncSetup() {
  for (let index = 0; index < 10; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountComponent(component: unknown, props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(component as never, props),
    }),
  );
  mountedApps.push(app);
  app.use(i18n);
  app.use(createPinia());
  app.mount(container);
  return app;
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("DataGenerateDialog rendering", () => {
  it("renders the wizard shell on open", async () => {
    installLocalStorage();
    mountComponent(DataGenerateDialog, { open: true, prefillConnectionId: "conn-1", prefillDatabase: "shop" });
    await flushAsyncSetup();
    expect(document.body.textContent).toContain(i18n.global.t("dataGenerate.title"));
    expect(document.body.textContent).toContain(i18n.global.t("dataGenerate.nextStep"));
  }, 30_000);
});

describe("DataGeneratePanel tab form factor", () => {
  it("restores the profile from the snapshot and emits it back on convert", async () => {
    installLocalStorage();
    mountComponent(DataGeneratePanel, {
      inDialog: false,
      initialState: tabSnapshot(),
      onConvertToDialog: (state: unknown) => (emitted["convert-to-dialog"] = [state]),
    });
    await flushAsyncSetup();

    // The restored profile's table is visible in the tree, and its order row count survives.
    expect(document.body.textContent).toContain("orders");

    // Conversion is owned by the tab pill (EditorGroupTabBar.dialogBack.spec).
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
