import { describe, expect, it } from "vitest";
import type { TreeNode, TreeNodeType } from "@/types/database";
import { needsSidebarObjectGroupDiscovery } from "@/lib/sidebar/sidebarSearchDiscovery";

const objectGroupTypes: ReadonlySet<TreeNodeType> = new Set<TreeNodeType>(["group-tables", "group-views"]);

function node(partial: Partial<TreeNode> & Pick<TreeNode, "id" | "type">): TreeNode {
  return { label: partial.id, ...partial };
}

describe("needsSidebarObjectGroupDiscovery", () => {
  it("asks for discovery while a container only holds its saved SQL root", () => {
    // Reproduces #9174: the database node already has a child (the saved SQL
    // root) before its object groups are fetched, so an empty-child check would
    // skip it and its tables would never join the search.
    const database = node({
      id: "mysql/dbx",
      type: "database",
      connectionId: "c1",
      database: "dbx",
      children: [node({ id: "saved-sql-root", type: "saved-sql-root", connectionId: "c1", database: "dbx" })],
    });
    expect(needsSidebarObjectGroupDiscovery(database, objectGroupTypes)).toBe(true);
  });

  it("asks for discovery when the container has no children at all", () => {
    const schema = node({ id: "pg/public", type: "schema", connectionId: "c1", database: "postgres" });
    expect(needsSidebarObjectGroupDiscovery(schema, objectGroupTypes)).toBe(true);
    expect(needsSidebarObjectGroupDiscovery({ ...schema, children: [] }, objectGroupTypes)).toBe(true);
  });

  it("stops asking once a searchable object group is loaded", () => {
    const database = node({
      id: "mysql/dbx",
      type: "database",
      connectionId: "c1",
      database: "dbx",
      children: [node({ id: "saved-sql-root", type: "saved-sql-root", connectionId: "c1", database: "dbx" }), node({ id: "group-views", type: "group-views", connectionId: "c1", database: "dbx" })],
    });
    expect(needsSidebarObjectGroupDiscovery(database, objectGroupTypes)).toBe(false);
  });

  it("ignores non-group children such as tables already listed under the container", () => {
    const database = node({
      id: "mysql/dbx",
      type: "database",
      connectionId: "c1",
      database: "dbx",
      children: [node({ id: "dbx.cells_probe", type: "table", connectionId: "c1", database: "dbx" }), node({ id: "user-admin", type: "user-admin" })],
    });
    expect(needsSidebarObjectGroupDiscovery(database, objectGroupTypes)).toBe(true);
  });

  it("ignores object groups owned by another connection", () => {
    const database = node({
      id: "mysql/dbx",
      type: "database",
      connectionId: "c1",
      database: "dbx",
      children: [node({ id: "group-tables", type: "group-tables" })],
    });
    expect(needsSidebarObjectGroupDiscovery(database, objectGroupTypes)).toBe(true);
  });
});
