import { matchesModifierOnlyShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";
import type { QueryTab, TreeNodeType } from "@/types/database";

export type DataTabOpenMode = "default" | "new-tab";
export type { DataTabReuseMode };

type DataTabLike = Pick<
  QueryTab,
  "id" | "mode" | "connectionId" | "database" | "catalog" | "schema" | "title" | "tableMeta" | "tableMetaUpdatedAt" | "tableMetaGeneration" | "pinned" | "isExecuting" | "isCancelling" | "isExplaining" | "txnSessionId" | "pendingDataChangeCount" | "hasPendingDataEditorDraft"
>;

export interface DataTabTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
}

export type ExistingDataTabCandidate<T extends DataTabLike> = {
  tab: T;
  match: "same-table" | "active-tab";
};

const dataNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);

export function isDataTreeNodeType(type: TreeNodeType): boolean {
  return dataNodeTypes.has(type);
}

export function dataTabOpenModeFromTreeClick(type: TreeNodeType, event: Omit<ShortcutLikeEvent, "key">, shortcut: string): DataTabOpenMode {
  if (!isDataTreeNodeType(type)) return "default";
  return matchesModifierOnlyShortcut(event, shortcut) ? "new-tab" : "default";
}

function isSameDatabase(tab: DataTabLike, target: Pick<DataTabTarget, "connectionId" | "database">, mode: "data" | "mongo" = "data"): boolean {
  return tab.mode === mode && tab.connectionId === target.connectionId && tab.database === target.database;
}

function dataTabCatalog(tab: DataTabLike): string {
  return tab.tableMeta?.catalog || tab.catalog || "";
}

function isSameTable(tab: DataTabLike, target: DataTabTarget): boolean {
  const tabSchema = tab.schema || (target.schema ? tab.tableMeta?.schema : undefined) || "";
  return isSameDatabase(tab, target) && dataTabCatalog(tab) === (target.catalog || "") && tabSchema === (target.schema || "") && (tab.tableMeta?.tableName || tab.title) === target.tableName;
}

function canReuseActiveTableTab(tab: DataTabLike | undefined, target: DataTabTarget, mode: "data" | "mongo"): boolean {
  return tab !== undefined && isSameDatabase(tab, target, mode) && dataTabCatalog(tab) === (target.catalog || "") && !tab.pinned && !tab.isExecuting && !tab.isCancelling && !tab.isExplaining && !tab.txnSessionId && !tab.pendingDataChangeCount && !tab.hasPendingDataEditorDraft;
}

export function canReuseActiveDataTab(tab: DataTabLike | undefined, target: DataTabTarget): boolean {
  return canReuseActiveTableTab(tab, target, "data");
}

export function canReuseActiveMongoTab(tab: DataTabLike | undefined, target: DataTabTarget): boolean {
  return canReuseActiveTableTab(tab, target, "mongo");
}

export function canApplyDataTabMetadata(tab: DataTabLike | undefined, target: DataTabTarget, signal?: AbortSignal): boolean {
  return signal?.aborted !== true && tab !== undefined && isSameTable(tab, target);
}

export function dataTabMetadataNeedsRefresh(tab: DataTabLike, maxAgeMs: number, now = Date.now()): boolean {
  if (!tab.tableMeta?.columns.length || tab.tableMetaUpdatedAt === undefined) return true;
  return now - tab.tableMetaUpdatedAt >= maxAgeMs;
}

/**
 * Connection-lifetime freshness: a data tab is cold when it has no freshness
 * stamp or its recorded generation no longer matches the current
 * connection/database generation. TTL only applies inside the same generation.
 * Missing columns remain a separate cold-cache case handled by callers.
 */
export function isDataTabMetadataLifecycleStale(tab: Pick<DataTabLike, "tableMetaUpdatedAt" | "tableMetaGeneration">, currentGeneration: number): boolean {
  return tab.tableMetaUpdatedAt === undefined || (tab.tableMetaGeneration ?? -1) !== currentGeneration;
}

export function findExistingDataTabCandidate<T extends DataTabLike>(tabs: T[], target: DataTabTarget, options: { openMode: DataTabOpenMode; reuseMode: DataTabReuseMode; activeTabId?: string | null }): ExistingDataTabCandidate<T> | undefined {
  if (options.openMode === "new-tab" || options.reuseMode === "always-new") return undefined;

  const sameTable = tabs.find((tab) => isSameTable(tab, target));
  if (sameTable) return { tab: sameTable, match: "same-table" };

  if (options.reuseMode === "active-tab") {
    const activeTab = tabs.find((tab) => tab.id === options.activeTabId);
    if (activeTab && canReuseActiveDataTab(activeTab, target)) return { tab: activeTab, match: "active-tab" };
  }
  return undefined;
}
