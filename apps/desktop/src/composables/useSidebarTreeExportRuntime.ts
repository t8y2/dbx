import { supportsDdlStoragePreference } from "@/lib/sql/ddlStorage";
import { applyDdlTextPreferences } from "@/lib/sql/ddlPreferences";
import { watch, createApp, getCurrentScope, onScopeDispose, type ShallowRef } from "vue";
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
import { promptExportSavePath } from "@/lib/export/exportPath";
import { notifyExportComplete } from "@/lib/export/exportReveal";
import { translateBackendError } from "@/i18n/backend-errors";
import { sidebarStructureExportTargets, sidebarTableDataExportTargets } from "@/lib/sidebar/sidebarExportRuntime";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import { dropsSchemaQualifier } from "@/lib/table/tableSelectSql";
import XlsxHeaderDialog from "@/components/export/XlsxHeaderDialog.vue";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments, xlsxHeaderUsesCommentRows, type XlsxExportOptions, type XlsxHeaderMode } from "@/lib/export/xlsxHeader";
import {
  isLoadingStructurePreview,
  showStructureDocCopyDialog,
  showStructurePreviewDialog,
  structureDocCopyText,
  structureDocCopyTitle,
  structurePreviewDefaultFileName,
  structurePreviewError,
  structurePreviewSql,
  structurePreviewTitle,
  structurePreviewDdlStorageType,
} from "@/components/sidebar/sidebarTreeDialogState";
import type { CsvQuoteMode } from "@/lib/export/csvQuoteMode";
import { csvNullLiteralForMode } from "@/lib/export/csvNullMode";
import type { SqlInsertDialect } from "@/lib/export/sqlInsertMode";
import { uuid } from "@/lib/common/utils";
import { showExportExecutionModeDialog } from "@/lib/export/exportExecutionMode";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { SnapshotCompletionError } from "@/lib/export/snapshotCompletion";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";
import { mysqlDataCharsetEnabled } from "@/lib/connection/mysqlDataCharset";

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
  csvQuoteMode: CsvQuoteMode;
  /** 导出 CSV 时 NULL 的字面量；空串表示关闭（旧行为）。 */
  nullLiteral: string;
  primaryKeyMode: api.TableExportRequest["primaryKeyMode"];
  omitDatabaseQualifier: boolean;
  dateTimeFormat?: string;
  connectionFingerprint: string;
  connectionType: string;
  queryTimeoutSecs?: number;
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
  insertDialect?: SqlInsertDialect;
  operation?: {
    outputPath: string;
    task?: ExportTask;
    check: () => void;
    read: <T>(request: () => Promise<T>, cleanup?: boolean) => Promise<T>;
    setActive: (task: ExportTask, cancel: (() => Promise<void>) | undefined) => void;
  };
}

function joinExportFilePath(directory: string, fileName: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith(separator) ? `${directory}${fileName}` : `${directory}${separator}${fileName}`;
}

