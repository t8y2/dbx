import { computed, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { DatabaseType, TreeNode } from "@/types/database";
import { supportsTableTruncate, supportsTableVacuum } from "@/lib/database/databaseCapabilities";
import {
  buildDropTableSql,
  buildEmptyTableSql,
  buildMysqlAutoIncrementSql,
  buildTruncateTableSql,
  buildVacuumTableSql,
  supportsDropTableCascade,
  supportsNativeMysqlAutoIncrement,
  supportsTruncateTableCascade,
  type MysqlAutoIncrementSqlOptions,
  type TableAdminSqlOptions,
  type VacuumTableSqlOptions,
} from "@/lib/database/dbAdminSql";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import {
  sidebarDangerTarget,
  showDropTableConfirm,
  showEmptyTableConfirm,
  showMysqlAutoIncrementConfirm,
  showTruncateTableConfirm,
  showVacuumTableConfirm,
  dropTablePreviewSql,
  dropTableCascade,
  emptyTablePreviewSql,
  mysqlAutoIncrementPreviewKey,
  mysqlAutoIncrementPreviewSql,
  mysqlAutoIncrementValue,
  truncateTablePreviewSql,
  truncateTableCascade,
  vacuumTableFull,
  vacuumTableAnalyze,
  vacuumTablePreviewSql,
  vacuumTablePreviewKey,
  vacuumTableExecuting,
} from "@/components/sidebar/sidebarTreeDialogState";

interface SidebarTableMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  releaseActiveNodeReference: (nodeIds: readonly string[]) => void;
  connectionStore: ReturnType<typeof useConnectionStore>;
  currentDatabaseType: () => DatabaseType | undefined;
  databaseTypeForNode: (node: TreeNode) => DatabaseType | undefined;
  executeWithProductionGuard: (node: Pick<TreeNode, "connectionId" | "database" | "schema">, sql: string, options?: { database?: string; schema?: string }) => Promise<unknown>;
  closeDroppedTableObjectTabsForNode: (node: TreeNode) => void;
  refreshMutatedTableDataTabsForNode: (node: TreeNode) => Promise<void>;
}

