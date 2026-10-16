// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DataTransferPanel from "@/components/transfer/DataTransferPanel.vue";
import type { TransferTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([]),
  listSchemas: vi.fn().mockResolvedValue([]),
  listTables: vi.fn().mockResolvedValue([]),
  listObjects: vi.fn().mockResolvedValue([]),
  listDorisCatalogs: vi.fn().mockResolvedValue([]),
  initFromStorage: vi.fn().mockResolvedValue(undefined),
  cancelTask: vi.fn(),
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
  listDorisCatalogs: mocks.listDorisCatalogs,
  mongoListDatabases: vi.fn().mockResolvedValue([]),
  mongoListCollections: vi.fn().mockResolvedValue([]),
  previewTransferOwnership: vi.fn(),
}));

vi.mock("@/composables/useExportTracker", () => ({
  useExportTracker: () => ({
    tasks: { value: mocks.tasks },
    startDataTransferTask: vi.fn(),
    cancelTask: mocks.cancelTask,
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
      listTasks: vi.fn().mockReturnValue([]),
      getTask: vi.fn().mockReturnValue(undefined),
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
  openDataTransferTask: vi.fn(),
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

function tabSnapshot(): TransferTabState {
  return {
    config: {
      sourceConnectionId: "mysql-src",
      sourceDatabase: "srcdb",
      targetConnectionId: "mysql-tgt",
      targetDatabase: "tgtdb",
      objects: { TABLE: ["users"] },
      content: "structureAndData",
      strategy: "append",
      targetTableNameCase: "preserve",
      quoteTargetColumnNames: true,
      batchSize: 1000,
      dropTargetConfirmed: false,
    } as TransferTabState["config"],
    taskId: "txn-9",
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

function mountTabPanel(conversionBlocked = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(DataTransferPanel, {
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
  mocks.tasks = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("DataTransferPanel tab form factor", () => {
  it("shows the attached task progress above the config form and emits the snapshot on convert", async () => {
    installLocalStorage();
    mocks.tasks = [
      {
        exportId: "txn-9",
        kind: "data-transfer",
        status: "Running",
        tableName: "srcdb → tgtdb",
        totalTables: 4,
        tableIndex: 1,
        rowsExported: 100,
        startedAt: Date.now() - 1000,
      },
    ];
    mountTabPanel();
    await flushAsyncSetup();

    // 配置+进度合一：任务进度卡与配置工具区同时在场。
    expect(document.body.textContent).toContain(i18n.global.t("exportProgress.compareRunning"));
    expect(document.body.textContent).toContain(i18n.global.t("transfer.title"));
    expect(document.body.textContent).not.toContain(i18n.global.t("common.close"));
    // Conversion moved to the tab pill (covered by EditorGroupTabBar.dialogBack.spec).
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);

  it("does not render an in-panel convert action (the tab pill owns conversion)", async () => {
    installLocalStorage();
    mountTabPanel(true);
    await flushAsyncSetup();
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);
});
