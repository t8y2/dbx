// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataTransferDialog from "@/components/transfer/DataTransferDialog.vue";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue([]),
  listTables: vi.fn().mockResolvedValue([]),
  listObjects: vi.fn().mockResolvedValue([]),
  mongoListDatabases: vi.fn().mockResolvedValue([]),
  mongoListCollections: vi.fn().mockResolvedValue([]),
  initFromStorage: vi.fn().mockResolvedValue(undefined),
  listTasks: vi.fn().mockReturnValue([]),
  getTask: vi.fn().mockReturnValue(undefined),
  openDataTransferTask: vi.fn(),
  tasks: [] as unknown[],
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/stores/connectionStore", () => {
  const connections = [
    { id: "mysql-src", name: "MySQL Source", db_type: "mysql", driver_profile: "mysql" },
    { id: "mysql-tgt", name: "MySQL Target", db_type: "mysql", driver_profile: "mysql" },
  ];
  return {
    useConnectionStore: () => ({
      connections,
      sidebarLayout: { groups: [], order: [] },
      getConfig: (id: string) => connections.find((connection) => connection.id === id),
      ensureConnected: mocks.ensureConnected,
      refreshObjectListTreeNode: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  listObjects: mocks.listObjects,
  mongoListDatabases: mocks.mongoListDatabases,
  mongoListCollections: mocks.mongoListCollections,
  listDorisCatalogs: vi.fn().mockResolvedValue([]),
  previewTransferOwnership: vi.fn(),
}));

vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({
    tasks: { value: mocks.tasks },
    startDataTransferTask: vi.fn(),
    cancelTask: vi.fn(),
  }),
  formatDataTransferDuration: (ms: number) => `${ms}ms`,
}));

vi.mock("@/stores/transferTaskStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/transferTaskStore")>();
  return {
    ...actual,
    useTransferTaskStore: () => ({
      allFolders: [],
      initFromStorage: mocks.initFromStorage,
      listTasks: mocks.listTasks,
      getTask: mocks.getTask,
      saveTask: vi.fn(),
      deleteTask: vi.fn(),
      createFolder: vi.fn(),
      deleteFolder: vi.fn(),
      duplicateTask: vi.fn(),
      moveFolderToFolder: vi.fn(),
      moveTaskToFolder: vi.fn(),
      renameFolder: vi.fn(),
      renameTask: vi.fn(),
      reorderFolders: vi.fn(),
      reorderTasks: vi.fn(),
    }),
  };
});

vi.mock("@/composables/useDialogSources", () => ({
  openDataTransferTask: mocks.openDataTransferTask,
  setDataTransferDialogBusy: vi.fn(),
}));

vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({ cancelScope: vi.fn() }),
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
  for (let index = 0; index < 8; index += 1) {
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mountDialog(props: Record<string, unknown>) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () => h(DataTransferDialog, { open: true, ...props }),
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
  mocks.tasks = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DataTransferDialog rendering", () => {
  it("renders the transfer form with footer actions when no task is attached", async () => {
    installLocalStorage();
    mountDialog({});
    await flushAsyncSetup();

    expect(document.body.textContent).toContain(i18n.global.t("transfer.title"));
    expect(document.body.textContent).toContain(i18n.global.t("transfer.cancel"));
    expect(document.body.textContent).toContain(i18n.global.t("transfer.start"));
  }, 30_000);

  it("renders the progress view when a tracked task id is attached", async () => {
    installLocalStorage();
    mocks.tasks = [
      {
        exportId: "txn-1",
        kind: "data-transfer",
        status: "Running",
        tableName: "shop",
        totalTables: 4,
        tableIndex: 1,
        rowsExported: 100,
        startedAt: Date.now() - 1000,
      },
    ];
    mountDialog({ taskId: "txn-1" });
    await flushAsyncSetup();

    expect(document.querySelector("[data-transfer-progress-dialog]")).not.toBeNull();
  }, 30_000);
});
