import type { ShallowRef } from "vue";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useQueryStore } from "@/stores/queryStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { TreeNode } from "@/types/database";
import { allDatabasesExportSourceForNode, databaseExportSourceForNode } from "@/lib/sidebar/sidebarExportRuntime";

interface SidebarTreeToolRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  queryStore: ReturnType<typeof useQueryStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  tableChildObjectName: (node: TreeNode) => string;
}

export function useSidebarTreeToolRuntime(options: SidebarTreeToolRuntimeOptions) {
  const { activeNode, connectionStore, queryStore, settingsStore } = options;

  function openTransfer() {
    if (!activeNode.value.connectionId) return;
    connectionStore.transferSource = {
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database ?? "",
    };
  }

  function openSchemaDiff() {
    if (!activeNode.value.connectionId) return;
    connectionStore.schemaDiffSource = {
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database ?? "",
      schema: activeNode.value.schema,
    };
  }

  function openDataCompare() {
    if (!activeNode.value.connectionId) return;
    connectionStore.dataCompareSource = {
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database ?? "",
      schema: activeNode.value.schema,
      tableName: activeNode.value.type === "table" ? activeNode.value.label : undefined,
    };
  }

  function openSqlFileExecution() {
    if (!activeNode.value.connectionId) return;
    connectionStore.sqlFileSource = {
      connectionId: activeNode.value.connectionId,
      database: activeNode.value.database ?? "",
    };
  }

  function openDiagram() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    connectionStore.diagramSource = {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      tableName: node.type === "table" ? node.label : undefined,
    };
  }

  function openDatabaseSearch() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    connectionStore.databaseSearchSource = {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.type === "schema" ? node.schema : undefined,
    };
  }

  function openDatabaseExport() {
    connectionStore.databaseExportSource = databaseExportSourceForNode(activeNode.value);
  }

  function openAllDatabasesExport() {
    connectionStore.databaseExportSource = allDatabasesExportSourceForNode(activeNode.value);
  }

  function openScheduledBackups() {
    settingsStore.requestSettingsNavigation("backups");
  }

  function openTableImport() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    connectionStore.tableImportSource = {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      tableName: node.type === "table" ? node.label : undefined,
    };
  }

  function openStructureEditor() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    if (node.type === "table") {
      queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.label, undefined, undefined, node.catalog);
      return;
    }
    if (node.type === "column" && node.tableName) {
      const columnName = options.tableChildObjectName(node).trim();
      if (!columnName) return;
      queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.tableName, "columns", { kind: "column", name: columnName }, node.catalog);
      return;
    }
    if (node.type === "index" && node.tableName) {
      const indexName = options.tableChildObjectName(node).trim();
      if (!indexName) return;
      queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.tableName, "indexes", { kind: "index", name: indexName }, node.catalog);
    }
  }

  function openFieldLineage() {
    const node = activeNode.value;
    const column = node.type === "column" && node.meta && "name" in node.meta ? node.meta.name : node.label;
    if (node.type !== "column" || !node.connectionId || !node.database || !node.tableName || !column) return;
    connectionStore.fieldLineageSource = {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      tableName: node.tableName,
      columnName: column,
    };
  }

  return {
    openAllDatabasesExport,
    openDataCompare,
    openDatabaseExport,
    openDatabaseSearch,
    openDiagram,
    openFieldLineage,
    openScheduledBackups,
    openSchemaDiff,
    openSqlFileExecution,
    openStructureEditor,
    openTableImport,
    openTransfer,
  };
}
