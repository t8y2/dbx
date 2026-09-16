import { beforeEach, describe, expect, it, vi } from "vitest";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { mysqlAutoIncrementPreviewKey, mysqlAutoIncrementPreviewSql, mysqlAutoIncrementValue, showMysqlAutoIncrementConfirm, sidebarDangerTarget } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  buildMysqlAutoIncrementSql: vi.fn(),
  ensureConnected: vi.fn(),
  executeWithProductionGuard: vi.fn(),
  refreshMutatedTableDataTabsForNode: vi.fn(),
}));

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/database/dbAdminSql", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database/dbAdminSql")>()),
  buildMysqlAutoIncrementSql: mocks.buildMysqlAutoIncrementSql,
}));

import { useSidebarTableMutationRuntime } from "@/composables/useSidebarTableMutationRuntime";

function tableNode(): TreeNode {
  return { id: "mysql-1:sales:events", label: "events", type: "table", connectionId: "mysql-1", database: "sales", isExpanded: false };
}

function runtime(driverProfile: string | undefined = "mysql") {
  const activeNode = shallowRef(tableNode());
  const connectionStore = {
    getConfig: () => ({ id: "mysql-1", db_type: "mysql", driver_profile: driverProfile }),
    ensureConnected: mocks.ensureConnected,
  } as any;
  const feature = useSidebarTableMutationRuntime({
    activeNode,
    releaseActiveNodeReference: vi.fn(),
    connectionStore,
    currentDatabaseType: () => "mysql",
    databaseTypeForNode: () => "mysql",
    executeWithProductionGuard: mocks.executeWithProductionGuard,
    closeDroppedTableObjectTabsForNode: vi.fn(),
    refreshMutatedTableDataTabsForNode: mocks.refreshMutatedTableDataTabsForNode,
  });
  return { ...feature, activeNode };
}

describe("useSidebarTableMutationRuntime MySQL AUTO_INCREMENT action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarDangerTarget.value = null;
    showMysqlAutoIncrementConfirm.value = false;
    mysqlAutoIncrementValue.value = "99";
    mysqlAutoIncrementPreviewSql.value = "";
    mysqlAutoIncrementPreviewKey.value = "";
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.buildMysqlAutoIncrementSql.mockResolvedValue("ALTER TABLE `sales`.`events` AUTO_INCREMENT = 1;");
    mocks.executeWithProductionGuard.mockResolvedValue(undefined);
    mocks.refreshMutatedTableDataTabsForNode.mockResolvedValue(undefined);
  });

  it("opens with value 1 and builds only a preview", async () => {
    const feature = runtime();

    feature.mysqlAutoIncrement();
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalled());

    expect(feature.supportsMysqlAutoIncrement.value).toBe(true);
    expect(mysqlAutoIncrementValue.value).toBe("1");
    expect(showMysqlAutoIncrementConfirm.value).toBe(true);
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
    expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledWith(expect.objectContaining({ driverProfile: "mysql", schema: "sales", value: "1" }));
  });

  it("canceling after open does not connect or execute", async () => {
    const feature = runtime();

    feature.mysqlAutoIncrement();
    await vi.waitFor(() => expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenCalledTimes(1));
    showMysqlAutoIncrementConfirm.value = false;

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.executeWithProductionGuard).not.toHaveBeenCalled();
    expect(mocks.refreshMutatedTableDataTabsForNode).not.toHaveBeenCalled();
  });

  it("executes the validated preview through existing guards and refreshes open data tabs", async () => {
    const feature = runtime();
    mysqlAutoIncrementValue.value = "18446744073709551615";
    mocks.buildMysqlAutoIncrementSql.mockResolvedValueOnce("ALTER TABLE `sales`.`events` AUTO_INCREMENT = 18446744073709551615;");
    await feature.refreshMysqlAutoIncrementPreviewSql();

    await feature.confirmMysqlAutoIncrement();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("mysql-1");
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(tableNode(), mysqlAutoIncrementPreviewSql.value, { database: "sales", schema: undefined });
    expect(mocks.refreshMutatedTableDataTabsForNode).toHaveBeenCalledWith(tableNode());
  });

  it("excludes MySQL-compatible profiles", () => {
    expect(runtime("mariadb").supportsMysqlAutoIncrement.value).toBe(false);
    expect(runtime("tidb").supportsMysqlAutoIncrement.value).toBe(false);
    expect(runtime("oceanbase").supportsMysqlAutoIncrement.value).toBe(false);
    expect(runtime("dolt").supportsMysqlAutoIncrement.value).toBe(false);
    expect(runtime("goldendb").supportsMysqlAutoIncrement.value).toBe(false);
  });

  it("ignores out-of-order preview responses", async () => {
    const resolvers: Array<(sql: string) => void> = [];
    mocks.buildMysqlAutoIncrementSql.mockImplementation(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    const feature = runtime();

    mysqlAutoIncrementValue.value = "1";
    const first = feature.refreshMysqlAutoIncrementPreviewSql();
    mysqlAutoIncrementValue.value = "2";
    const second = feature.refreshMysqlAutoIncrementPreviewSql();
    resolvers[1]!("ALTER TABLE `sales`.`events` AUTO_INCREMENT = 2;");
    await second;
    resolvers[0]!("ALTER TABLE `sales`.`events` AUTO_INCREMENT = 1;");
    await first;

    expect(mysqlAutoIncrementPreviewSql.value).toBe("ALTER TABLE `sales`.`events` AUTO_INCREMENT = 2;");
  });

  it("rebuilds for the frozen confirmation target instead of executing another table's preview", async () => {
    const feature = runtime();
    mysqlAutoIncrementValue.value = "7";
    await feature.refreshMysqlAutoIncrementPreviewSql();
    const orders = { ...tableNode(), id: "mysql-1:sales:orders", label: "orders" };
    sidebarDangerTarget.value = orders;
    mocks.buildMysqlAutoIncrementSql.mockResolvedValueOnce("ALTER TABLE `sales`.`orders` AUTO_INCREMENT = 7;");

    await feature.confirmMysqlAutoIncrement();

    expect(mocks.buildMysqlAutoIncrementSql).toHaveBeenLastCalledWith(expect.objectContaining({ tableName: "orders", value: "7" }));
    expect(mocks.executeWithProductionGuard).toHaveBeenCalledWith(orders, "ALTER TABLE `sales`.`orders` AUTO_INCREMENT = 7;", { database: "sales", schema: undefined });
  });
});
