import type { InjectionKey, Ref } from "vue";

/**
 * App-level orchestration behind the per-group SQL editor toolbar.
 *
 * The toolbar renders inside each editor group, but execution, dialogs, and
 * format/compress requests stay App-owned. The group focuses itself on
 * pointerdown/focusin before any toolbar event fires, so handlers may resolve
 * the acting tab from the explicit tabId argument (never re-reading the global
 * active tab after an await).
 */
export interface EditorToolbarActions {
  explainMode: Ref<"explain" | "autotrace">;
  blockDangerousRedisCommands: Ref<boolean>;
  /** Highlights the database selector of the tab that needs a database choice. */
  databaseRequiredSignalFor(tabId: string): number;
  /** Captures the acting editor's execution snapshot before a toolbar click. */
  captureExecutionSnapshot(): void;
  toolbarExecute(source: "pointer" | "keyboard"): void;
  cancelExecution(tabId: string): void;
  explain(tabId: string): void;
  formatSql(tabId: string): void;
  compressSql(tabId: string): void;
  toggleSqlKeywordCase(): void;
  saveSql(tabId: string): void;
  openSqlFile(): void;
  importResultArchive(): void;
  pasteSqlInCondition(): void;
  multiExecute(): void;
  previewChanges(tabId: string): void;
  changeConnection(tabId: string, connectionId: string): void;
  changeCatalog(tabId: string, catalog: string | undefined, database: string): void;
  changeDatabase(tabId: string, database: string): void;
  changeSchema(tabId: string, schema: string | undefined): void;
  setDefaultDatabase(tabId: string): void;
  clearDefaultDatabase(tabId: string): void;
}

export const EDITOR_TOOLBAR_ACTIONS: InjectionKey<EditorToolbarActions> = Symbol("dbx:editor-toolbar-actions");

/**
 * No-op fallback so a group mounted outside the workspace (tests, future
 * hosts) renders a toolbar that does nothing instead of crashing. Production
 * always provides real actions from App.
 */
export function createNoopEditorToolbarActions(): EditorToolbarActions {
  const noop = () => undefined;
  const mode = { value: "explain" } as Ref<"explain" | "autotrace">;
  const flag = { value: true } as Ref<boolean>;
  return {
    explainMode: mode,
    blockDangerousRedisCommands: flag,
    databaseRequiredSignalFor: () => 0,
    captureExecutionSnapshot: noop,
    toolbarExecute: noop,
    cancelExecution: noop,
    explain: noop,
    formatSql: noop,
    compressSql: noop,
    toggleSqlKeywordCase: noop,
    saveSql: noop,
    openSqlFile: noop,
    importResultArchive: noop,
    pasteSqlInCondition: noop,
    multiExecute: noop,
    previewChanges: noop,
    changeConnection: noop,
    changeCatalog: noop,
    changeDatabase: noop,
    changeSchema: noop,
    setDefaultDatabase: noop,
    clearDefaultDatabase: noop,
  };
}
