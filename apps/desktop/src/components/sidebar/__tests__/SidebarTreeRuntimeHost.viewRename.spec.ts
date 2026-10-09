// @vitest-environment happy-dom
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/backend/api")>(),
  listPlugins: vi.fn().mockResolvedValue([]),
  buildRenameObjectSql: vi.fn().mockResolvedValue('RENAME "Old View" TO "New View"'),
  getObjectSource: vi.fn().mockResolvedValue({ source: 'CREATE PROCEDURE "APP"."Old View" AS BEGIN NULL; END;', editable: true }),
  buildRoutineRenameObjectSourceStatements: vi.fn().mockResolvedValue(["preflight", "create", "validate", "grants", "drop"]),
  executeQuery: vi.fn(),
}));

import * as api from "@/lib/backend/api";
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useQueryStore } from "@/stores/queryStore";

const mounted: App[] = [];
const node: TreeNode = { id: "ob:APP:view:Old View", type: "view", label: "Old View", connectionId: "ob", database: "APP" };

interface RenameDialog {
  packageCleanupReviewed: boolean;
  renameObjectName: string;
  renameObjectError: string;
  showRenameObjectDialog: boolean;
  confirmRenameObject(): Promise<void>;
}

async function openRename(target: TreeNode = node) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useConnectionStore();
  store.connections = [{ id: "ob", name: "OB", db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "APP", password: "", is_production: true }];
  vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  const replacePin = vi.spyOn(store, "replacePinnedTreeNode");
  vi.spyOn(store, "refreshObjectListTreeNode").mockResolvedValue(undefined);
  const queries = useQueryStore();
  const sourceId = queries.openObjectSourceTab({ connectionId: "ob", database: "APP", schema: "APP", title: target.label, sql: "unsaved original definition", objectSource: { schema: "APP", name: target.objectName || target.label, objectType: target.type === "package" ? "PACKAGE" : target.type === "package-body" ? "PACKAGE_BODY" : target.type === "procedure" ? "PROCEDURE" : target.type === "function" ? "FUNCTION" : "VIEW" } });
  const instance = ref<{ buildContextMenu(target: TreeNode): ContextMenuItem[] }>();
  let controller: RenameDialog | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ setup: () => () => h(SidebarTreeRuntimeHost, { ref: instance, node: target, depth: 0, "onOpen-dialog-controller": (value: RenameDialog) => { controller = value; } }) });
  app.use(pinia);
  app.use(i18n);
  app.mount(container);
  mounted.push(app);
  await nextTick();
  const item = instance.value!.buildContextMenu(target).find((entry) => entry.label === i18n.global.t("contextMenu.renameObject"));
  expect(item).toBeDefined();
  await item!.action?.();
  controller!.renameObjectName = "New View";
  await nextTick();
  return { dialog: controller!, safety: useProductionSafetyStore(), replacePin, queries, sourceId };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.executeQuery).mockResolvedValue({ columns: [], rows: [] } as any);
  vi.mocked(api.getObjectSource).mockResolvedValue({ source: 'CREATE PROCEDURE "APP"."Old View" AS BEGIN NULL; END;', editable: true } as any);
  vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockResolvedValue(["preflight", "create", "validate", "grants", "drop"]);
});
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OceanBase routine rename from the sidebar", () => {
  const routine: TreeNode = { ...node, id: "ob:APP:procedure:Old View", type: "procedure" };

  it("cancels without executing any stage or detaching the old source", async () => {
    const { dialog, safety, queries, sourceId } = await openRename(routine);
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await execution;
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
  });

  it.each([3, 4, 5])("stops at failed stage %i and preserves the original error and text", async (failedStep) => {
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => {
      if (sql === ["preflight", "create", "validate", "grants", "drop"][failedStep - 1]) throw new Error("routine-stage-error");
      return { columns: [], rows: [] } as any;
    });
    const { dialog, safety, replacePin, queries, sourceId } = await openRename(routine);
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.renameObjectError).toContain("routine-stage-error");
    expect(dialog.showRenameObjectDialog).toBe(true);
    expect(api.executeQuery).toHaveBeenCalledTimes(failedStep);
    expect(replacePin).not.toHaveBeenCalled();
    const source = queries.tabs.find((tab) => tab.id === sourceId)!;
    expect(source.sql).toBe("unsaved original definition");
    if (failedStep === 5) {
      expect(source.sourceSnapshot).toBe(true);
      expect(source.objectSource).toBeUndefined();
    } else {
      expect(source.objectSource?.name).toBe("Old View");
    }
  });
});

