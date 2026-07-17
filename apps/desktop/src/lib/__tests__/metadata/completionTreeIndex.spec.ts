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
                      {
                        id: "conn:hive:sales_analytics:__tables:daily_revenue_view",
                        label: "daily_revenue_view",
                        type: "view",
                        connectionId: "conn",
                        database: "hive",
                        schema: "sales_analytics",
                      },
                      {
                        id: "conn:hive:sales_analytics:__tables:daily_revenue_mv",
                        label: "daily_revenue_mv",
                        type: "materialized_view",
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
    const expected = [
      { name: "daily_revenue", schema: "sales_analytics", type: "table" },
      { name: "daily_revenue_view", schema: "sales_analytics", type: "view" },
      { name: "daily_revenue_mv", schema: "sales_analytics", type: "materialized_view" },
    ];
    expect(completionTablesFromTree(tree, "conn", "hive", "sales_analytics")).toEqual(expected);
    expect(completionTablesFromTree(tree, "conn", "hive")).toEqual(expected);
  });
});
