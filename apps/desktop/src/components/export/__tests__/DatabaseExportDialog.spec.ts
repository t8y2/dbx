// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import DatabaseExportDialog from "@/components/export/DatabaseExportDialog.vue";
import DatabaseExportPanel from "@/components/export/DatabaseExportPanel.vue";
import type { DatabaseExportTabState } from "@/types/database";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  listDatabases: vi.fn().mockResolvedValue([{ name: "shop" }]),
  listSchemas: vi.fn().mockResolvedValue(["public"]),
  listTables: vi.fn().mockResolvedValue([]),
  tasks: [] as unknown[],
}));

vi.mock("@/components/connection/ConnectionGroupBadge.vue", () => ({
  default: { name: "ConnectionGroupBadgeStub", render: () => h("span") },
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    connections: [{ id: "conn-1", name: "MySQL", db_type: "mysql", driver_profile: "mysql" }],
    getConfig: (id: string) => (id === "conn-1" ? { id, name: "MySQL", db_type: "mysql", driver_profile: "mysql" } : undefined),
    ensureConnected: mocks.ensureConnected,
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  listDatabases: mocks.listDatabases,
  listSchemas: mocks.listSchemas,
  listTables: mocks.listTables,
  recordDatabaseExportDestination: vi.fn().mockResolvedValue(undefined),
  cancelDatabaseExport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/composables/useExportTracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useExportTracker")>();
  return {
    ...actual,
    useExportTracker: () => ({
      tasks: { value: mocks.tasks },
      addDatabaseExportTask: vi.fn(),
      updateDatabaseExportTask: vi.fn(),
    }),
  };
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
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

function exportTabSnapshot(exportId: string | null): DatabaseExportTabState {
  return {
    config: { connectionId: "conn-1", database: "shop", schema: "public" },
    exportId,
    filePath: exportId ? "/tmp/export.sql" : null,
  };
}

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.textContent = "";
  mocks.tasks = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(emitted)) delete emitted[key];
});

describe("DatabaseExportDialog rendering", () => {
  it("renders the config view with the export action on open", async () => {
    installLocalStorage();
    mountComponent(DatabaseExportDialog, { open: true });
    await flushAsyncSetup();

    expect(document.body.textContent).toContain(i18n.global.t("databaseExport.title"));
    const exportLabel = i18n.global.t("databaseExport.export");
    const exportButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(exportLabel));
    expect(exportButton).toBeDefined();
    // No connection selected yet: the export action stays disabled.
    expect(exportButton?.disabled).toBe(true);
  }, 30_000);
});

describe("DatabaseExportPanel tab form factor", () => {
  it("re-attaches a tracked export and shows its live progress view on remount, emitting the snapshot on convert", async () => {
    installLocalStorage();
    mocks.tasks = [
      {
        exportId: "exp-1",
        kind: "database-export",
        status: "Running",
        tableName: "shop",
        filePath: "/tmp/export.sql",
        currentObject: "orders",
        objectIndex: 2,
        totalObjects: 10,
        rowsExported: 50,
        totalRows: null,
        startedAt: Date.now() - 1000,
        errorMessage: null,
      },
    ];
    mountComponent(DatabaseExportPanel, {
      inDialog: false,
      initialState: exportTabSnapshot("exp-1"),
      onConvertToDialog: (state: unknown) => (emitted["convert-to-dialog"] = [state]),
    });
    await flushAsyncSetup();

    // Progress view replaces the config form while the tracked export is active.
    expect(document.body.textContent).toContain(i18n.global.t("databaseExport.currentTable", { table: "orders", current: 2, total: 10 }));
    const cancelLabel = i18n.global.t("transfer.cancel");
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes(cancelLabel))).toBe(true);

    // Conversion is owned by the tab pill (EditorGroupTabBar.dialogBack.spec).
    expect([...document.querySelectorAll("button")].some((button) => button.textContent?.includes(i18n.global.t("workspace.convertToDialog")))).toBe(false);
  }, 30_000);

  it("restores the config view with the tracked selection when no export is attached", async () => {
    installLocalStorage();
    mountComponent(DatabaseExportPanel, {
      inDialog: false,
      initialState: { ...exportTabSnapshot(null), config: { connectionId: "conn-1", database: "shop", schema: "public", selectedTables: [] } },
    });
    await flushAsyncSetup();

    expect(mocks.listDatabases).toHaveBeenCalledWith("conn-1");
    const exportLabel = i18n.global.t("databaseExport.export");
    expect([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent?.includes(exportLabel))).toBe(true);
  }, 30_000);
});
