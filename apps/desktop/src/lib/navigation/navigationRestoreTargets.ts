import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";
import type { QueryTab } from "@/types/database";
import type { GlobalNavigationEntry } from "./navigationEntry";

export type SourceNavigationIdentity = NonNullable<QueryTab["sourceLoad"]>["request"] & { initialEditing: boolean };

export function captureSourceNavigationIdentity(tab: Pick<QueryTab, "sourceLoad" | "objectSource">, previous?: SourceNavigationIdentity): SourceNavigationIdentity | undefined {
  const identity = tab.objectSource ?? tab.sourceLoad?.request ?? previous;
  if (!identity) return undefined;
  // sourceLoad disappears after loading, including for read-only sequences.
  // Preserve false explicitly; falling back to true changes CREATE to ALTER.
  return { ...identity, initialEditing: tab.sourceLoad?.initialEditing ?? previous?.initialEditing ?? true };
}

export function navigationSourceTarget(entry: GlobalNavigationEntry) {
  if (!entry.connectionId || !entry.database || !entry.objectName || !entry.objectType) return null;
  return {
    connectionId: entry.connectionId,
    database: entry.database,
    title: entry.title || `Source - ${entry.objectName}`,
    schema: entry.schema,
    catalog: entry.catalog,
    initialEditing: entry.initialEditing ?? true,
    request: { name: entry.objectName, objectType: entry.objectType, signature: entry.objectSignature },
  };
}

export function navigationTableTarget(entry: GlobalNavigationEntry): NavigationTarget | null {
  if (!entry.connectionId || !entry.database || !entry.tableName) return null;
  return { connectionId: entry.connectionId, database: entry.database, catalog: entry.catalog, schema: entry.schema, tableName: entry.tableName, tableType: entry.tableType };
}

export function matchesNavigationDataTab(tab: QueryTab, entry: GlobalNavigationEntry): boolean {
  return (
    tab.mode === (entry.mode === "mongo" ? "mongo" : "data") &&
    tab.connectionId === entry.connectionId &&
    tab.database === entry.database &&
    (tab.tableMeta?.catalog ?? tab.catalog ?? "") === (entry.catalog ?? "") &&
    (tab.tableMeta?.schema ?? tab.schema ?? "") === (entry.schema ?? "") &&
    tab.tableMeta?.tableName === entry.tableName
  );
}

export function canRestoreQueryNavigationEntry(entry: GlobalNavigationEntry, tabs: readonly QueryTab[], activeTab: QueryTab | undefined, reuseMode: DataTabReuseMode): boolean {
  if (entry.surface !== "query" || entry.kind !== "data") return true;
  if (!navigationTableTarget(entry)) return false;
  // Activating an existing target never overwrites the current data draft.
  if (tabs.some((tab) => matchesNavigationDataTab(tab, entry))) return true;
  return reuseMode !== "active-tab" || !activeTab || (!(activeTab.pendingDataChangeCount ?? 0) && !activeTab.hasPendingDataEditorDraft);
}
