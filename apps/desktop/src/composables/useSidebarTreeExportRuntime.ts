import type { ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useToast } from "@/composables/useToast";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { ColumnInfo, ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { joinExportedDdls } from "@/lib/export/ddlExport";
import { formatSqlInsert } from "@/lib/export/exportFormats";
import { sidebarStructureExportTargets } from "@/lib/sidebar/sidebarExportRuntime";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import { isLoadingStructurePreview, showStructureDocCopyDialog, showStructurePreviewDialog, structureDocCopyText, structureDocCopyTitle, structurePreviewDefaultFileName, structurePreviewError, structurePreviewSql, structurePreviewTitle } from "@/components/sidebar/sidebarTreeDialogState";

type StructureCopyFormat = "tsv" | "markdown";

interface SidebarTreeExportRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  acceptedSelectionIds: () => readonly string[] | null;
}

export function useSidebarTreeExportRuntime(options: SidebarTreeExportRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { addTask: addExportTask } = useExportTracker();
  const { activeNode, connectionStore, settingsStore } = options;

  async function saveFileContent(content: string, defaultFileName: string, filterName: string, filterExt: string) {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (path) await writeTextFile(path, content);
      return;
    }

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = defaultFileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function tableDdlObjectTypeForNode(type: TreeNodeType): ObjectSourceKind | undefined {
    if (type === "view") return "VIEW";
    if (type === "materialized_view") return "MATERIALIZED_VIEW";
    return undefined;
  }

  function structureExportTargets(): Array<TreeNode & { connectionId: string; database: string }> {
    return sidebarStructureExportTargets(activeNode.value, connectionStore.treeNodes, options.acceptedSelectionIds() ?? connectionStore.selectedTreeNodeIds);
  }

  async function exportStructure() {
    const targets = structureExportTargets();
    if (!targets.length) return;
    isLoadingStructurePreview.value = true;
    structurePreviewError.value = "";
    structurePreviewSql.value = "";
    structurePreviewTitle.value = targets.length === 1 ? t("contextMenu.exportStructurePreviewTitle", { name: targets[0]!.label }) : t("contextMenu.exportStructurePreviewTitleMultiple", { count: targets.length });
    structurePreviewDefaultFileName.value = targets.length === 1 ? `${targets[0]!.label}.sql` : "structures.sql";
    showStructurePreviewDialog.value = true;
    try {
      const parts: string[] = [];
      for (const target of targets) {
        await connectionStore.ensureConnected(target.connectionId);
        const ddl = await api.getTableDdl(target.connectionId, target.database, target.schema || target.database, target.label, tableDdlObjectTypeForNode(target.type), target.catalog);
        parts.push(ddl.trim());
      }
      structurePreviewSql.value = joinExportedDdls(parts);
    } catch (error: any) {
      structurePreviewError.value = error?.message || String(error);
      console.error("Export structure failed:", error);
    } finally {
      isLoadingStructurePreview.value = false;
    }
  }

  function structureTargetName(target: TreeNode): string {
    return target.schema ? `${target.schema}.${target.label}` : target.label;
  }

  function columnDocValue(value: unknown): string {
    return value === null || value === undefined ? "" : String(value);
  }

  function tsvCell(value: unknown): string {
    return columnDocValue(value).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
  }

  function markdownCell(value: unknown): string {
    return columnDocValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
  }

  function columnDocHeaders(includeTable: boolean): string[] {
    const headers = [t("contextMenu.structureDocColumn"), t("contextMenu.structureDocType"), t("contextMenu.structureDocPrimaryKey"), t("contextMenu.structureDocNullable"), t("contextMenu.structureDocDefault"), t("contextMenu.structureDocComment")];
    return includeTable ? [t("contextMenu.structureDocTable"), ...headers] : headers;
  }

  function columnDocCells(target: TreeNode, column: ColumnInfo, includeTable: boolean): unknown[] {
    const cells = [column.name, column.data_type, column.is_primary_key ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.is_nullable ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.column_default, column.comment];
    return includeTable ? [structureTargetName(target), ...cells] : cells;
  }

  async function tableColumnsForStructureCopy(target: TreeNode & { connectionId: string; database: string }): Promise<ColumnInfo[]> {
    await connectionStore.ensureConnected(target.connectionId);
    return api.getColumns(target.connectionId, target.database, target.schema || target.database, target.label);
  }

  async function buildStructureCopyText(format: StructureCopyFormat): Promise<string> {
    const targets = structureExportTargets();
    if (!targets.length) return "";
    const includeTable = targets.length > 1;
    const headers = columnDocHeaders(includeTable);

    if (format === "tsv") {
      const lines = [headers.map(tsvCell).join("\t")];
      for (const target of targets) {
        const columns = await tableColumnsForStructureCopy(target);
        for (const column of columns) lines.push(columnDocCells(target, column, includeTable).map(tsvCell).join("\t"));
      }
      return `${lines.join("\n")}\n`;
    }

    const tables: string[] = [];
    const markdownHeaders = columnDocHeaders(false);
    for (const target of targets) {
      const columns = await tableColumnsForStructureCopy(target);
      const tableLines = [`### ${markdownCell(structureTargetName(target))}`, "", `| ${markdownHeaders.map(markdownCell).join(" | ")} |`, `| ${markdownHeaders.map(() => "---").join(" | ")} |`, ...columns.map((column) => `| ${columnDocCells(target, column, false).map(markdownCell).join(" | ")} |`)];
      tables.push(tableLines.join("\n"));
    }
    return `${tables.join("\n\n")}\n`;
  }

  async function copyStructureAs(format: StructureCopyFormat) {
    let text = "";
    try {
      text = await buildStructureCopyText(format);
      if (!text) return;
      await copyToClipboard(text);
      toast(t("contextMenu.structureDocCopied"), 2000);
    } catch (error: any) {
      if (text) {
        structureDocCopyText.value = text;
        structureDocCopyTitle.value = format === "tsv" ? t("contextMenu.copyStructureAsTsv") : t("contextMenu.copyStructureAsMarkdown");
        showStructureDocCopyDialog.value = true;
        return;
      }
      toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function copyStructureDocText() {
    if (!structureDocCopyText.value) return;
    try {
      await copyToClipboard(structureDocCopyText.value);
      toast(t("contextMenu.structureDocCopied"), 2000);
    } catch (error: any) {
      toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function selectTextareaContent(event: FocusEvent) {
    if (event.target instanceof HTMLTextAreaElement) event.target.select();
  }

  async function copyStructurePreview() {
    if (!structurePreviewSql.value) return;
    try {
      await copyToClipboard(structurePreviewSql.value);
      toast(t("contextMenu.exportStructureCopied"), 2000);
    } catch (error: any) {
      toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function saveStructurePreview() {
    if (!structurePreviewSql.value) return;
    try {
      await saveFileContent(structurePreviewSql.value, structurePreviewDefaultFileName.value, "SQL", "sql");
      toast(t("grid.exported"));
    } catch (error: any) {
      toast(t("grid.exportFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function columnTypesForResultColumns(columns: string[], tableColumns: ColumnInfo[]): Array<string | undefined> {
    const typesByName = new Map(tableColumns.map((column) => [column.name.toLocaleLowerCase(), column.data_type]));
    return columns.map((column) => typesByName.get(column.toLocaleLowerCase()));
  }

  async function exportDataLegacy(format: "json" | "sql") {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    const connectionId = node.connectionId;
    const database = node.database;
    const config = connectionStore.getConfig(connectionId);
    if (!config) return;

    try {
      await connectionStore.ensureConnected(connectionId);
      const tableColumns = format === "sql" ? await api.getColumns(connectionId, database, node.schema || database, node.label) : undefined;
      const queryColumns = config.db_type === "neo4j" ? (tableColumns ?? (await api.getColumns(connectionId, database, node.schema || database, node.label))).map((column) => column.name) : undefined;
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      const result = await fetchTableDataForExport({
        databaseType: effectiveDbType,
        identifierQuote: connectionStore.connectionIdentifierQuote?.(connectionId),
        schema: node.schema,
        tableName: node.label,
        tableType: node.tableType,
        columns: queryColumns,
        executePage: (sql) => api.executeQuery(connectionId, database, sql),
      });

      if (format === "json") {
        let outputPath = `${node.label}.json`;
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({ defaultPath: outputPath, filters: [{ name: "JSON", extensions: ["json"] }] });
          if (!path) return;
          outputPath = path as string;
        }
        await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
        return;
      }

      const content = await formatSqlInsert({
        databaseType: effectiveDbType,
        schema: node.schema,
        tableName: node.label,
        columns: result.columns,
        columnTypes: tableColumns ? columnTypesForResultColumns(result.columns, tableColumns) : undefined,
        rows: result.rows,
      });
      await saveFileContent(content, `${node.label}.sql`, "SQL", "sql");
      toast(t("grid.exported"));
    } catch (error: any) {
      toast(t("grid.exportFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function exportTableData(format: "csv" | "xlsx") {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    const connectionId = node.connectionId;
    const database = node.database;
    const config = connectionStore.getConfig(connectionId);
    if (!config) return;

    let task: ExportTask | null = null;
    try {
      await connectionStore.ensureConnected(connectionId);

      // Choose the destination before registering a background task so cancellation creates no orphan tracker entry.
      let outputPath = `${node.label}.${format}`;
      if (isTauriRuntime()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: outputPath,
          filters: [{ name: format === "csv" ? "CSV" : "Excel", extensions: [format] }],
        });
        if (!path) return;
        outputPath = path as string;
      }

      task = addExportTask(node.label, format, outputPath);
      const currentTask = task;
      const queryColumns = config.db_type === "neo4j" ? (await api.getColumns(connectionId, database, node.schema || database, node.label)).map((column) => column.name) : undefined;
      const rowLimit = settingsStore.editorSettings.exportRowLimitEnabled ? settingsStore.editorSettings.exportRowLimit : null;
      const request: api.TableExportRequest = {
        exportId: currentTask.exportId,
        connectionId,
        database,
        schema: node.schema || undefined,
        tableName: node.label,
        filePath: outputPath,
        format,
        columns: queryColumns,
        batchSize: settingsStore.editorSettings.exportBatchSize,
        rowLimit,
      };

      await api.startTableExport(request, (progress) => {
        currentTask.rowsExported = progress.rowsExported;
        currentTask.totalRows = progress.totalRows;
        currentTask.status = progress.status;
        currentTask.errorMessage = progress.errorMessage || null;
        if (progress.status === "Done") toast(t("grid.exported"));
        else if (progress.status === "Error") toast(t("grid.exportFailed", { message: progress.errorMessage || "" }), 5000);
      });
    } catch (error: any) {
      if (task) {
        task.status = "Error";
        task.errorMessage = error?.message || String(error);
      }
      toast(t("grid.exportFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function exportData(format: "csv" | "json" | "sql") {
    if (format === "csv") await exportTableData("csv");
    else await exportDataLegacy(format);
  }

  async function exportDataXlsx() {
    await exportTableData("xlsx");
  }

  return {
    copyStructureAs,
    copyStructureDocText,
    copyStructurePreview,
    exportData,
    exportDataXlsx,
    exportStructure,
    saveStructurePreview,
    selectTextareaContent,
  };
}