describe("OceanBase ordinary view rename", () => {
  it("keeps the rename dialog and old identity when production confirmation is cancelled", async () => {
    const { dialog, safety, replacePin } = await openRename();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await execution;
    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(replacePin).not.toHaveBeenCalled();
    expect(dialog.showRenameObjectDialog).toBe(true);
    expect(api.buildRenameObjectSql).toHaveBeenCalledWith(expect.objectContaining({ objectType: "VIEW", schema: "APP", oldName: "Old View", newName: "New View" }));
  });

  it("retains the server error and original identity when rename fails", async () => {
    vi.mocked(api.executeQuery).mockRejectedValueOnce(new Error("ORA-00955: name is already used"));
    const { dialog, safety, replacePin } = await openRename();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.renameObjectError).toContain("ORA-00955");
    expect(dialog.showRenameObjectDialog).toBe(true);
    expect(replacePin).not.toHaveBeenCalled();
    expect(api.executeQuery).toHaveBeenCalledWith("ob", "APP", expect.any(String), "APP", undefined, expect.any(Object));
  });
});

describe("OceanBase package migration from the sidebar", () => {
  const target: TreeNode = { ...node, type: "package", id: "ob:APP:package:Old View" };
  function preparePackage() {
    vi.mocked(api.executeQuery).mockImplementation(async (_connection, _database, sql) => ({ columns: sql === "readback" ? ["OLD_OBJECTS", "VALID_NEW_OBJECTS", "NEW_OBJECTS", "COMPILE_ERRORS"] : [], rows: sql.startsWith("SELECT OBJECT_TYPE") ? [["PACKAGE"]] : sql === "readback" ? [[0, 1, 1, 0]] : [] }) as any);
    vi.mocked(api.getObjectSource).mockImplementation(async (_connection, _database, schema, name, objectType) => ({ name, schema, object_type: objectType, source: `CREATE PACKAGE "APP"."${name}" AS END;` }));
    vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockImplementation(async (input) => input.packageCleanup ? ["cleanup", "readback"] : ["preflight", "create spec", "validate", "grants", "dependencies"]);
  }

  it("cancels after read-only preparation without replacing the original pin", async () => {
    preparePackage();
    const { dialog, safety, replacePin, queries } = await openRename(target);
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await execution;
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    expect(replacePin).not.toHaveBeenCalled();
    expect(queries.tabs.some((tab) => tab.sourceSnapshot)).toBe(false);
  });

  it("keeps the original source identity after a specification-only migration", async () => {
    preparePackage();
    const { dialog, safety, replacePin, queries, sourceId } = await openRename(target);
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.showRenameObjectDialog).toBe(false);
    expect(replacePin).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
    expect(queries.tabs.find((tab) => tab.sourceSnapshot)?.sql).toContain("5. inspect remaining dependencies: response received");
    expect(vi.mocked(api.executeQuery).mock.calls.some((call) => /DROP PACKAGE/i.test(call[2]))).toBe(false);
  });

  it("cancels explicit cleanup without changing the source or pin", async () => {
    preparePackage();
    const { dialog, safety, replacePin, queries, sourceId } = await openRename(target);
    dialog.packageCleanupReviewed = true;
    await nextTick();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.cancel();
    await execution;
    expect(vi.mocked(api.executeQuery).mock.calls.every((call) => call[2].startsWith("SELECT"))).toBe(true);
    expect(replacePin).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource?.name).toBe("Old View");
  });

  it("replaces the pin and detaches old source after confirmed cleanup", async () => {
    preparePackage();
    const { dialog, safety, replacePin, queries, sourceId } = await openRename(target);
    dialog.packageCleanupReviewed = true;
    await nextTick();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.showRenameObjectDialog).toBe(false);
    expect(replacePin).toHaveBeenCalledWith(target, expect.objectContaining({ label: "New View", children: undefined, isExpanded: false }));
    expect(queries.tabs.find((tab) => tab.id === sourceId)).toMatchObject({ sourceSnapshot: true, sql: "unsaved original definition" });
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
  });

  it("keeps the pin and recovery text when cleanup outcome cannot be read", async () => {
    preparePackage();
    const defaultExecution = vi.mocked(api.executeQuery).getMockImplementation()!;
    vi.mocked(api.executeQuery).mockImplementation(async (...args) => {
      if (args[2] === "readback") throw new Error("readback unavailable");
      return defaultExecution(...args);
    });
    const { dialog, safety, replacePin, queries, sourceId } = await openRename(target);
    dialog.packageCleanupReviewed = true;
    await nextTick();
    const execution = dialog.confirmRenameObject();
    await vi.waitFor(() => expect(safety.pending).toBeDefined());
    safety.confirm();
    await execution;
    expect(dialog.renameObjectError).toContain("readback unavailable");
    expect(replacePin).not.toHaveBeenCalled();
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.sourceSnapshot).toBe(true);
    expect(queries.tabs.find((tab) => tab.id === sourceId)?.objectSource).toBeUndefined();
  });
});
