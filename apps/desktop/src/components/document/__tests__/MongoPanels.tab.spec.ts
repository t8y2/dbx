// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import MongoImportPanel from "@/components/document/MongoImportPanel.vue";
import MongoDatabaseDumpPanel from "@/components/document/MongoDatabaseDumpPanel.vue";
import { beginMongoTask, updateMongoTaskImport } from "@/composables/useMongoTaskRegistry";
import type { MongoDumpTabState, MongoImportTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  inspectMongodbDatabaseDump: vi.fn().mockResolvedValue({ collections: [], databases: [], collectionCounts: {} }),
  getConfig: vi.fn((id: string) => (id === "conn-1" ? { id, name: "Mongo", db_type: "mongodb", driver_profile: "mongodb" } : undefined)),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "Mongo", db_type: "mongodb", driver_profile: "mongodb" }],
    getConfig: mocks.getConfig,
    ensureConnected: mocks.ensureConnected,
    loadMongoDatabases: vi.fn(),
    loadMongoCollections: vi.fn(),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  inspectMongodbDatabaseDump: mocks.inspectMongodbDatabaseDump,
  releaseMongodbRestoreSource: vi.fn(),
  releaseMongodbImportSource: vi.fn(),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

const mountedApps: App[] = [];

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
});

describe("Mongo panels reattach tracked tasks", () => {
  it("mongo-import tab re-attaches a running import from the registry", async () => {
    installLocalStorage();
    const record = beginMongoTask("import", { connectionId: "conn-1", database: "shop", collection: "orders" });
    updateMongoTaskImport(record.id, {
      importId: record.id,
      phase: "inserting",
      rowsRead: 120,
      rowsInserted: 100,
      rowsFailed: 0,
      batchesCommitted: 2,
    } as never);

    const state: MongoImportTabState = { config: { connectionId: "conn-1", database: "shop", collection: "orders" }, taskId: record.id };
    mountComponent(MongoImportPanel, { inDialog: false, initialState: state });
    await flushAsyncSetup();

    // Execution view is shown with the live counters from the registry.
    expect(document.body.textContent).toContain(i18n.global.t("mongo.import.rowsInserted") + ": 100");
    expect(document.body.textContent).toContain(i18n.global.t("mongo.import.title"));
  }, 30_000);

  it("mongo-dump tab re-attaches a running dump from the registry", async () => {
    installLocalStorage();
    const record = beginMongoTask("dump", { connectionId: "conn-1", database: "shop" });
    // Seed progress without going through updateMongoTaskDump (which would just stay running).
    const { getMongoTask } = await import("@/composables/useMongoTaskRegistry");
    const live = getMongoTask(record.id)!;
    live.dumpProgress = {
      taskId: record.id,
      status: "running",
      phase: "data",
      collection: "orders",
      collectionsDone: 1,
      collectionsTotal: 3,
      documentsRead: 50,
      documentsWritten: 0,
      documentsFailed: 0,
      indexesCreated: 0,
      elapsedMs: 1000,
      errorMessage: null,
      filePath: null,
    } as never;

    const state: MongoDumpTabState = { config: { connectionId: "conn-1", database: "shop", mode: "dump" }, taskId: record.id };
    mountComponent(MongoDatabaseDumpPanel, { inDialog: false, initialState: state });
    await flushAsyncSetup();

    expect(document.body.textContent).toContain(i18n.global.t("mongoDump.dumpTitle"));
    expect(document.body.textContent).toContain(i18n.global.t("mongoDump.cancel"));
    expect(document.body.textContent).toContain("orders");
  }, 30_000);
});
