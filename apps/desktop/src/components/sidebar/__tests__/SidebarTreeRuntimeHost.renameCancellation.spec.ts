// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import * as api from "@/lib/backend/api";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { TreeNode } from "@/types/database";

const guard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/database/productionExecutionGuard", async (original) => ({ ...(await original<object>()), executeWithProductionSqlGuard: guard }));
vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<object>()),
  listPlugins: vi.fn().mockResolvedValue([]),
  getObjectSource: vi.fn().mockResolvedValue({ source: "CREATE PROCEDURE OLD AS BEGIN NULL; END;" }),
  buildRenameObjectSql: vi.fn().mockResolvedValue("ALTER TABLE OLD RENAME TO NEW"),
  buildRoutineRenameObjectSourceStatements: vi.fn().mockResolvedValue(["CREATE PROCEDURE NEW AS BEGIN NULL; END;", "DROP PROCEDURE OLD"]),
}));
vi.mock("@/lib/table/oracleRoutineRename", () => ({
  prepareOracleRoutineRename: vi.fn(async (target: any) => ({
    target,
    canonicalNewName: target.newName,
    root: { name: target.oldName, objectType: target.objectType, objectId: "1", source: "source", signature: "[]", grants: "[]", status: "VALID", errors: "[]" },
    rootDraft: "CREATE OR REPLACE PROCEDURE OWNER.OLD AS BEGIN NULL; END;",
    rootCreateSource: "CREATE PROCEDURE OWNER.NEW AS BEGIN NULL; END;",
    callers: [],
    dependencyEdges: [],
    statements: ["CREATE PROCEDURE NEW AS BEGIN NULL; END;"],
    steps: [],
    issues: [],
    metadataComplete: true,
    executable: true,
  })),
  executeOracleRoutineRename: vi.fn(),
  OracleRoutineRenameFailure: class extends Error {},
}));
import SidebarTreeRuntimeHost from "@/components/sidebar/SidebarTreeRuntimeHost.vue";
import { prepareOracleRoutineRename } from "@/lib/table/oracleRoutineRename";
import { useConnectionStore } from "@/stores/connectionStore";
import { assertSourceIdentity, captureSourceIdentity } from "@/lib/table/objectSourceIdentity";
import { renameObjectName, showRenameObjectDialog } from "../sidebarTreeDialogState";

