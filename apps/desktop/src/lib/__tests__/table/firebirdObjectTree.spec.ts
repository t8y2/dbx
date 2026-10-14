import { describe, it, expect } from "vitest";
import { buildGroupedObjectTreeNodes, buildObjectGroupPlaceholderNodes, objectTypesForGroupNode } from "@/lib/table/tableTree";
import { sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

describe("Firebird catalog object groups", () => {
  const base = { nodeId: "c:db", connectionId: "c", database: "db" };
  it("splits PSQL and external functions and gives database indexes their own container", () => {
    const nodes = buildObjectGroupPlaceholderNodes({ ...base, objectTypes: sidebarObjectKindsForDatabase("firebird") });
    expect(nodes.map((node) => node.type)).toEqual(expect.arrayContaining(["group-sequences", "group-packages", "group-triggers", "group-database-indexes", "group-internal-functions", "group-udf-functions"]));
    expect(nodes.map((node) => node.type)).not.toContain("group-functions");
    expect(objectTypesForGroupNode("group-database-indexes")).toEqual(["INDEX"]);
    expect(objectTypesForGroupNode("group-indexes")).toBeNull();
  });
  it("keeps the owning table on an index and qualified package names on functions", () => {
    const nodes = buildGroupedObjectTreeNodes({
      ...base,
      objects: [
        { name: "PK_A_DETAIL", object_type: "INDEX", parent_name: "A_DETAIL" },
        { name: "MYUDR2.F", object_type: "FUNCTION_INTERNAL" },
        { name: "F_ABS", object_type: "FUNCTION_UDF" },
      ],
    });
    expect(nodes.find((node) => node.type === "group-database-indexes")?.children?.[0]).toMatchObject({ type: "index", objectName: "PK_A_DETAIL", tableName: "A_DETAIL" });
    expect(nodes.find((node) => node.type === "group-internal-functions")?.children?.[0]).toMatchObject({ type: "function", objectName: "MYUDR2.F" });
    expect(nodes.find((node) => node.type === "group-udf-functions")?.children?.[0].label).toBe("F_ABS");
  });
});