export function useSidebarTreeExportRuntime(options: SidebarTreeExportRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const tracker = useExportTracker();
  const { addTask: addExportTask, updateTableExportTask } = tracker;
  const { activeNode, connectionStore, settingsStore } = options;

  async function saveFileContent(content: string, defaultFileName: string, filterName: string, filterExt: string) {
    if (isTauriRuntime()) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await promptExportSavePath({
        defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
        preferredPath: settingsStore.editorSettings.preferredExportPath,
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

  let structureSource: Array<{ ddl: string; databaseType: ReturnType<typeof effectiveDatabaseTypeForConnection> }> = [];
  let structureTargets: ReturnType<typeof structureExportTargets> = [];
  let structureRequestId = 0;
  function invalidateStructureRequest() {
    structureRequestId++;
    structureSource = [];
    structureTargets = [];
    isLoadingStructurePreview.value = false;
  }
  watch(
    showStructurePreviewDialog,
    (visible) => {
      if (!visible) invalidateStructureRequest();
    },
    { flush: "sync" },
  );
  if (getCurrentScope()) onScopeDispose(invalidateStructureRequest);
  function renderStructurePreview() {
    structurePreviewSql.value = joinExportedDdls(structureSource.map(({ ddl, databaseType }) => applyDdlTextPreferences(ddl, databaseType, settingsStore.editorSettings)));
  }
  watch([() => settingsStore.editorSettings.includeDdlStorage, () => settingsStore.editorSettings.compactDdlSql], () => {
    if (showStructurePreviewDialog.value && structureSource.length) renderStructurePreview();
  });

  watch(
    () => settingsStore.editorSettings.separateDdlIndexes,
    () => {
      if (showStructurePreviewDialog.value && structureTargets.length) void loadStructurePreview(structureTargets);
    },
  );

  async function exportStructure() {
    await loadStructurePreview(structureExportTargets());
  }

  async function loadStructurePreview(targets: ReturnType<typeof structureExportTargets>) {
    if (!targets.length) return;
    const sameTargets =
      targets.length === structureTargets.length &&
      targets.every((target, index) => {
        const previous = structureTargets[index];
        return previous && target.connectionId === previous.connectionId && target.database === previous.database && target.schema === previous.schema && target.catalog === previous.catalog && target.type === previous.type && target.label === previous.label;
      });
    structureTargets = targets.map((target) => ({ ...target }));
    const separateIndexes = settingsStore.editorSettings.separateDdlIndexes;
    const requestId = ++structureRequestId;
    const requestSource: typeof structureSource = [];
    isLoadingStructurePreview.value = true;
    structurePreviewError.value = "";
    if (!sameTargets) structurePreviewSql.value = "";
    structurePreviewDdlStorageType.value = targets.map((target) => effectiveDatabaseTypeForConnection(connectionStore.getConfig(target.connectionId))).find(supportsDdlStoragePreference);
    if (!sameTargets) structureSource = [];
    structurePreviewTitle.value = targets.length === 1 ? t("contextMenu.exportStructurePreviewTitle", { name: targets[0]!.label }) : t("contextMenu.exportStructurePreviewTitleMultiple", { count: targets.length });
    structurePreviewDefaultFileName.value = targets.length === 1 ? `${targets[0]!.label}.sql` : "structures.sql";
    showStructurePreviewDialog.value = true;
    try {
      for (const target of targets) {
        await connectionStore.ensureConnected(target.connectionId);
        if (requestId !== structureRequestId) return;
        const databaseType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(target.connectionId));
        const indexOptions: [boolean?, boolean?, string?] = supportsDdlStoragePreference(databaseType) && separateIndexes ? [undefined, true, target.schema || undefined] : [];
        const ddl = await api.getTableDdl(target.connectionId, target.database, target.schema || target.database, target.label, tableDdlObjectTypeForNode(target.type), target.catalog, true, ...indexOptions);
        if (requestId !== structureRequestId) return;
        requestSource.push({ ddl, databaseType });
      }
      structureSource = requestSource;
      structurePreviewDdlStorageType.value = requestSource.map(({ databaseType }) => databaseType).find(supportsDdlStoragePreference);
      renderStructurePreview();
    } catch (error: any) {
      if (requestId !== structureRequestId) return;
      if (requestSource.length) {
        structureSource = requestSource;
        renderStructurePreview();
      }
      structurePreviewError.value = error?.message || String(error);
      console.error("Export structure failed:", error);
    } finally {
      if (requestId === structureRequestId) isLoadingStructurePreview.value = false;
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

  function exportFilterName(format: string): string {
    if (format === "csv") return "CSV";
    if (format === "json") return "JSON";
    if (format === "ndjson") return "NDJSON";
    if (format === "bson" || format === "bson.gz") return "MongoDB BSON dump";
    if (format === "xlsx") return "Excel";
    return "SQL";
  }

  async function resolveExportOutputPath(fileNameBase: string, format: string, outputDirectory?: string): Promise<string | null> {
    const fileName = `${fileNameBase}.${format}`;
    if (outputDirectory !== undefined) {
      return outputDirectory ? joinExportFilePath(outputDirectory, fileName) : fileName;
    }
    if (isTauriRuntime()) {
      const path = await promptExportSavePath({
        defaultFileName: fileName,
        filters: [{ name: exportFilterName(format), extensions: [format === "bson.gz" ? "gz" : format] }],
        preferredPath: settingsStore.editorSettings.preferredExportPath,
      });
      return path ? String(path) : null;
    }
    return fileName;
  }

  async function resolveTableExportOutputPath(target: SidebarTableExportTarget, format: string, outputDirectory?: string): Promise<string | null> {
    return resolveExportOutputPath(target.fileNameBase ?? target.tableName, format, outputDirectory);
  }

  async function exportDataLegacyForTarget(target: SidebarTableExportTarget, outputDirectory?: string, suppressDoneToast = false, operation?: ExportTableDataOptions["operation"]) {
    const { connectionId, database } = target;
    const config = connectionStore.getConfig(connectionId);
    if (!config && !operation) return false;

    let task: ExportTask | undefined;
    try {
      operation?.check();
      await connectionStore.ensureConnected(connectionId);
      operation?.check();
      if (operation) {
        task = operation.task ?? addExportTask(target.tableName, "json", operation.outputPath);
        operation.setActive(task, undefined);
      }
      const read: NonNullable<ExportTableDataOptions["operation"]>["read"] = operation?.read ?? (<T>(request: () => Promise<T>) => request());
      const connectionType = operation ? target.connectionType : config!.db_type;
      const queryColumns = connectionType === "neo4j" ? (await read(() => api.getColumns(connectionId, database, target.metadataSchema, target.tableName, target.catalog))).map((column) => column.name) : undefined;
      const useAgentCursor = connectionType === "cassandra";
      const clientSessionId = useAgentCursor ? `table-export:${uuid()}` : undefined;
      const result = await fetchTableDataForExport({
        databaseType: target.databaseType,
        identifierQuote: target.identifierQuote,
        schema: target.schema,
        tableName: target.tableName,
        tableType: target.tableType,
        columns: queryColumns,
        useAgentCursor,
        executePage: async (sql, cursorOptions) => {
          const result = await read(() =>
            cursorOptions ? api.executeQuery(connectionId, database, sql, undefined, undefined, { ...cursorOptions, clientSessionId, catalog: target.catalog, timeoutSecs: operation ? target.queryTimeoutSecs : config!.query_timeout_secs }) : api.executeQuery(connectionId, database, sql),
          );
          if (operation) {
            if (result.execution_error) throw new SnapshotCompletionError(result.error?.operationOutcome === "not_started" ? "failed" : "unknown", translateBackendError(t, result.error ?? String(result.rows[0]?.[0] ?? "Query failed")));
            if (result.large_value_cells?.length || result.truncated) throw new SnapshotCompletionError("failed", "Incomplete table export result");
          }
          return result;
        },
        closeCursor: useAgentCursor
          ? async (sessionId) => {
              try {
                if (sessionId) await read(() => api.closeQuerySession(connectionId, database, sessionId, clientSessionId, target.catalog), true);
              } finally {
                await read(() => (operation ? api.closeClientConnectionSession(connectionId, database, clientSessionId!, target.catalog, true) : api.closeClientConnectionSession(connectionId, database, clientSessionId!, target.catalog)), true);
              }
            }
          : undefined,
      });

      operation?.check();
      const outputPath = operation?.outputPath ?? (await resolveTableExportOutputPath(target, "json", outputDirectory));
      if (!outputPath) return false;
      if (task && operation) {
        task.canCancel = false;
        operation.setActive(task, undefined);
      }
      await read(() => api.exportQueryResultJson(outputPath, result.columns, result.rows));
      if (task) {
        task.status = "Done";
        task.rowsExported = result.rows.length;
        task.totalRows = result.rows.length;
        task.finishedAt = Date.now();
      }
      if (!suppressDoneToast) {
        notifyExportComplete({
          filePath: outputPath,
          message: t("grid.exported"),
          openFolderLabel: t("exportProgress.openFolder"),
          toast,
        });
      }
      return true;
    } catch (error: any) {
      if (operation) {
        if (task) {
          task.status = error instanceof SnapshotCompletionError && error.status === "unknown" ? "Unknown" : error instanceof SnapshotCompletionError && error.status === "cancelled" ? "Cancelled" : "Error";
          task.errorMessage = error?.message || String(error);
          task.finishedAt = task.status === "Unknown" ? undefined : Date.now();
        }
        throw error;
      }
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
        showExecutionMode: isTauriRuntime(),
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
      csvQuoteMode: editorSettings.csvQuoteMode,
      nullLiteral: csvNullLiteralForMode(editorSettings.csvNullMode),
      primaryKeyMode: editorSettings.dataGridExtractorOptions.sql.primaryKeyMode,
      omitDatabaseQualifier: dropsSchemaQualifier(effectiveDatabaseTypeForConnection(config), editorSettings.generateSqlIncludeDatabaseName, node.catalog),
      dateTimeFormat: editorSettings.globalDateTimeExportFormat || undefined,
      connectionFingerprint: connectionConfigFingerprint(config),
      connectionType: config.db_type,
      queryTimeoutSecs: config.query_timeout_secs,
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
    const { columnInfos, headerMode = "name", autoFilter = true, outputDirectory, suppressDoneToast = false, insertDialect = "source", operation } = exportOptions;
    const { connectionId, database } = target;

    let task: ExportTask | null = null;
    try {
      const outputPath = operation?.outputPath ?? (await resolveTableExportOutputPath(target, format, outputDirectory));
      if (!outputPath) return false;

      operation?.check();
      await connectionStore.ensureConnected(connectionId);
      operation?.check();
      task = operation?.task ?? addExportTask(target.tableName, format, outputPath);
      const currentTask = task;
      const read = operation?.read ?? (<T>(request: () => Promise<T>) => request());
      operation?.setActive(currentTask, undefined);
      const exportColumnInfos = columnInfos ?? (target.loadColumnMetadata ? await read(() => api.getColumns(connectionId, database, target.metadataSchema, target.tableName, target.catalog)) : undefined);
      const queryColumns = exportColumnInfos?.map((column) => column.name);
      const primaryKeys = exportColumnInfos?.filter((column) => column.is_primary_key).map((column) => column.name);
      if (target.databaseType === "victoriametrics") {
        const result = await fetchTableDataForExport({
          databaseType: target.databaseType,
          schema: target.schema,
          tableName: target.tableName,
          tableType: target.tableType,
          executePage: (sql) => read(() => api.executeQuery(connectionId, database, sql)),
        });
        operation?.check();
        if (operation && (result.execution_error || result.large_value_cells?.length || result.truncated)) throw new SnapshotCompletionError(result.execution_error && result.error?.operationOutcome !== "not_started" ? "unknown" : "failed", "Incomplete table export result");
        if (operation) currentTask.canCancel = false;
        operation?.setActive(currentTask, undefined);
        if (format === "csv") {
          await read(() => api.exportQueryResultCsv(outputPath, result.columns, result.rows, target.csvQuoteMode, target.nullLiteral));
        } else {
          const comments = result.columns.map((name) => exportColumnInfos?.find((column) => column.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.comment);
          const headerOverrides = buildXlsxHeaderOverrides(result.columns, comments, headerMode);
          await read(() => api.exportQueryResultXlsx(outputPath, target.tableName, result.columns, result.column_types ?? result.columns.map(() => ""), headerOverrides, result.rows, undefined, autoFilter, target.dateTimeFormat, xlsxHeaderUsesCommentRows(headerMode)));
        }
        currentTask.status = "Done";
        currentTask.rowsExported = result.rows.length;
        currentTask.totalRows = result.rows.length;
        if (!suppressDoneToast) {
          notifyExportComplete({
            filePath: outputPath,
            message: t("grid.exported"),
            openFolderLabel: t("exportProgress.openFolder"),
            toast,
          });
        }
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
        ...(format === "sql"
          ? {
              insertDialect,
              omitDatabaseQualifier: target.omitDatabaseQualifier,
            }
          : {}),
        csvQuoteMode: target.csvQuoteMode,
        nullLiteral: target.nullLiteral,
        columns: queryColumns,
        columnComments,
        headerCommentRows: format === "xlsx" ? xlsxHeaderUsesCommentRows(headerMode) : undefined,
        autoFilter: format === "xlsx" ? autoFilter : undefined,
        primaryKeys,
        primaryKeyMode: target.primaryKeyMode,
        batchSize: target.batchSize,
        skipCount: format === "sql",
        rowLimit: target.rowLimit,
      };

      operation?.check();
      let terminalSeen = false;
      let terminalProgress: api.TableExportProgress | undefined;
      operation?.setActive(currentTask, () => api.cancelTableExport(currentTask.exportId));
      const onProgress = (progress: api.TableExportProgress) => {
        terminalSeen ||= progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled";
        if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") terminalProgress = progress;
        updateTableExportTask(currentTask.exportId, progress);
        if (progress.status === "Done") {
          if (!suppressDoneToast) {
            notifyExportComplete({
              filePath: request.filePath,
              message: t("grid.exported"),
              openFolderLabel: t("exportProgress.openFolder"),
              toast,
            });
          }
        } else if (progress.status === "Error") toast(t("grid.exportFailed", { message: translateBackendError(t, progress.errorMessage || "") }), 5000);
      };
      await (operation ? api.startTableExport(request, onProgress, true) : api.startTableExport(request, onProgress)).catch((error) => {
        if (error instanceof SnapshotCompletionError && error.status === "failed") throw error;
        if (operation && !terminalSeen) throw new SnapshotCompletionError("unknown", error instanceof Error ? error.message : String(error));
        if (operation && terminalProgress?.status === "Done") return terminalProgress;
        if (operation && terminalProgress?.status === "Cancelled") throw new SnapshotCompletionError("cancelled", terminalProgress.errorMessage || "Export cancelled");
        throw error;
      });
      if (operation && !terminalSeen) throw new SnapshotCompletionError("unknown", "Export completion was not confirmed");
      if (operation && terminalProgress) updateTableExportTask(currentTask.exportId, terminalProgress);
      return true;
    } catch (error: any) {
      if (operation) {
        if (task) {
          task.status = error instanceof SnapshotCompletionError && error.status === "unknown" ? "Unknown" : error instanceof SnapshotCompletionError && error.status === "cancelled" ? "Cancelled" : "Error";
          task.errorMessage = error?.message || String(error);
          task.finishedAt = task.status === "Unknown" ? undefined : Date.now();
        }
        throw error;
      }
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

  async function submitTableExports(targets: SidebarTableExportTarget[], format: "csv" | "xlsx" | "sql" | "json", outputDirectory: string | undefined, mode: ManualExportMode, optionsForTarget: (target: SidebarTableExportTarget) => ExportTableDataOptions) {
    const capturedOptions = targets.map((target) => {
      const options = optionsForTarget(target);
      return { ...options, columnInfos: options.columnInfos?.map((column) => ({ ...column })) };
    });
    const paths: string[] = [];
    for (const target of targets) {
      const path = await resolveTableExportOutputPath(target, format, outputDirectory);
      if (!path) return;
      paths.push(path);
    }
    const selectedIds = currentTableExportTargets()
      .map((target) => target.nodeId)
      .join("\n");
    if (selectedIds !== targets.map((target) => target.nodeId).join("\n")) {
      toast(t("exportProgress.connectionChanged"), 5000);
      return;
    }
    const task = addExportTask(targets.map((target) => target.tableName).join(", "), format, targets.length === 1 ? paths[0]! : outputDirectory!);
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    tracker.submitExportTask(
      task,
      mode,
      async () => {
        const controller = new AbortController();
        const active: { task?: ExportTask; cancel?: () => Promise<void> } = {};
        const cancel = async () => {
          controller.abort();
          task.status = "Cancelling";
          if (active.task) active.task.status = "Cancelling";
          await active.cancel?.();
        };
        tracker.registerTaskCancelHandler(task.exportId, cancel);
        let unknown = false;
        let unknownMessage: string | undefined;
        let exported = 0;
        let failed = false;
        try {
          for (let index = 0; index < targets.length; index++) {
            if (controller.signal.aborted) break;
            const target = targets[index]!;
            const check = () => {
              if (unknown) throw new SnapshotCompletionError("unknown", unknownMessage ?? "Export operation completion was not confirmed");
              if (controller.signal.aborted) throw new SnapshotCompletionError("cancelled", "Export cancelled");
              const config = connectionStore.getConfig(target.connectionId);
              if (!config || connectionConfigFingerprint(config) !== target.connectionFingerprint) throw new SnapshotCompletionError("failed", t("exportProgress.connectionChanged"));
            };
            const read = async <T>(request: () => Promise<T>, cleanup = false): Promise<T> => {
              if (!cleanup) check();
              let result: T;
              try {
                result = await request();
              } catch (error) {
                unknown = true;
                unknownMessage ??= error instanceof Error ? error.message : String(error);
                throw new SnapshotCompletionError("unknown", error instanceof Error ? error.message : String(error));
              }
              if (!cleanup && active.task?.canCancel !== false) check();
              return result;
            };
            try {
              const operation: NonNullable<ExportTableDataOptions["operation"]> = {
                outputPath: paths[index]!,
                task: targets.length === 1 ? task : undefined,
                check,
                read,
                setActive: (child, cancelChild) => {
                  if (active.task && active.task !== task) tracker.unregisterTaskCancelHandler(active.task.exportId);
                  active.task = child;
                  active.cancel = cancelChild;
                  task.canCancel = child.canCancel !== false;
                  if (child !== task) tracker.registerTaskCancelHandler(child.exportId, cancel);
                },
              };
              const succeeded = format === "json" ? await exportDataLegacyForTarget(target, outputDirectory, targets.length > 1, operation) : await exportTableData(target, format, { ...capturedOptions[index], suppressDoneToast: targets.length > 1, operation });
              if (succeeded && active.task?.status === "Done") exported++;
              if (active.task?.status === "Error") {
                failed = true;
                task.errorMessage = active.task.errorMessage;
              }
              if (active.task?.status === "Cancelled") controller.abort();
            } catch (error) {
              unknown ||= error instanceof SnapshotCompletionError && error.status === "unknown";
              task.errorMessage = error instanceof Error ? error.message : String(error);
              if (unknown) {
                task.status = "Unknown";
                return "unknown";
              }
              if (error instanceof SnapshotCompletionError && error.status === "cancelled") break;
              failed = true;
              toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
            }
            if (active.task && active.task !== task) tracker.unregisterTaskCancelHandler(active.task.exportId);
            active.task = undefined;
            active.cancel = undefined;
            task.canCancel = true;
          }
          task.status = exported === targets.length ? "Done" : controller.signal.aborted ? "Cancelled" : failed ? "Error" : "Done";
          task.finishedAt = Date.now();
          if (targets.length > 1 && exported > 0) toast(t("contextMenu.exportDataMultipleSuccess", { count: exported }));
          return "settled";
        } finally {
          if (!unknown) {
            tracker.unregisterTaskCancelHandler(task.exportId);
            if (active.task && active.task !== task) tracker.unregisterTaskCancelHandler(active.task.exportId);
          }
          task.canCancel = false;
          if (unknown && active.task) active.task.canCancel = false;
        }
      },
      (current) => {
        if (current.status === "Done" || current.status === "Error" || current.status === "Cancelled" || current.status === "Unknown") complete();
      },
    );
    if (mode === "immediate") await completion;
  }

  async function exportQueuedMongoCollection(outputFormat: "csv" | "ndjson" | "bson" | "bsonGzip") {
    const node = activeNode.value;
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database) return;
    const connectionId = node.connectionId;
    const database = node.database;
    const collection = node.label;
    const config = connectionStore.getConfig(connectionId);
    const fingerprint = config ? connectionConfigFingerprint(config) : undefined;
    const preferredPath = settingsStore.editorSettings.preferredExportPath;
    const format = outputFormat === "bsonGzip" ? "bson" : outputFormat;
    const extension = outputFormat === "bsonGzip" ? "bson.gz" : outputFormat;
    const mode = await showExportExecutionModeDialog();
    if (mode === null) return;
    const outputPath = await promptExportSavePath({ defaultFileName: `${collection}.${extension}`, filters: [{ name: exportFilterName(extension), extensions: [outputFormat === "bsonGzip" ? "gz" : extension] }], preferredPath });
    if (!outputPath) return;
    const task = addExportTask(collection, format, outputPath);
    task.canCancel = true;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    tracker.submitExportTask(
      task,
      mode,
      async () => {
        let started = false;
        let cancelled = false;
        tracker.registerTaskCancelHandler(task.exportId, async () => {
          cancelled = true;
          task.status = "Cancelling";
          if (started) await api.cancelMongodbExport(task.exportId);
        });
        const check = () => {
          const current = connectionStore.getConfig(connectionId);
          if (!current || connectionConfigFingerprint(current) !== fingerprint) throw new Error(t("exportProgress.connectionChanged"));
        };
        try {
          check();
          await connectionStore.ensureConnected(connectionId);
          check();
          if (cancelled) {
            task.status = "Cancelled";
            task.finishedAt = Date.now();
            return "settled";
          }
          started = true;
          const summary = await api.exportMongodbQuery(
            { exportId: task.exportId, connectionId, database, collection, format, includeHeader: true, gzip: outputFormat === "bsonGzip", filePath: outputPath },
            (progress) => {
              task.rowsExported = progress.documentsRead;
              task.totalRows = progress.totalDocuments ?? null;
              if (task.status !== "Cancelling") task.status = "Writing";
              task.errorMessage = progress.errorMessage ?? null;
            },
            true,
          );
          task.status = "Done";
          task.rowsExported = summary.documentsExported;
          task.finishedAt = Date.now();
          notifyExportComplete({ filePath: outputPath, message: t("grid.exported"), openFolderLabel: t("exportProgress.openFolder"), toast });
          return "settled";
        } catch (error) {
          task.errorMessage = error instanceof Error ? error.message : String(error);
          const status = error instanceof SnapshotCompletionError ? error.status : started ? "unknown" : "failed";
          task.status = status === "unknown" ? "Unknown" : status === "cancelled" ? "Cancelled" : "Error";
          task.finishedAt = status === "unknown" ? undefined : Date.now();
          if (status !== "cancelled") toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
          return status === "unknown" ? "unknown" : "settled";
        } finally {
          if (task.status !== "Unknown") tracker.unregisterTaskCancelHandler(task.exportId);
          task.canCancel = false;
        }
      },
      (current) => {
        if (current.status === "Done" || current.status === "Error" || current.status === "Cancelled" || current.status === "Unknown") complete();
      },
    );
    if (mode === "immediate") await completion;
  }

  async function exportMongoCollection(outputFormat: "csv" | "ndjson" | "bson" | "bsonGzip") {
    if (isTauriRuntime()) return exportQueuedMongoCollection(outputFormat);
    const node = activeNode.value;
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database) return;
    const format: api.MongoExportFormat = outputFormat === "bsonGzip" ? "bson" : outputFormat;
    const fileExtension = outputFormat === "bsonGzip" ? "bson.gz" : outputFormat;
    const outputPath = await resolveExportOutputPath(node.label, fileExtension);
    if (!outputPath) return;
    let task: ExportTask | null = null;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      task = addExportTask(node.label, format, outputPath);
      const currentTask = task;
      await api.exportMongodbQuery(
        {
          exportId: currentTask.exportId,
          connectionId: node.connectionId,
          database: node.database,
          collection: node.label,
          format,
          includeHeader: true,
          gzip: outputFormat === "bsonGzip",
          filePath: outputPath,
        },
        (progress) => {
          currentTask.rowsExported = progress.documentsRead;
          currentTask.totalRows = progress.totalDocuments ?? null;
          if (progress.status === "running") currentTask.status = "Writing";
          else if (progress.status === "done") {
            currentTask.status = "Done";
            currentTask.finishedAt = Date.now();
          } else if (progress.status === "error") {
            currentTask.status = "Error";
            currentTask.errorMessage = progress.errorMessage ?? null;
          } else if (progress.status === "cancelled") currentTask.status = "Cancelled";
        },
      );
      notifyExportComplete({
        filePath: outputPath,
        message: t("grid.exported"),
        openFolderLabel: t("exportProgress.openFolder"),
        toast,
      });
    } catch (error: unknown) {
      if (task) {
        task.status = "Error";
        task.errorMessage = error instanceof Error ? error.message : String(error);
      }
      toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
    }
  }

  async function exportData(format: "csv" | "json" | "sql", insertDialect: SqlInsertDialect = "source") {
    const targets = currentTableExportTargets();
    if (!targets.length) return;
    if (format === "sql" && targets.some((target) => mysqlDataCharsetEnabled(connectionStore.getConfig(target.connectionId)))) {
      toast(t("connection.mysqlDataCharsetExportHint"), 5000);
      return;
    }

    const mode = isTauriRuntime() ? await showExportExecutionModeDialog() : undefined;
    if (mode === null) return;

    const outputDirectory = await resolveMultiTableExportDirectory(targets.length);
    if (outputDirectory === null) return;

    if (mode) return submitTableExports(targets, format, outputDirectory, mode, () => ({ insertDialect }));

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
      if (await exportTableData(target, format, { outputDirectory, suppressDoneToast: targets.length > 1, insertDialect })) exported += 1;
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
    const mode = isTauriRuntime() ? (xlsxOptions.executionMode ?? (await showExportExecutionModeDialog())) : undefined;
    if (mode === null) return;

    const outputDirectory = await resolveMultiTableExportDirectory(targets.length);
    if (outputDirectory === null) return;

    if (mode) return submitTableExports(targets, "xlsx", outputDirectory, mode, (target) => ({ columnInfos: columnInfosByTarget.get(tableExportTargetCacheKey(target)), headerMode: xlsxOptions.headerMode, autoFilter: xlsxOptions.autoFilter }));

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
    exportMongoCollection,
    exportStructure,
    saveStructurePreview,
    selectTextareaContent,
  };
}
