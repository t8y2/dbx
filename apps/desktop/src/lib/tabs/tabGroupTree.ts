import type { QueryTab } from "@/types/database";

export type TabHierarchyLevel = "connection" | "database";

export interface TabGroupTreeGuide {
  depth: number;
  kind: "start" | "through" | "branch" | "last-branch";
}

export interface ConnectionDatabaseTabGroupHeaderEntry {
  kind: "header";
  key: string;
  groupId: string;
  label: string;
  level: TabHierarchyLevel;
  depth: number;
  count: number;
  pinned: boolean;
  tab: QueryTab;
  tabIds: string[];
  ancestorIds: string[];
  treeGuides: TabGroupTreeGuide[];
}

export interface ConnectionDatabaseTabGroupTabEntry {
  kind: "tab";
  key: string;
  groupId: string;
  tab: QueryTab;
  depth: number;
  groupFirst: boolean;
  groupLast: boolean;
  grouping: true;
  ancestorIds: string[];
  treeGuides: TabGroupTreeGuide[];
}

export type ConnectionDatabaseTabGroupStripEntry = ConnectionDatabaseTabGroupHeaderEntry | ConnectionDatabaseTabGroupTabEntry;

const CONNECTION_GROUP_ID_PREFIX = "sidebar-connection:";
const DATABASE_GROUP_ID_PREFIX = "sidebar-database:";

function sectionPrefix(pinned: boolean): string {
  return pinned ? "fixed:" : "regular:";
}

function connectionGroupId(connectionId: string, pinned: boolean): string {
  return `${sectionPrefix(pinned)}${CONNECTION_GROUP_ID_PREFIX}${connectionId}`;
}

function databaseGroupKey(tab: QueryTab): string {
  return JSON.stringify([tab.connectionId, tab.catalog || "", tab.database || ""]);
}

function databaseGroupId(tab: QueryTab, pinned: boolean): string {
  return `${sectionPrefix(pinned)}${DATABASE_GROUP_ID_PREFIX}${databaseGroupKey(tab)}`;
}

/**
 * Projects the current pane into a stable three-level hierarchy:
 * connection -> database -> table/query tab.
 *
 * The sidebar's user-created folders are deliberately ignored. Tabs without
 * a database still receive a database bucket so every tab follows the same
 * shape and remains reachable through the connection branch.
 */
export function buildConnectionDatabaseTabGroupStripEntries(tabs: QueryTab[], pinned: boolean): ConnectionDatabaseTabGroupStripEntry[] {
  if (tabs.length === 0) return [];

  const tabsByConnection = new Map<string, QueryTab[]>();
  for (const tab of tabs) {
    const bucket = tabsByConnection.get(tab.connectionId) ?? [];
    bucket.push(tab);
    tabsByConnection.set(tab.connectionId, bucket);
  }

  const entries: ConnectionDatabaseTabGroupStripEntry[] = [];
  for (const [connectionId, connectionTabs] of tabsByConnection) {
    const connectionIdValue = connectionGroupId(connectionId, pinned);
    const databaseBuckets = new Map<string, QueryTab[]>();
    for (const tab of connectionTabs) {
      const key = databaseGroupKey(tab);
      const bucket = databaseBuckets.get(key) ?? [];
      bucket.push(tab);
      databaseBuckets.set(key, bucket);
    }
    const databaseEntries = [...databaseBuckets.values()];
    entries.push({
      kind: "header",
      key: `header:${connectionIdValue}`,
      groupId: connectionIdValue,
      label: connectionId,
      level: "connection",
      depth: 0,
      count: connectionTabs.length,
      pinned,
      tab: connectionTabs[0]!,
      tabIds: connectionTabs.map((tab) => tab.id),
      ancestorIds: [],
      treeGuides: [{ depth: 0, kind: "start" }],
    });

    databaseEntries.forEach((databaseTabs, databaseIndex) => {
      const lastDatabase = databaseIndex === databaseEntries.length - 1;
      const representativeTab = databaseTabs[0]!;
      const databaseId = databaseGroupId(representativeTab, pinned);
      entries.push({
        kind: "header",
        key: `header:${databaseId}`,
        groupId: databaseId,
        label: representativeTab.database || representativeTab.catalog || connectionId,
        level: "database",
        depth: 1,
        count: databaseTabs.length,
        pinned,
        tab: representativeTab,
        tabIds: databaseTabs.map((tab) => tab.id),
        ancestorIds: [connectionIdValue],
        treeGuides: [
          { depth: 0, kind: lastDatabase ? "last-branch" : "branch" },
          { depth: 1, kind: "start" },
        ],
      });

      databaseTabs.forEach((tab, index) => {
        entries.push({
          kind: "tab",
          key: tab.id,
          groupId: databaseId,
          tab,
          depth: 2,
          groupFirst: index === 0,
          groupLast: index === databaseTabs.length - 1,
          grouping: true,
          ancestorIds: [connectionIdValue, databaseId],
          // Continue the connection rail across this database's tabs only
          // when another database follows. Every table owns a centered branch
          // to its own database rail; only the final table ends that rail.
          treeGuides: [...(lastDatabase ? [] : [{ depth: 0, kind: "through" as const }]), { depth: 1, kind: index === databaseTabs.length - 1 ? "last-branch" : "branch" }],
        });
      });
    });
  }

  return entries;
}
