import { describe, expect, it } from "vitest";
import { completionSchemasFromTree, completionTablesFromTree } from "@/lib/metadata/completionTreeIndex";
import type { TreeNode } from "@/types/database";

describe("completionTreeIndex", () => {
  it("extracts PrestoSQL schemas and loaded grouped tables from the sidebar tree", () => {
    const tree: TreeNode[] = [
      {
        id: "conn",
        label: "PrestoSQL",
        type: "connection",
        connectionId: "conn",
        children: [
          {
            id: "conn:hive",
            label: "hive",
            type: "database",
            connectionId: "conn",
            database: "hive",
            children: [
              {
                id: "conn:hive:sales_analytics",
                label: "sales_analytics",
                type: "schema",
                connectionId: "conn",
                database: "hive",
                schema: "sales_analytics",
                children: [
                  {
                    id: "conn:hive:sales_analytics:__tables",
                    label: "tree.tables",
                    type: "group-tables",
                    connectionId: "conn",
                    database: "hive",
                    schema: "sales_analytics",
                    children: [
                      {
                        id: "conn:hive:sales_analytics:__tables:daily_revenue",
                        label: "daily_revenue",
                        type: "table",
                        connectionId: "conn",
                        database: "hive",
                        schema: "sales_analytics",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    expect(completionSchemasFromTree(tree, "conn", "hive")).toEqual(["sales_analytics"]);
    expect(completionTablesFromTree(tree, "conn", "hive", "sales_analytics")).toEqual([{ name: "daily_revenue", schema: "sales_analytics", type: "table" }]);
    expect(completionTablesFromTree(tree, "conn", "hive")).toEqual([{ name: "daily_revenue", schema: "sales_analytics", type: "table" }]);
  });
});
