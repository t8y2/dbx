import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { dropTableCascade, dropTablePreviewSql, emptyTablePreviewSql, sidebarDangerTarget, truncateTableCascade, truncateTablePreviewSql } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  buildDropTableSql: vi.fn(),
  buildEmptyTableSql: vi.fn(),
  buildTruncateTableSql: vi.fn(),
  ensureConnected: vi.fn(),
  executeWithProductionGuard: vi.fn(),
  closeDroppedTableObjectTabsForNode: vi.fn(),
  refreshMutatedTableDataTabsForNode: vi.fn(),
  removeTreeNode: vi.fn(),
  releaseActiveNodeReference: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/database/dbAdminSql", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database/dbAdminSql")>()),
  buildDropTableSql: mocks.buildDropTableSql,
  buildEmptyTableSql: mocks.buildEmptyTableSql,
  buildTruncateTableSql: mocks.buildTruncateTableSql,
}));

import { useSidebarTableMutationRuntime } from "@/composables/useSidebarTableMutationRuntime";

type ConfirmAction = "confirmDropTable" | "confirmEmptyTable" | "confirmTruncateTable";

const actions: Array<{ action: ConfirmAction; builder: typeof mocks.buildDropTableSql; sql: string }> = [
  { action: "confirmDropTable", builder: mocks.buildDropTableSql, sql: 'DROP TABLE "APP"."ORDERS";' },
  { action: "confirmEmptyTable", builder: mocks.buildEmptyTableSql, sql: 'DELETE FROM "APP"."ORDERS";' },
  { action: "confirmTruncateTable", builder: mocks.buildTruncateTableSql, sql: 'TRUNCATE TABLE "APP"."ORDERS";' },
];

function tableNode(database: string | null | undefined): TreeNode {
  return {
    id: "hana-1::APP:ORDERS",
    label: "ORDERS",
    type: "table",
    connectionId: "hana-1",
    database,
    schema: "APP",
    isExpanded: false,
  } as TreeNode;
}

function runtime(database: string | null | undefined) {
  const node = tableNode(database);
  const activeNode = shallowRef(node);
  const connectionStore = {
    ensureConnected: mocks.ensureConnected,
    removeTreeNode: mocks.removeTreeNode,
  } as any;
  const feature = useSidebarTableMutationRuntime({
    activeNode,
    releaseActiveNodeReference: mocks.releaseActiveNodeReference,
    connectionStore,
    currentDatabaseType: () => "saphana",
    databaseTypeForNode: () => "saphana",
    executeWithProductionGuard: mocks.executeWithProductionGuard,
    closeDroppedTableObjectTabsForNode: mocks.closeDroppedTableObjectTabsForNode,
    refreshMutatedTableDataTabsForNode: mocks.refreshMutatedTableDataTabsForNode,
  });
  return { feature, node };
}

describe("useSidebarTableMutationRuntime SAP HANA schema-scoped actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarDangerTarget.value = null;
    dropTablePreviewSql.value = "";
    emptyTablePreviewSql.value = "";
    truncateTablePreviewSql.value = "";
    dropTableCascade.value = false;
    truncateTableCascade.value = false;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.executeWithProductionGuard.mockResolvedValue(undefined);
    mocks.refreshMutatedTableDataTabsForNode.mockResolvedValue(undefined);
    mocks.buildDropTableSql.mockResolvedValue('DROP TABLE "APP"."ORDERS";');
    mocks.buildEmptyTableSql.mockResolvedValue('DELETE FROM "APP"."ORDERS";');
    mocks.buildTruncateTableSql.mockResolvedValue('TRUNCATE TABLE "APP"."ORDERS";');
  });

  it.each(actions)("executes $action with an empty database context", async ({ action, builder, sql }) => {
    const { feature, node } = runtime("");

    await feature[action]();

    expect(mocks.ensureConnected).toHaveBeenCalledOnce();
    expect(mocks.ensureConnected).toHaveBeenCalledWith("hana-1");
    expect(builder).toHaveBeenCalledOnce();
    expect(builder).toHaveBeenCalledWith({ databaseType: "saphana", schema: "APP", tableName: "ORDERS" });
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledOnce();
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(node, sql, { database: "", schema: "APP" });
  });

  it("removes the dropped table and releases its active reference", async () => {
    const { feature, node } = runtime("");

    await feature.confirmDropTable();

    expect(mocks.closeDroppedTableObjectTabsForNode).toHaveBeenCalledWith(node);
    expect(mocks.removeTreeNode).toHaveBeenCalledWith(node.id);
    expect(mocks.releaseActiveNodeReference).toHaveBeenCalledWith([node.id]);
  });

  it.each(["confirmEmptyTable", "confirmTruncateTable"] as const)("refreshes data tabs after %s", async (action) => {
    const { feature, node } = runtime("");

    await feature[action]();

    expect(mocks.refreshMutatedTableDataTabsForNode).toHaveBeenCalledWith(node);
  });

  it.each(actions)("preserves $action for a non-empty database context", async ({ action, sql }) => {
    const { feature, node } = runtime("TENANT");

    await feature[action]();

    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(node, sql, { database: "TENANT", schema: "APP" });
  });

  it.each([null, undefined])("rejects a %s database context", async (database) => {
    for (const { action } of actions) {
      const { feature } = runtime(database);
      await feature[action]();
    }

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.buildDropTableSql).not.toHaveBeenCalled();
    expect(mocks.buildEmptyTableSql).not.toHaveBeenCalled();
    expect(mocks.buildTruncateTableSql).not.toHaveBeenCalled();
    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
  });

  it("reports SQL generation failures without dropping local state", async () => {
    const { feature } = runtime("");
    mocks.buildDropTableSql.mockRejectedValueOnce(new Error("generation failed"));

    await feature.confirmDropTable();

    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
    expect(mocks.closeDroppedTableObjectTabsForNode).not.toHaveBeenCalled();
    expect(mocks.removeTreeNode).not.toHaveBeenCalled();
    expect(mocks.releaseActiveNodeReference).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
  });

  it("reports execution failures without refreshing data tabs", async () => {
    const { feature } = runtime("");
    mocks.executeWithProductionGuard.mockRejectedValueOnce(new Error("execution failed"));

    await feature.confirmTruncateTable();

    expect(mocks.refreshMutatedTableDataTabsForNode).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.tableOperationFailed", 5000);
  });
});
