import { computed, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { DatabaseType, TreeNode } from "@/types/database";
import { supportsTableTruncate } from "@/lib/database/databaseCapabilities";
import { buildDropTableSql, buildEmptyTableSql, buildTruncateTableSql, supportsDropTableCascade, supportsTruncateTableCascade, type TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import { sidebarDangerTarget, showDropTableConfirm, showEmptyTableConfirm, showTruncateTableConfirm, dropTablePreviewSql, dropTableCascade, emptyTablePreviewSql, truncateTablePreviewSql, truncateTableCascade } from "@/components/sidebar/sidebarTreeDialogState";

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
  const canDropTableCascade = computed(() => activeNode.value.type === "table" && supportsDropTableCascade(currentDatabaseType()));
  const canTruncateTableCascade = computed(() => activeNode.value.type === "table" && supportsTruncateTableCascade(currentDatabaseType()));

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
    if (!node.connectionId || !node.database) return;
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
    if (!node.connectionId || !node.database) return;
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
    if (!node.connectionId || !node.database) return;
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
    canDropTableCascade,
    canTruncateTableCascade,
    refreshDropTablePreviewSql,
    refreshTruncateTablePreviewSql,
    dropTable,
    refreshTableList,
    confirmDropTable,
    emptyTable,
    confirmEmptyTable,
    truncateTable,
    confirmTruncateTable,
  };
}
