// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, createApp, nextTick, type App } from "vue";
import { createPinia } from "pinia";
import MultiDbExecuteDialog from "../MultiDbExecuteDialog.vue";
import type { MultiDbExecutionAdapter } from "@/composables/useMultiDbExecution";
import type { MultiDbTargetCatalogOption } from "@/composables/useMultiDbTargetSelection";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import type { MultiDbExecutionTarget } from "@/types/sqlExecution";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/stores/sqlExecutionTargetGroupStore", () => ({ useSqlExecutionTargetGroupStore: () => ({ getGroupsByDatabaseType: () => [], getGroup: () => undefined }) }));
vi.mock("@/composables/useExportTracker", () => ({ formatDataTransferDuration: String, useExportTracker: () => ({ addMultiDbExecutionTask: vi.fn(), updateMultiDbExecutionTask: vi.fn(), registerTaskCancelHandler: vi.fn(), unregisterTaskCancelHandler: vi.fn() }) }));
vi.mock("@/composables/useMultiDbTargetSelection", () => ({
  useMultiDbTargetSelection: () => ({
    compatibleConnections: computed(() => selectionConnections),
    connection: (id: string) => selectionConnections.find((connection) => connection.id === id) ?? { id: "test", name: "Test", db_type: "oceanbase-oracle" },
    loadConnection: vi.fn().mockResolvedValue(undefined),
    loadCatalogs: vi.fn().mockResolvedValue(undefined),
    loadDatabase: vi.fn().mockResolvedValue(undefined),
    loadSchemas: vi.fn().mockResolvedValue(undefined),
    catalogsForConnection: () => selectionCatalogs,
    databaseNamesForConnection: () => selectionDatabases,
    schemaNamesForTarget: () => selectionSchemas,
    resourceState: () => ({ loading: false }),
    catalogState: () => ({ loading: false }),
    databaseState: () => ({ loading: false }),
    validateTarget: async () => ({ state: "valid" }),
    validateTargets,
  }),
}));

let app: App | undefined;
let selectionConnections: ConnectionConfig[] = [];
let selectionCatalogs: MultiDbTargetCatalogOption[] = [];
let selectionDatabases: string[] = [];
let selectionSchemas: string[] = [];
const validateTargets = vi.fn(async (targets: MultiDbExecutionTarget[]) => targets.map((target) => ({ target, state: "valid" })));
const onOpenChange = vi.fn();
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  selectionConnections = [];
  selectionCatalogs = [];
  selectionDatabases = [];
  selectionSchemas = [];
  validateTargets.mockClear();
  onOpenChange.mockClear();
});

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

function mountDialog(props: InstanceType<typeof MultiDbExecuteDialog>["$props"]) {
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(MultiDbExecuteDialog, props);
  app.use(createPinia());
  app.mount(root);
}

async function openDialog(executeTarget: MultiDbExecutionAdapter["executeTarget"]) {
  mountDialog({ open: true, "onUpdate:open": onOpenChange, sql: "INSERT INTO t VALUES (1)", sourceTabId: "source", databaseType: "oceanbase-oracle", initialTargets: [{ connectionId: "test", database: "test" }], launchId: 1, initialManualTransaction: true, executeTarget });
  await flushPromises();
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.checked).toBe(true);
  button("multiDbExecute.execute").click();
  await flushPromises();
}

function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}

describe("multi-database selection filtered by connection ID", () => {
  it.each<{
    databaseType: DatabaseType;
    catalog?: string;
    databases: string[];
    schemas?: string[];
    targets: MultiDbExecutionTarget[];
  }>([
    {
      databaseType: "mysql",
      databases: ["orders", "inventory"],
      targets: [
        { connectionId: "connection-123", database: "orders" },
        { connectionId: "connection-123", database: "inventory" },
      ],
    },
    {
      databaseType: "doris",
      catalog: "warehouse",
      databases: ["orders", "inventory"],
      targets: [
        { connectionId: "connection-123", catalog: "warehouse", database: "orders" },
        { connectionId: "connection-123", catalog: "warehouse", database: "inventory" },
      ],
    },
    {
      databaseType: "postgres",
      databases: ["warehouse"],
      schemas: ["orders", "inventory"],
      targets: [
        { connectionId: "connection-123", database: "warehouse", schema: "orders" },
        { connectionId: "connection-123", database: "warehouse", schema: "inventory" },
      ],
    },
  ])("selects and clears all $databaseType targets when only the ID matches", async ({ databaseType, catalog, databases, schemas, targets }) => {
    const connection = { id: "connection-123", name: "Staging", db_type: databaseType, host: "example.invalid", port: 0, username: "", password: "" };
    selectionConnections = [connection, { ...connection, id: "connection-456", name: "Other" }];
    selectionCatalogs = catalog ? [{ name: catalog, targetCatalog: catalog, isInternal: false }] : [];
    selectionDatabases = databases;
    selectionSchemas = schemas ?? [];
    const executeTarget = vi.fn();
    mountDialog({ open: true, sql: "SELECT 1", sourceTabId: "source", databaseType, initialTargets: [], launchId: 1, executeTarget });
    await flushPromises();

    const search = document.querySelector<HTMLInputElement>('input[placeholder="multiDbExecute.searchTargets"]')!;
    search.value = " CONNECTION-123 ";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(document.body.textContent).not.toContain("Other");

    button("Staging").click();
    await flushPromises();
    expect(validateTargets).toHaveBeenLastCalledWith(targets);
    expect(document.querySelectorAll('[title="multiDbExecute.removeTarget"]')).toHaveLength(targets.length);

    button("Staging").click();
    await flushPromises();
    expect(document.querySelectorAll('[title="multiDbExecute.removeTarget"]')).toHaveLength(0);
    expect(executeTarget).not.toHaveBeenCalled();
  });
});

describe("manual multi-database dialog", () => {
  it("shows pending changes, commits only on click, and clears transaction controls", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn<MultiDbExecutionAdapter["executeTarget"]>(async () => ({ status: "pending_commit" as const, transaction: { canCommit: true, finish } }));
    await openDialog(execute);
    expect(execute.mock.calls[0][0].context.manualTransaction).toBe(true);
    expect(document.body.textContent).toContain("multiDbExecute.pendingCommit");
    expect(finish).not.toHaveBeenCalled();
    button("multiDbExecute.commit").click();
    await flushPromises();
    expect(finish).toHaveBeenCalledExactlyOnceWith("commit");
    expect([...document.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "multiDbExecute.commit")).toBe(false);
  });

  it("keeps the dialog open until pending changes are explicitly discarded", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await openDialog(vi.fn(async () => ({ status: "pending_commit" as const, transaction: { canCommit: true, finish } })));
    button("common.close").click();
    await flushPromises();
    expect(document.body.textContent).toContain("multiDbExecute.discardTitle");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    button("multiDbExecute.rollbackAndClose").click();
    await flushPromises();
    expect(finish).toHaveBeenCalledExactlyOnceWith("rollback");
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps rollback available after failed cleanup", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await openDialog(vi.fn(async () => ({ status: "failed" as const, transaction: { canCommit: false, finish } })));
    expect(button("multiDbExecute.commit").disabled).toBe(true);
    button("multiDbExecute.rollback").click();
    await flushPromises();
    expect(document.body.textContent).toContain("offline");
    expect(button("multiDbExecute.rollback").disabled).toBe(false);
    button("multiDbExecute.rollback").click();
    await flushPromises();
    expect(document.body.textContent).toContain("multiDbExecute.rolledBack");
  });
});
