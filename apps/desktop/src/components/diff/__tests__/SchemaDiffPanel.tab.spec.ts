// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import SchemaDiffPanel from "@/components/diff/SchemaDiffPanel.vue";
import type { SchemaDiffTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listTables: vi.fn().mockResolvedValue([]),
  generateSchemaSyncPlan: vi.fn(),
  executeScriptWith2pc: vi.fn(),
  getObjectSource: vi.fn(),
  executeQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "pg-src", name: "Postgres Source", db_type: "postgres", driver_profile: "postgres" },
    { id: "pg-tgt", name: "Postgres Target", db_type: "postgres", driver_profile: "postgres" },
  ];
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: { groups: [], order: [] },
      getConfig: (id: string) => connections.find((connection) => connection.id === id),
      ensureConnected: mocks.ensureConnected,
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  listTables: mocks.listTables,
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue([]),
  generateSchemaSyncPlan: mocks.generateSchemaSyncPlan,
  executeScriptWith2pc: mocks.executeScriptWith2pc,
  getObjectSource: mocks.getObjectSource,
  executeQuery: mocks.executeQuery,
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function tabSnapshot(): SchemaDiffTabState {
  return {
    config: {
      sourceConnectionId: "pg-src",
      sourceDatabase: "srcdb",
      sourceSchema: "public",
      targetConnectionId: "pg-tgt",
      targetDatabase: "tgtdb",
      targetSchema: "public",
      label: "Postgres Source / srcdb / public → Postgres Target / tgtdb / public",
    },
  };
}

const mountedApps: App[] = [];
const emitted: Record<string, unknown[]> = {};

async function flushAsyncSetup() {
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountTabPanel(conversionBlocked = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(SchemaDiffPanel, {
            inDialog: false,
            conversionBlocked,
            initialState: tabSnapshot(),
            onConvertToDialog: (state: unknown) => (emitted["convert-to-dialog"] = [state]),
          });
      },
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

describe("SchemaDiffPanel tab form factor", () => {
  it("renders the tab toolbar without the dialog close action and without the in-panel convert action (the tab pill owns conversion)", async () => {
    installLocalStorage();
    mountTabPanel();
    await flushAsyncSetup();

    expect(document.body.textContent).not.toContain(i18n.global.t("common.close"));
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
