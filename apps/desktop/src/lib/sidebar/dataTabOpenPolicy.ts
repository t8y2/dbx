import { matchesModifierOnlyShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import type { QueryTab, TreeNodeType } from "@/types/database";

export type DataTabOpenMode = "default" | "new-tab";
export type DataTabReuseScope = "none" | "same-table";

type DataTabLike = Pick<QueryTab, "id" | "mode" | "connectionId" | "database" | "schema" | "title" | "tableMeta" | "tableMetaUpdatedAt">;

export interface DataTabTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
}

export type ExistingDataTabCandidate<T extends DataTabLike> = {
  tab: T;
  match: "same-table";
};

const dataNodeTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);

export function isDataTreeNodeType(type: TreeNodeType): boolean {
  return dataNodeTypes.has(type);
}

export function dataTabOpenModeFromTreeClick(type: TreeNodeType, event: Omit<ShortcutLikeEvent, "key">, shortcut: string): DataTabOpenMode {
  if (!isDataTreeNodeType(type)) return "default";
  return matchesModifierOnlyShortcut(event, shortcut) ? "new-tab" : "default";
}

function isSameDatabase(tab: DataTabLike, target: Pick<DataTabTarget, "connectionId" | "database">): boolean {
  return tab.mode === "data" && tab.connectionId === target.connectionId && tab.database === target.database;
}

function isSameTable(tab: DataTabLike, target: DataTabTarget): boolean {
  const tabSchema = tab.schema || (target.schema ? tab.tableMeta?.schema : undefined) || "";
  return isSameDatabase(tab, target) && (tab.tableMeta?.catalog || "") === (target.catalog || "") && tabSchema === (target.schema || "") && (tab.tableMeta?.tableName || tab.title) === target.tableName;
}

export function canApplyDataTabMetadata(tab: DataTabLike | undefined, target: DataTabTarget, signal?: AbortSignal): boolean {
  return signal?.aborted !== true && tab !== undefined && isSameTable(tab, target);
}

export function dataTabMetadataNeedsRefresh(tab: DataTabLike, maxAgeMs: number, now = Date.now()): boolean {
  if (!tab.tableMeta?.columns.length || tab.tableMetaUpdatedAt === undefined) return true;
  return now - tab.tableMetaUpdatedAt >= maxAgeMs;
}

export function findExistingDataTabCandidate<T extends DataTabLike>(tabs: T[], target: DataTabTarget, options: { openMode: DataTabOpenMode; reuseScope: DataTabReuseScope }): ExistingDataTabCandidate<T> | undefined {
  if (options.openMode === "new-tab" || options.reuseScope === "none") return undefined;

  const sameTable = tabs.find((tab) => isSameTable(tab, target));
  if (sameTable) return { tab: sameTable, match: "same-table" };
  return undefined;
}
