import { createApp, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import i18n from "@/i18n";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useToast } from "@/composables/useToast";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { ColumnInfo, ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import { joinExportedDdls } from "@/lib/export/ddlExport";
import { translateBackendError } from "@/i18n/backend-errors";
import { sidebarStructureExportTargets, sidebarTableDataExportTargets } from "@/lib/sidebar/sidebarExportRuntime";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import XlsxHeaderDialog from "@/components/export/XlsxHeaderDialog.vue";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments, type XlsxExportOptions, type XlsxHeaderMode } from "@/lib/export/xlsxHeader";
import { isLoadingStructurePreview, showStructureDocCopyDialog, showStructurePreviewDialog, structureDocCopyText, structureDocCopyTitle, structurePreviewDefaultFileName, structurePreviewError, structurePreviewSql, structurePreviewTitle } from "@/components/sidebar/sidebarTreeDialogState";

type StructureCopyFormat = "tsv" | "markdown";

interface SidebarTreeExportRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  connectionStore: ReturnType<typeof useConnectionStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  acceptedSelectionIds: () => readonly string[] | null;
}

interface SidebarTableExportTarget {
  nodeId: string;
  connectionId: string;
  database: string;
  schema?: string;
  metadataSchema: string;
  catalog?: string;
  tableName: string;
  tableType?: string;
  databaseType: ReturnType<typeof effectiveDatabaseTypeForConnection>;
  loadColumnMetadata: boolean;
  identifierQuote?: string;
  batchSize: number;
  rowLimit: number | null;
  fileNameBase?: string;
}

function tableExportTargetCacheKey(target: Pick<SidebarTableExportTarget, "nodeId">): string {
  return target.nodeId;
}

/**
 * Batch exports share one output directory, so same-name tables from different
 * schemas would silently overwrite each other. Qualify colliding names with
 * their schema and fall back to numeric suffixes for remaining collisions.
 */
function applyTableExportFileBaseNames(targets: readonly SidebarTableExportTarget[]): void {
  const tableNameCounts = new Map<string, number>();
  for (const target of targets) tableNameCounts.set(target.tableName, (tableNameCounts.get(target.tableName) ?? 0) + 1);

  const usedNames = new Set<string>();
  for (const target of targets) {
    const base = (tableNameCounts.get(target.tableName) ?? 0) > 1 && target.schema ? `${target.schema}.${target.tableName}` : target.tableName;
    let name = base;
    let suffix = 2;
    while (usedNames.has(name)) name = `${base}-${suffix++}`;
    usedNames.add(name);
    target.fileNameBase = name;
  }
}

interface ExportTableDataOptions {
  columnInfos?: ColumnInfo[];
  headerMode?: XlsxHeaderMode;
  autoFilter?: boolean;
  outputDirectory?: string;
  suppressDoneToast?: boolean;
}

function joinExportFilePath(directory: string, fileName: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith(separator) ? `${directory}${fileName}` : `${directory}${separator}${fileName}`;
}

