import { describe, expect, it } from "vitest";
import { buildConnectionDatabaseTabGroupStripEntries } from "@/lib/tabs/tabGroupTree";
import type { QueryTab } from "@/types/database";

function tab(id: string, connectionId: string, database: string, catalog?: string): QueryTab {
  return { id, connectionId, database, catalog, title: id } as QueryTab;
}

describe("buildConnectionDatabaseTabGroupStripEntries", () => {
  it("builds connection, database and tab levels without sidebar folders", () => {
    const entries = buildConnectionDatabaseTabGroupStripEntries([tab("users", "mysql", "app"), tab("orders", "mysql", "app"), tab("audit", "mysql", "logs"), tab("users", "pg", "app")], false);

    expect(entries.map((entry) => (entry.kind === "header" ? `${entry.level}:${entry.label}` : `tab:${entry.tab.id}`))).toEqual(["connection:mysql", "database:app", "tab:users", "tab:orders", "database:logs", "tab:audit", "connection:pg", "database:app", "tab:users"]);
    expect(entries.filter((entry) => entry.kind === "header").every((entry) => entry.level === "connection" || entry.level === "database")).toBe(true);
    const mysqlConnection = entries[0];
    expect(mysqlConnection?.kind === "header" && mysqlConnection.treeGuides).toEqual([{ depth: 0, kind: "start" }]);
    const firstDatabase = entries[1];
    expect(firstDatabase?.kind === "header" && firstDatabase.treeGuides).toEqual([
      { depth: 0, kind: "branch" },
      { depth: 1, kind: "start" },
    ]);
    const firstDatabaseLastTab = entries[3];
    expect(firstDatabaseLastTab?.kind === "tab" && firstDatabaseLastTab.treeGuides).toEqual([
      { depth: 0, kind: "through" },
      { depth: 1, kind: "last-branch" },
    ]);
    const postgresConnection = entries[6];
    expect(postgresConnection?.kind === "header" && postgresConnection.treeGuides).toEqual([{ depth: 0, kind: "start" }]);
  });

  it("keeps pinned and regular hierarchy IDs separate", () => {
    const regular = buildConnectionDatabaseTabGroupStripEntries([tab("users", "mysql", "app")], false);
    const pinned = buildConnectionDatabaseTabGroupStripEntries([tab("users", "mysql", "app")], true);

    expect(regular[0]?.groupId).not.toBe(pinned[0]?.groupId);
    expect(regular[1]?.groupId).not.toBe(pinned[1]?.groupId);
  });
});