export function useSidebarTableMutationRuntime(options: SidebarTableMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, connectionStore, currentDatabaseType, databaseTypeForNode } = options;

  const isTableNotView = computed(() => activeNode.value.type === "table" && !isSqlServerLinkedNode(activeNode.value));
  const supportsTruncate = computed(() => supportsTableTruncate(currentDatabaseType()));
  const supportsVacuum = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "table" && !config?.read_only && supportsTableVacuum(currentDatabaseType());
  });
  const canDropTableCascade = computed(() => activeNode.value.type === "table" && supportsDropTableCascade(currentDatabaseType()));
  const canTruncateTableCascade = computed(() => activeNode.value.type === "table" && supportsTruncateTableCascade(currentDatabaseType()));
  const supportsMysqlAutoIncrement = computed(() => activeNode.value.type === "table" && supportsNativeMysqlAutoIncrement(activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined));

  function tableAdminSqlOptions(optionsOverride?: { cascade?: boolean }): TableAdminSqlOptions {
    const result: TableAdminSqlOptions = {
      databaseType: currentDatabaseType(),
      schema: activeNode.value.schema,
      tableName: activeNode.value.label,
    };
    if (optionsOverride?.cascade) result.cascade = true;
    return result;
  }

  function tableAdminSqlOptionsForNode(node: TreeNode, optionsOverride?: { cascade?: boolean }): TableAdminSqlOptions {
    const result: TableAdminSqlOptions = {
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
    };
    if (optionsOverride?.cascade) result.cascade = true;
    return result;
  }

  function dropTableSqlOptions(): TableAdminSqlOptions {
    return tableAdminSqlOptions({ cascade: canDropTableCascade.value && dropTableCascade.value });
  }

  function truncateTableSqlOptions(): TableAdminSqlOptions {
    return tableAdminSqlOptions({ cascade: canTruncateTableCascade.value && truncateTableCascade.value });
  }

  async function refreshDropTablePreviewSql() {
    dropTablePreviewSql.value = "";
    dropTablePreviewSql.value = await buildDropTableSql(dropTableSqlOptions()).catch(() => "");
  }

  async function refreshEmptyTablePreviewSql() {
    emptyTablePreviewSql.value = "";
    emptyTablePreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions()).catch(() => "");
  }

  async function refreshTruncateTablePreviewSql() {
    truncateTablePreviewSql.value = "";
    truncateTablePreviewSql.value = await buildTruncateTableSql(truncateTableSqlOptions()).catch(() => "");
  }

  function mysqlAutoIncrementSqlOptionsForNode(node: TreeNode): MysqlAutoIncrementSqlOptions {
    const config = node.connectionId ? connectionStore.getConfig(node.connectionId) : undefined;
    return {
      databaseType: config?.db_type ?? databaseTypeForNode(node) ?? "mysql",
      driverProfile: config?.driver_profile,
      schema: node.database || node.schema,
      tableName: node.label,
      value: mysqlAutoIncrementValue.value,
    };
  }

  function mysqlAutoIncrementPreviewKeyForNode(node: TreeNode, sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node)): string {
    return JSON.stringify([node.id, node.connectionId, node.database, sqlOptions.databaseType, sqlOptions.driverProfile?.trim().toLowerCase() || "", sqlOptions.schema || "", sqlOptions.tableName, sqlOptions.value]);
  }

  async function refreshMysqlAutoIncrementPreviewSql() {
    const node = activeNode.value;
    const sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node);
    const previewKey = mysqlAutoIncrementPreviewKeyForNode(node, sqlOptions);
    mysqlAutoIncrementPreviewSql.value = "";
    mysqlAutoIncrementPreviewKey.value = "";
    const sql = await buildMysqlAutoIncrementSql(sqlOptions).catch(() => "");
    if (previewKey !== mysqlAutoIncrementPreviewKeyForNode(activeNode.value)) return;
    mysqlAutoIncrementPreviewSql.value = sql;
    mysqlAutoIncrementPreviewKey.value = sql ? previewKey : "";
  }

  function mysqlAutoIncrement() {
    if (!supportsMysqlAutoIncrement.value) return;
    mysqlAutoIncrementValue.value = "1";
    mysqlAutoIncrementPreviewKey.value = "";
    void refreshMysqlAutoIncrementPreviewSql();
    showMysqlAutoIncrementConfirm.value = true;
  }

  async function confirmMysqlAutoIncrement() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || !node.database) return;
    try {
      const config = connectionStore.getConfig(node.connectionId);
      if (!supportsNativeMysqlAutoIncrement(config)) throw new Error("Setting AUTO_INCREMENT is supported only for native MySQL connections.");
      await connectionStore.ensureConnected(node.connectionId);
      const sqlOptions = mysqlAutoIncrementSqlOptionsForNode(node);
      const previewKey = mysqlAutoIncrementPreviewKeyForNode(node, sqlOptions);
      const sql = mysqlAutoIncrementPreviewKey.value === previewKey && mysqlAutoIncrementPreviewSql.value ? mysqlAutoIncrementPreviewSql.value : await buildMysqlAutoIncrementSql(sqlOptions);
      await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      toast(t("contextMenu.mysqlAutoIncrementSuccess", { name: node.label, value: mysqlAutoIncrementValue.value }), 3000);
      await options.refreshMutatedTableDataTabsForNode(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function vacuumTableSqlOptions(node: TreeNode, full = vacuumTableFull.value, analyze = vacuumTableAnalyze.value): VacuumTableSqlOptions {
    return {
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
      full,
      analyze,
    };
  }

  function vacuumTablePreviewKeyForNode(node: TreeNode, full = vacuumTableFull.value, analyze = vacuumTableAnalyze.value): string {
    return JSON.stringify([node.id, databaseTypeForNode(node), node.schema || "", node.label, full, analyze]);
  }

  async function refreshVacuumTablePreviewSql() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const full = vacuumTableFull.value;
    const analyze = vacuumTableAnalyze.value;
    const previewKey = vacuumTablePreviewKeyForNode(node, full, analyze);
    vacuumTablePreviewSql.value = "";
    vacuumTablePreviewKey.value = "";
    const sql = await buildVacuumTableSql(vacuumTableSqlOptions(node, full, analyze)).catch(() => "");
    const currentNode = sidebarDangerTarget.value ?? activeNode.value;
    if (previewKey !== vacuumTablePreviewKeyForNode(currentNode)) return;
    vacuumTablePreviewSql.value = sql;
    vacuumTablePreviewKey.value = sql ? previewKey : "";
  }

  function vacuumTable() {
    if (!supportsVacuum.value) return;
    vacuumTableFull.value = false;
    vacuumTableAnalyze.value = false;
    vacuumTablePreviewSql.value = "";
    vacuumTablePreviewKey.value = "";
    void refreshVacuumTablePreviewSql();
    showVacuumTableConfirm.value = true;
  }

  async function confirmVacuumTable(): Promise<boolean> {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || node.database == null) return false;
    vacuumTableExecuting.value = true;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const optionsForNode = vacuumTableSqlOptions(node, vacuumTableFull.value, vacuumTableAnalyze.value);
      const previewKey = vacuumTablePreviewKeyForNode(node);
      const sql = vacuumTablePreviewKey.value === previewKey && vacuumTablePreviewSql.value ? vacuumTablePreviewSql.value : await buildVacuumTableSql(optionsForNode);
      const executed = await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      if (executed === undefined) return false;
      toast(t("contextMenu.vacuumTableSuccess", { name: node.label }), 3000);
      return true;
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
      return false;
    } finally {
      vacuumTableExecuting.value = false;
    }
  }

  async function refreshVacuumPreviewForOptions() {
    await refreshVacuumTablePreviewSql();
  }

  function dropTable() {
    dropTableCascade.value = false;
    void refreshDropTablePreviewSql();
    showDropTableConfirm.value = true;
  }

  async function refreshTableList(node: TreeNode) {
    if (!node.connectionId || !node.database) return;
    await connectionStore.refreshObjectListTreeNode(node.connectionId, node.database, node.schema);
  }

  async function confirmDropTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || node.database == null) return;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const sql = dropTablePreviewSql.value || (await buildDropTableSql(tableAdminSqlOptionsForNode(node, { cascade: dropTableCascade.value && supportsDropTableCascade(databaseTypeForNode(node)) })));
      await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      toast(t("contextMenu.dropTableSuccess", { name: node.label }), 3000);
      options.closeDroppedTableObjectTabsForNode(node);
      connectionStore.removeTreeNode(node.id);
      options.releaseActiveNodeReference([node.id]);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function emptyTable() {
    void refreshEmptyTablePreviewSql();
    showEmptyTableConfirm.value = true;
  }

  async function confirmEmptyTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || node.database == null) return;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const sql = emptyTablePreviewSql.value || (await buildEmptyTableSql(tableAdminSqlOptionsForNode(node)));
      await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      const messageKey = databaseTypeForNode(node) === "clickhouse" ? "contextMenu.emptyTableSubmitted" : "contextMenu.emptyTableSuccess";
      toast(t(messageKey, { name: node.label }), 3000);
      await options.refreshMutatedTableDataTabsForNode(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function truncateTable() {
    truncateTableCascade.value = false;
    void refreshTruncateTablePreviewSql();
    showTruncateTableConfirm.value = true;
  }

  async function confirmTruncateTable() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (!node.connectionId || node.database == null) return;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const sql = truncateTablePreviewSql.value || (await buildTruncateTableSql(tableAdminSqlOptionsForNode(node, { cascade: truncateTableCascade.value && supportsTruncateTableCascade(databaseTypeForNode(node)) })));
      await options.executeWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
      toast(t("contextMenu.truncateTableSuccess", { name: node.label }), 3000);
      await options.refreshMutatedTableDataTabsForNode(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  return {
    isTableNotView,
    supportsTruncate,
    supportsVacuum,
    canDropTableCascade,
    canTruncateTableCascade,
    supportsMysqlAutoIncrement,
    refreshDropTablePreviewSql,
    refreshTruncateTablePreviewSql,
    dropTable,
    refreshTableList,
    confirmDropTable,
    emptyTable,
    confirmEmptyTable,
    truncateTable,
    confirmTruncateTable,
    vacuumTable,
    refreshVacuumPreviewForOptions,
    confirmVacuumTable,
    mysqlAutoIncrement,
    refreshMysqlAutoIncrementPreviewSql,
    confirmMysqlAutoIncrement,
  };
}
