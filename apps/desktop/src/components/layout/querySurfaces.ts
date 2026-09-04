import type { ConnectionConfig, ObjectBrowserViewport, QueryTab } from "@/types/database";
import type { DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import type { DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import type { SqlExecutionOverride, SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";

export interface StatementRange {
  from: number;
  to: number;
}

export interface QueryEditorSurfaceHandle {
  focusSearch(target?: Element | null): boolean;
  openGoToColumn(): boolean;
  refreshData(target?: Element | null): boolean;
  toggleResultsPane(): boolean;
  refreshQueryEditorCompletionCache(): boolean;
  handleModRTarget(target: Element): boolean;
  requestQueryEditorExecute(): boolean;
  captureQueryEditorExecutionSnapshot(): SqlExecutionSnapshot | undefined;
  requestQueryEditorExecuteInNewResultTab(): boolean;
  requestQueryEditorPreviewChanges(stackSql?: string): Promise<boolean>;
  shouldBlockQueryEditorExecutionShortcut(event: KeyboardEvent): boolean;
  cancelQueryEditorExecutionViewport(requestId: number): boolean;
  acceptQueryEditorExecutionViewport(requestId: number): boolean;
  pasteClipboardAsSqlInCondition(): Promise<boolean>;
  applyTableStructureChanges(): Promise<boolean>;
  insertRedisCommand(command: string): Promise<boolean>;
  executeRedisCommand(command: string): Promise<boolean>;
  previewStatementRange(range: StatementRange | null): boolean;
  focusStatementRange(range: StatementRange | null): boolean;
}

export interface QueryResultSurfaceHandle {
  focusSearch(target?: Element | null): boolean;
  refreshData(target?: Element | null): boolean;
  toggleResultsPane(): boolean;
  handleModRTarget(target: Element): boolean;
  previewStatementRange(range: StatementRange | null): boolean;
  focusStatementRange(range: StatementRange | null): boolean;
}

export interface ContentAreaSurfaceProps {
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  activeOutputView: "result" | "summary" | "explain" | "chart" | "messages";
  formatSqlRequest: { id: number; tabId: string } | null;
  compressSqlRequest: { id: number; tabId: string } | null;
  selectedSql: string;
  cursorPos: number;
  blockDangerousRedisCommands: boolean;
  zenMode?: boolean;
}

/**
 * Event contract between content surfaces and the workspace/App layer.
 * Every operation that can outlive a focus change — execution, cancellation,
 * result paging, AI hand-off, formatting, view switches — carries the tabId
 * of the tab that originated it, so consumers never have to re-read the
 * global active tab after an await (see redevelopment guide §6.1).
 */
export interface ContentAreaSurfaceEmits {
  "update:activeOutputView": [tabId: string, value: "result" | "summary" | "explain" | "chart" | "messages"];
  fixWithAi: [tabId: string, errorMessage: string];
  sendSelectionToAi: [tabId: string, sql: string];
  previewChangesAvailable: [tabId: string, value: boolean];
  execute: [tabId: string, sqlOverride?: SqlExecutionOverride];
  executeInNewResultTab: [tabId: string, sqlOverride?: SqlExecutionOverride];
  saveSql: [tabId: string];
  cancel: [tabId: string];
  explain: [tabId: string];
  editorUpdate: [tabId: string, value: string];
  editorSelectionChange: [tabId: string, value: string];
  editorCursorChange: [tabId: string, pos: number];
  editorViewportChange: [tabId: string, viewport: { scrollTop: number; scrollLeft: number }];
  editorSelectionStateChange: [tabId: string, selection: { anchor: number; head: number }];
  formatError: [tabId: string];
  reload: [tabId: string, sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent];
  paginate: [tabId: string, offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [tabId: string, column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode?: DataGridSortMode];
  executeSql: [tabId: string, sql: string];
  clickTable: [tabId: string, target: SqlObjectNavigationTarget];
  viewTableData: [tabId: string, target: SqlObjectNavigationTarget];
  viewTableDdl: [tabId: string, target: SqlObjectNavigationTarget];
  editTableStructure: [tabId: string, target: SqlObjectNavigationTarget];
  openObjectSource: [tabId: string, target: SqlObjectNavigationTarget, initialEditing: boolean];
  openObjectTable: [tabId: string, target: { tableName: string; schema?: string; tableType?: string; catalog?: string }];
  objectSchemaChange: [tabId: string, schema: string | undefined];
  objectBrowserViewportChange: [tabId: string, viewport: ObjectBrowserViewport];
  structureEditorSaved: [tabId: string, commentChanged: boolean];
  structureEditorClose: [tabId: string];
  previewStatement: [tabId: string, range: StatementRange | null];
  focusStatement: [tabId: string, range: StatementRange | null];
  openSettings: [initialTab?: string, initialSection?: string];
  openConnectionSettings: [connectionId: string, initialTab: "advanced"];
  toggleZenMode: [];
}