export function useSidebarTreeExportRuntime(options: SidebarTreeExportRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { addTask: addExportTask, updateTableExportTask } = useExportTracker();
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

  function tableDataExportTargets(): Array<TreeNode & { connectionId: string; database: string }> {
    return sidebarTableDataExportTargets(activeNode.value, connectionStore.treeNodes, options.acceptedSelectionIds() ?? connectionStore.selectedTreeNodeIds);
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
        const ddl = await api.getTableDdl(target.connectionId, target.database, target.schema || target.database, target.label, tableDdlObjectTypeForNode(target.type), target.catalog, true);
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

  function columnDocCells(target: TreeNode & { connectionId: string }, column: ColumnInfo, includeTable: boolean): unknown[] {
    const config = connectionStore.getConfig(target.connectionId);
    const isGaussdbM = effectiveDatabaseTypeForConnection(config) === "gaussdb" && config?.driver_profile?.toLowerCase() === "gaussdb-m";
    const sourceDataType = column.data_type;
    const dataType = isGaussdbM && sourceDataType ? gaussdbMTypeDisplayName(sourceDataType) : sourceDataType;
    const cells = [column.name, dataType, column.is_primary_key ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.is_nullable ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.column_default, column.comment];
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

  async function pickTableExportDirectory(): Promise<string | null> {
    if (!isTauriRuntime()) return "";
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: t("contextMenu.exportDataSelectDirectory") });
    return typeof selected === "string" ? selected : null;
  }

  async function resolveTableExportOutputPath(target: SidebarTableExportTarget, format: string, outputDirectory?: string): Promise<string | null> {
    const fileName = `${target.fileNameBase ?? target.tableName}.${format}`;
    if (outputDirectory !== undefined) {
      return outputDirectory ? joinExportFilePath(outputDirectory, fileName) : fileName;
    }
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const filterName = format === "csv" ? "CSV" : format === "json" ? "JSON" : format === "xlsx" ? "Excel" : "SQL";
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: filterName, extensions: [format] }],
      });
      return path ? String(path) : null;
    }
    return fileName;
  }

  async function exportDataLegacyForTarget(target: SidebarTableExportTarget, outputDirectory?: string, suppressDoneToast = false) {
    const { connectionId, database } = target;
    const config = connectionStore.getConfig(connectionId);
    if (!config) return false;

    try {
      await connectionStore.ensureConnected(connectionId);
      const queryColumns = config.db_type === "neo4j" ? (await api.getColumns(connectionId, database, target.metadataSchema, target.tableName, target.catalog)).map((column) => column.name) : undefined;
      const result = await fetchTableDataForExport({
        databaseType: target.databaseType,
        identifierQuote: target.identifierQuote,
        schema: target.schema,
        tableName: target.tableName,
        tableType: target.tableType,
        columns: queryColumns,
        executePage: (sql) => api.executeQuery(connectionId, database, sql),
      });

      const outputPath = await resolveTableExportOutputPath(target, "json", outputDirectory);
      if (!outputPath) return false;
      await api.exportQueryResultJson(outputPath, result.columns, result.rows);
      if (!suppressDoneToast) toast(t("grid.exported"));
      return true;
    } catch (error: any) {
      toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
      return false;
    }
  }

  function showSidebarTreeXlsxHeaderDialog(hasComments: boolean): Promise<XlsxExportOptions | null> {
    if (typeof document === "undefined") return Promise.resolve({ headerMode: "name", autoFilter: false });

    return new Promise((resolve) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const app = createApp(XlsxHeaderDialog, {
        open: true,
        showHeaderOptions: hasComments,
        onConfirm: (exportOptions: XlsxExportOptions) => {
          resolve(exportOptions);
          app.unmount();
          document.body.removeChild(container);
        },
        onCancel: () => {
          resolve(null);
          app.unmount();
          document.body.removeChild(container);
        },
      });
      app.use(i18n);
      app.mount(container);
    });
  }

  function tableExportTargetFromNode(node: TreeNode): SidebarTableExportTarget | null {
    if (!node.connectionId || !node.database) return null;
    const connectionId = node.connectionId;
    const database = node.database;
    const config = connectionStore.getConfig(connectionId);
    if (!config) return null;
    const editorSettings = settingsStore.editorSettings;

    return {
      nodeId: node.id,
      connectionId,
      database,
      schema: node.schema || undefined,
      metadataSchema: node.schema || database,
      catalog: node.catalog,
      tableName: node.label,
      tableType: node.tableType,
      databaseType: effectiveDatabaseTypeForConnection(config),
      loadColumnMetadata: config.db_type === "neo4j",
      identifierQuote: connectionStore.connectionIdentifierQuote(connectionId),
      batchSize: editorSettings.exportBatchSize,
      rowLimit: editorSettings.exportRowLimitEnabled ? editorSettings.exportRowLimit : null,
    };
  }

  function currentTableExportTargets(): SidebarTableExportTarget[] {
    const targets = tableDataExportTargets()
      .map((node) => tableExportTargetFromNode(node))
      .filter((target): target is SidebarTableExportTarget => target != null);
    applyTableExportFileBaseNames(targets);
    return targets;
  }

  async function exportTableData(target: SidebarTableExportTarget, format: "csv" | "xlsx" | "sql", exportOptions: ExportTableDataOptions = {}) {
    const { columnInfos, headerMode = "name", autoFilter = true, outputDirectory, suppressDoneToast = false } = exportOptions;
    const { connectionId, database } = target;

    let task: ExportTask | null = null;
    try {
      const outputPath = await resolveTableExportOutputPath(target, format, outputDirectory);
      if (!outputPath) return false;

      await connectionStore.ensureConnected(connectionId);
      task = addExportTask(target.tableName, format, outputPath);
      const currentTask = task;
      const exportColumnInfos = columnInfos ?? (target.loadColumnMetadata ? await api.getColumns(connectionId, database, target.metadataSchema, target.tableName, target.catalog) : undefined);
      const queryColumns = exportColumnInfos?.map((column) => column.name);
      const primaryKeys = exportColumnInfos?.filter((column) => column.is_primary_key).map((column) => column.name);
      if (target.databaseType === "victoriametrics") {
        const result = await fetchTableDataForExport({
          databaseType: target.databaseType,
          schema: target.schema,
          tableName: target.tableName,
          tableType: target.tableType,
          executePage: (sql) => api.executeQuery(connectionId, database, sql),
        });
        if (format === "csv") {
          await api.exportQueryResultCsv(outputPath, result.columns, result.rows);
        } else {
          const comments = result.columns.map((name) => exportColumnInfos?.find((column) => column.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.comment);
          const headerOverrides = buildXlsxHeaderOverrides(result.columns, comments, headerMode);
          await api.exportQueryResultXlsx(outputPath, target.tableName, result.columns, result.column_types ?? result.columns.map(() => ""), headerOverrides, result.rows, undefined, autoFilter);
        }
        currentTask.status = "Done";
        currentTask.rowsExported = result.rows.length;
        currentTask.totalRows = result.rows.length;
        if (!suppressDoneToast) toast(t("grid.exported"));
        return true;
      }
      const columnComments =
        format === "xlsx" && exportColumnInfos
          ? buildXlsxHeaderOverrides(
              exportColumnInfos.map((column) => column.name),
              exportColumnInfos.map((column) => column.comment),
              headerMode,
            )
          : undefined;
      const request: api.TableExportRequest = {
        exportId: currentTask.exportId,
        connectionId,
        database,
        schema: target.schema,
        identifierQuote: target.identifierQuote,
        tableName: target.tableName,
        filePath: outputPath,
        format,
        columns: queryColumns,
        columnComments,
        autoFilter: format === "xlsx" ? autoFilter : undefined,
        primaryKeys,
        batchSize: target.batchSize,
        skipCount: format === "sql",
        rowLimit: target.rowLimit,
      };

      await api.startTableExport(request, (progress) => {
        updateTableExportTask(currentTask.exportId, progress);
        if (progress.status === "Done") {
          if (!suppressDoneToast) toast(t("grid.exported"));
        } else if (progress.status === "Error") toast(t("grid.exportFailed", { message: translateBackendError(t, progress.errorMessage || "") }), 5000);
      });
      return true;
    } catch (error: any) {
      if (task) {
        task.status = "Error";
        task.errorMessage = error?.message || String(error);
      }
      toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
      return false;
    }
  }

  async function resolveMultiTableExportDirectory(targetCount: number): Promise<string | undefined | null> {
    if (targetCount <= 1) return undefined;
    if (!isTauriRuntime()) return "";
    return pickTableExportDirectory();
  }

  async function exportData(format: "csv" | "json" | "sql") {
    const targets = currentTableExportTargets();
    if (!targets.length) return;

    const outputDirectory = await resolveMultiTableExportDirectory(targets.length);
    if (outputDirectory === null) return;

    if (format === "json") {
      let exported = 0;
      for (const target of targets) {
        if (await exportDataLegacyForTarget(target, outputDirectory, targets.length > 1)) exported += 1;
      }
      if (targets.length > 1 && exported > 0) toast(t("contextMenu.exportDataMultipleSuccess", { count: exported }));
      return;
    }

    let exported = 0;
    for (const target of targets) {
      if (await exportTableData(target, format, { outputDirectory, suppressDoneToast: targets.length > 1 })) exported += 1;
    }
    if (targets.length > 1 && exported > 0) toast(t("contextMenu.exportDataMultipleSuccess", { count: exported }));
  }

  async function exportDataXlsx() {
    const targets = currentTableExportTargets();
    if (!targets.length) return;

    const columnInfosByTarget = new Map<string, ColumnInfo[] | undefined>();
    let hasComments = false;
    for (const target of targets) {
      let columnInfos: ColumnInfo[] | undefined;
      try {
        await connectionStore.ensureConnected(target.connectionId);
        columnInfos = await api.getColumns(target.connectionId, target.database, target.metadataSchema, target.tableName, target.catalog);
        if (hasXlsxHeaderComments(columnInfos.map((column) => column.comment))) hasComments = true;
      } catch {
        // Export still works with field-name headers when column metadata is unavailable.
      }
      columnInfosByTarget.set(tableExportTargetCacheKey(target), columnInfos);
    }

    const xlsxOptions = await showSidebarTreeXlsxHeaderDialog(hasComments);
    if (xlsxOptions === null) return;

    const outputDirectory = await resolveMultiTableExportDirectory(targets.length);
    if (outputDirectory === null) return;

    let exported = 0;
    for (const target of targets) {
      if (
        await exportTableData(target, "xlsx", {
          columnInfos: columnInfosByTarget.get(tableExportTargetCacheKey(target)),
          headerMode: xlsxOptions.headerMode,
          autoFilter: xlsxOptions.autoFilter,
          outputDirectory,
          suppressDoneToast: targets.length > 1,
        })
      ) {
        exported += 1;
      }
    }
    if (targets.length > 1 && exported > 0) toast(t("contextMenu.exportDataMultipleSuccess", { count: exported }));
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