describe("sidebar rename production cancellation", () => {
  it("updates Oracle rename capabilities when switching tree object types", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "rename-switch-c", name: "Owner", db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "SYS" } as any];
    const host = ref<any>();
    let controller: any;
    const table: TreeNode = { id: "rename-switch-table", type: "table", label: "TABLE_OLD", tableName: "TABLE_OLD", connectionId: "rename-switch-c", database: "SYS", schema: "SYS" };
    const procedure: TreeNode = { id: "rename-switch-procedure", type: "procedure", label: "PROC_OLD", objectName: "PROC_OLD", connectionId: "rename-switch-c", database: "SYS", schema: "SYS" };
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node: table,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    const openRename = (node: TreeNode) => {
      const items: ContextMenuItem[] = host.value.buildContextMenu(node);
      const rename = items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"));
      expect(rename).toBeDefined();
      rename!.action!();
    };
    try {
      app.mount(container);
      await nextTick();
      openRename(table);
      expect(controller.isOracleTableRename).toBe(true);
      expect(controller.isOracleRoutineRename).toBe(false);
      openRename(procedure);
      expect(controller.isOracleTableRename).toBe(false);
      expect(controller.isOracleRoutineRename).toBe(true);
      expect(controller.routineRenameDrafts).toBeDefined();
      expect(typeof controller.editSidebarRoutineRenameDraft).toBe("function");
      expect(typeof controller.validateSidebarRoutineRenameDrafts).toBe("function");
      expect(controller.packageSaveAsDrafts).toBeDefined();
      expect(controller.packageSaveAsValidating).toBeDefined();
      expect(typeof controller.editPackageSaveAsDraft).toBe("function");
      expect(typeof controller.validatePackageSaveAsDrafts).toBe("function");
      controller.editPackageSaveAsDraft("spec", "PACKAGE P AS END;");
      expect(controller.packageSaveAsDrafts.spec).toBe("PACKAGE P AS END;");
      controller.editSidebarRoutineRenameDraft("PROCEDURE:PROC_OLD", "CREATE OR REPLACE PROCEDURE OWNER.PROC_OLD AS BEGIN NULL; END;");
      expect(controller.routineRenameDrafts["PROCEDURE:PROC_OLD"]).toContain("PROC_OLD");
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });

  it("prepares a native Oracle routine through the sidebar dialog host", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "native-routine", name: "Owner", db_type: "oracle", host: "localhost", port: 1521, username: "OWNER" } as any];
    const host = ref<any>();
    let controller: any;
    const procedure: TreeNode = { id: "native-procedure", type: "procedure", label: "PROC_OLD", objectName: "PROC_OLD", connectionId: "native-routine", database: "OWNER", schema: "OWNER" };
    const alternateProcedure: TreeNode = { ...procedure, id: "native-procedure-other", schema: "OTHER" };
    const currentNode = ref<TreeNode>(procedure);
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node: currentNode.value,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    try {
      app.mount(container);
      await nextTick();
      const items: ContextMenuItem[] = host.value.buildContextMenu(procedure);
      items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"))!.action!();
      expect(controller.isOracleRoutineRename).toBe(true);
      renameObjectName.value = "PROC_NEW";
      await nextTick();
      await controller.refreshRenameObjectPreviewSql();
      expect(prepareOracleRoutineRename).toHaveBeenCalled();
      expect(prepareOracleRoutineRename).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "oracle" }), expect.anything());
      expect(controller.routineRenamePlan?.executable).toBe(true);
      controller.editSidebarRoutineRenameDraft("PROCEDURE:PROC_OLD", "CREATE OR REPLACE PROCEDURE OWNER.PROC_OLD AS BEGIN NULL; END;");
      controller.showRenameObjectDialog = false;
      await nextTick();
      const reopenSame = host.value.buildContextMenu(procedure).find((item: ContextMenuItem) => item.label === i18n.global.t("contextMenu.renameObject"));
      reopenSame!.action!();
      await nextTick();
      expect(controller.routineRenameDrafts["PROCEDURE:PROC_OLD"]).toContain("PROC_OLD");
      currentNode.value = alternateProcedure;
      await nextTick();
      const openOther = host.value.buildContextMenu(alternateProcedure).find((item: ContextMenuItem) => item.label === i18n.global.t("contextMenu.renameObject"));
      openOther!.action!();
      await nextTick();
      expect(controller.routineRenameDrafts).toEqual({});
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });

  it("stops after the first cancelled statement and keeps the old identity", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "rename-c", name: "Owner", db_type: "oracle", host: "localhost", port: 1521, username: "OWNER" } as any];
    vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
    const replacePin = vi.spyOn(store, "replacePinnedTreeNode");
    const host = ref<any>();
    let controller: any;
    const node: TreeNode = { id: "rename-procedure", type: "procedure", label: "OLD", objectName: "OLD", connectionId: "rename-c", database: "OWNER", schema: "OWNER" };
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    try {
      app.mount(container);
      await nextTick();
      const items: ContextMenuItem[] = host.value.buildContextMenu(node);
      const rename = items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"));
      expect(rename).toBeDefined();
      rename!.action!();
      renameObjectName.value = "NEW";
      await nextTick();
      await controller.refreshRenameObjectPreviewSql();
      await controller.confirmRenameObject();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(replacePin).not.toHaveBeenCalled();
      expect(showRenameObjectDialog.value).toBe(true);
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });

  it("holds the table source identity during confirmation and releases it when the user cancels", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "rename-table-c", name: "Owner", db_type: "oracle", host: "localhost", port: 1521, username: "OWNER" } as any];
    vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
    const host = ref<any>();
    let controller: any;
    const node: TreeNode = { id: "rename-table", type: "table", label: "OLD", tableName: "OLD", connectionId: "rename-table-c", database: "OWNER", schema: "OWNER" };
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    const identity = captureSourceIdentity({ connectionId: "rename-table-c", database: "OWNER", schema: "OWNER", objectType: "TABLE", name: "OLD" });
    try {
      app.mount(container);
      await nextTick();
      const items: ContextMenuItem[] = host.value.buildContextMenu(node);
      const rename = items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"));
      expect(rename).toBeDefined();
      rename!.action!();
      renameObjectName.value = "NEW";
      await nextTick();
      guard.mockImplementationOnce(async () => {
        expect(() => assertSourceIdentity(identity)).toThrow();
        return undefined;
      });
      await controller.confirmRenameObject();
      expect(() => assertSourceIdentity(identity)).not.toThrow();
      expect(showRenameObjectDialog.value).toBe(true);
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });

  it.each(["", "v integer", "v INOUT integer"])("renames the selected Kingbase overload using its object name (%j)", async (signature) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    store.connections = [{ id: "rename-kingbase", name: "Kingbase", db_type: "kingbase", host: "localhost", port: 54321, username: "system" } as any];
    vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
    const host = ref<any>();
    let controller: any;
    const node: TreeNode = { id: `rename-kingbase-${signature}`, type: "procedure", label: `run(${signature})`, objectName: "run", signature, connectionId: "rename-kingbase", database: "app", schema: "public" };
    const root = defineComponent({
      setup: () => () =>
        h(SidebarTreeRuntimeHost, {
          ref: host,
          node,
          depth: 0,
          onOpenDialogController: (value: unknown) => {
            controller = value;
          },
        }),
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(root).use(pinia).use(i18n);
    vi.mocked(api.getObjectSource).mockClear();
    vi.mocked(api.buildRoutineRenameObjectSourceStatements).mockClear();
    try {
      app.mount(container);
      await nextTick();
      const items: ContextMenuItem[] = host.value.buildContextMenu(node);
      items.find((item) => item.label === i18n.global.t("contextMenu.renameObject"))!.action!();
      expect(renameObjectName.value).toBe("run");
      await controller.confirmRenameObject();
      expect(api.getObjectSource).not.toHaveBeenCalled();
      expect(api.buildRoutineRenameObjectSourceStatements).not.toHaveBeenCalled();
      renameObjectName.value = "run_new";
      await nextTick();
      await controller.confirmRenameObject();
      expect(api.getObjectSource).toHaveBeenCalledWith("rename-kingbase", "app", "public", "run", "PROCEDURE", signature);
      expect(api.buildRoutineRenameObjectSourceStatements).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "kingbase", name: "run", newName: "run_new" }));
    } finally {
      app.unmount();
      container.remove();
      showRenameObjectDialog.value = false;
    }
  });
});
