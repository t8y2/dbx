import { describe, expect, it } from "vitest";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import type { TreeNode } from "@/types/database";

describe("Oracle sidebar ordering", () => {
  it("sorts schema nodes alphabetically and places database links at the bottom", () => {
    const children: TreeNode[] = [
      { id: "c1:__oracle_db_links", label: "tree.databaseLinks", type: "oracle-db-links", connectionId: "c1" },
      { id: "c1:ZEBRA:ZEBRA", label: "ZEBRA", type: "schema", connectionId: "c1", database: "ZEBRA", schema: "ZEBRA" },
      { id: "c1:ALPHA:ALPHA", label: "ALPHA", type: "schema", connectionId: "c1", database: "ALPHA", schema: "ALPHA" },
    ];

    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(result.map((node) => node.id)).toEqual(["c1:ALPHA:ALPHA", "c1:ZEBRA:ZEBRA", "c1:__oracle_db_links"]);
  });

  it("places saved queries at the top, schemas in the middle, and database links at the bottom", () => {
    const children: TreeNode[] = [
      { id: "c1:__oracle_db_links", label: "tree.databaseLinks", type: "oracle-db-links", connectionId: "c1" },
      { id: "c1:MY_SCHEMA:MY_SCHEMA", label: "MY_SCHEMA", type: "schema", connectionId: "c1", database: "MY_SCHEMA", schema: "MY_SCHEMA" },
      { id: "c1:__queries", label: "tree.queries", type: "saved-sql-root", connectionId: "c1" },
    ];

    const result = sortSidebarTreeChildrenForParent({ type: "connection" }, children, "oracle");
    expect(result.map((node) => node.id)).toEqual(["c1:__queries", "c1:MY_SCHEMA:MY_SCHEMA", "c1:__oracle_db_links"]);
  });
});
