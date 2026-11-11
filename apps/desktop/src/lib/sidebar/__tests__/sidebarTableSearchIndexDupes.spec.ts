// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { sidebarTableSearchIndexScopes } from "@/lib/sidebar/sidebarTableSearchIndex";
import { buildSidebarIndexedTableNodes, mergeSidebarRegexIndexScopes, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import type { TableInfo, TreeNode } from "@/types/database";

const GROUP_ID = "conn:new_tv@group-tables";
const MAX = 200;

/** Live group children as the store builds them for a database-scoped table group. */
function liveGroup(tables: TableInfo[]): TreeNode {
  const children = buildTableTreeNodes({
    nodeId: GROUP_ID,
    connectionId: "conn",
    database: "new_tv",
    schema: undefined,
    tables,
  });
  return { id: GROUP_ID, label: "tables", type: "group-tables", connectionId: "conn", database: "new_tv", isExpanded: true, children };
}

/** Index entries carrying exactly what the build stamps onto its rows. */
function indexEntries(tables: TableInfo[], attributeSchema: boolean, schema: string): TableInfo[] {
  return tables.map((table) => (attributeSchema ? { ...table, schema } : table));
}

function rowsAfterMerge(live: TreeNode, entries: TableInfo[]): string[] {
  const scope: SidebarRegexIndexScope = {
    parentNodeId: GROUP_ID,
    connectionId: "conn",
    database: "new_tv",
    // Unattributed scopes leave the parent schema empty, matching the live group.
    schema: undefined,
    nodeType: "group-tables",
    entries,
  };
  const merged = mergeSidebarRegexIndexScopes([live], [scope]);
  const group = merged.find((node) => node.id === GROUP_ID)!;
  return (group.children ?? []).filter((child) => child.type === "table").map((child) => child.label);
}

const tables: TableInfo[] = [
  { name: "version_renew", table_type: "BASE TABLE", comment: "版本更新" },
  { name: "live_app_version", table_type: "BASE TABLE", comment: "软件版本管理" },
];

describe("searching a database-only table group renders each table once (#14736)", () => {
  it("keeps one row per table when the scope is unattributed", () => {
    const [scope] = sidebarTableSearchIndexScopes({ database: "new_tv", children: [] }, MAX);
    const entries = indexEntries(tables, scope.attributeSchema, scope.schema);
    expect(rowsAfterMerge(liveGroup(tables), entries).sort()).toEqual(["live_app_version", "version_renew"]);
  });

  /**
   * The regression itself: attributing the database name as a schema used to give
   * the indexed node an extra id segment, so the merge could not recognise the
   * table the live tree already had and drew it twice.
   */
  it("would duplicate the rows if the database name were attributed", () => {
    const unscoped = sidebarTableSearchIndexScopes({ database: "new_tv", children: [] }, MAX)[0];
    expect(unscoped.attributeSchema).toBe(false);
    const entries = indexEntries(tables, true, unscoped.schema);
    const indexedIds = buildSidebarIndexedTableNodes({
      parentNodeId: GROUP_ID,
      connectionId: "conn",
      database: "new_tv",
      schema: undefined,
      nodeType: "group-tables",
      entries,
    }).map((node) => node.id);
    expect(indexedIds).toContain(`${GROUP_ID}:new_tv:version_renew`);
    const rendered = rowsAfterMerge(liveGroup(tables), entries);
    expect(rendered.filter((label) => label === "version_renew")).toHaveLength(2);
    expect(rendered.filter((label) => label === "live_app_version")).toHaveLength(2);
  });
});
