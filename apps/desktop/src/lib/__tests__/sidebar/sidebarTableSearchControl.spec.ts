import { describe, expect, it } from "vitest";
import { findNodePathById, resolveLocalTableSearchParent, tableSearchControlId } from "@/lib/sidebar/sidebarTableSearchControl";
import type { TreeNode } from "@/types/database";

describe("sidebarTableSearchControl", () => {
  const treeNodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "MySQL Connection",
      type: "connection",
      connectionId: "conn:1",
      children: [
        {
          id: "conn:1:db1",
          label: "db1",
          type: "database",
          connectionId: "conn:1",
          database: "db1",
          children: [
            {
              id: "conn:1:db1:t_users",
              label: "t_users",
              type: "table",
              connectionId: "conn:1",
              database: "db1",
            },
            {
              id: "conn:1:db1:v_active_users",
              label: "v_active_users",
              type: "view",
              connectionId: "conn:1",
              database: "db1",
            },
          ],
        },
        {
          id: "conn:1:db2",
          label: "db2",
          type: "database",
          connectionId: "conn:1",
          database: "db2",
          children: [
            {
              id: "conn:1:db2:__tables",
              label: "Tables",
              type: "group-tables",
              connectionId: "conn:1",
              database: "db2",
              children: [
                {
                  id: "conn:1:db2:orders",
                  label: "orders",
                  type: "table",
                  connectionId: "conn:1",
                  database: "db2",
                },
              ],
            },
            {
              id: "conn:1:db2:__views",
              label: "Views",
              type: "group-views",
              connectionId: "conn:1",
              database: "db2",
            },
          ],
        },
      ],
    },
    {
      id: "conn:pg",
      label: "Postgres Connection",
      type: "connection",
      connectionId: "conn:pg",
      children: [
        {
          id: "conn:pg:db",
          label: "mydb",
          type: "database",
          connectionId: "conn:pg",
          database: "mydb",
          children: [
            {
              id: "conn:pg:db:public",
              label: "public",
              type: "schema",
              connectionId: "conn:pg",
              database: "mydb",
              schema: "public",
              children: [
                {
                  id: "conn:pg:db:public:items",
                  label: "items",
                  type: "table",
                  connectionId: "conn:pg",
                  database: "mydb",
                  schema: "public",
                },
              ],
            },
            {
              id: "conn:pg:db:routines_only",
              label: "routines_only",
              type: "schema",
              connectionId: "conn:pg",
              database: "mydb",
              schema: "routines_only",
              children: [
                {
                  id: "conn:pg:db:routines_only:fn1",
                  label: "fn1",
                  type: "function",
                  connectionId: "conn:pg",
                  database: "mydb",
                  schema: "routines_only",
                },
              ],
            },
          ],
        },
        {
          id: "conn:pg:db_collapsed",
          label: "db_collapsed",
          type: "database",
          connectionId: "conn:pg",
          database: "db_collapsed",
        },
      ],
    },
    {
      id: "conn:grouped_routines",
      label: "Grouped Routines Connection",
      type: "connection",
      connectionId: "conn:grouped_routines",
      children: [
        {
          id: "conn:grouped_routines:db",
          label: "db_routines",
          type: "database",
          connectionId: "conn:grouped_routines",
          database: "db_routines",
          children: [
            {
              id: "conn:grouped_routines:db:__procedures",
              label: "Procedures",
              type: "group-procedures",
              connectionId: "conn:grouped_routines",
              database: "db_routines",
              children: [
                {
                  id: "conn:grouped_routines:db:proc1",
                  label: "proc1",
                  type: "procedure",
                  connectionId: "conn:grouped_routines",
                  database: "db_routines",
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  describe("findNodePathById", () => {
    it("returns node path from root to leaf", () => {
      const path = findNodePathById(treeNodes, "conn:1:db1:t_users");
      expect(path?.map((n) => n.id)).toEqual(["conn:1", "conn:1:db1", "conn:1:db1:t_users"]);
    });

    it("returns undefined for unknown node id", () => {
      expect(findNodePathById(treeNodes, "unknown")).toBeUndefined();
    });
  });

  describe("tableSearchControlId", () => {
    it("creates predictable control id from parent id", () => {
      expect(tableSearchControlId("conn:1:db1")).toBe("conn:1:db1:__table_search");
    });
  });

  describe("resolveLocalTableSearchParent", () => {
    it("returns null when activeNodeId is empty or undefined", () => {
      expect(resolveLocalTableSearchParent(treeNodes, null)).toBeNull();
      expect(resolveLocalTableSearchParent(treeNodes, undefined)).toBeNull();
      expect(resolveLocalTableSearchParent(treeNodes, "")).toBeNull();
    });

    it("returns null when activeNodeId is at connection level", () => {
      expect(resolveLocalTableSearchParent(treeNodes, "conn:1")).toBeNull();
    });

    describe("simple mode", () => {
      it("resolves database node when database is selected", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:1:db1", "simple");
        expect(parent?.id).toBe("conn:1:db1");
        expect(parent?.type).toBe("database");
      });

      it("resolves parent database when table is selected", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:1:db1:t_users", "simple");
        expect(parent?.id).toBe("conn:1:db1");
        expect(parent?.type).toBe("database");
      });

      it("resolves schema node when schema or table under schema is selected", () => {
        const schemaParent = resolveLocalTableSearchParent(treeNodes, "conn:pg:db:public", "simple");
        expect(schemaParent?.id).toBe("conn:pg:db:public");
        expect(schemaParent?.type).toBe("schema");

        const tableParent = resolveLocalTableSearchParent(treeNodes, "conn:pg:db:public:items", "simple");
        expect(tableParent?.id).toBe("conn:pg:db:public");
        expect(tableParent?.type).toBe("schema");
      });

      it("returns null for routine-only schema or routine item", () => {
        expect(resolveLocalTableSearchParent(treeNodes, "conn:pg:db:routines_only", "simple")).toBeNull();
        expect(resolveLocalTableSearchParent(treeNodes, "conn:pg:db:routines_only:fn1", "simple")).toBeNull();
      });

      it("resolves collapsed database node before its children are loaded", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:pg:db_collapsed", "simple");
        expect(parent?.id).toBe("conn:pg:db_collapsed");
        expect(parent?.type).toBe("database");
      });
    });

    describe("grouped mode", () => {
      it("resolves group-tables node when table is selected", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:1:db2:orders", "grouped");
        expect(parent?.id).toBe("conn:1:db2:__tables");
        expect(parent?.type).toBe("group-tables");
      });

      it("resolves group-tables node when group-tables is selected", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:1:db2:__tables", "grouped");
        expect(parent?.id).toBe("conn:1:db2:__tables");
        expect(parent?.type).toBe("group-tables");
      });

      it("resolves child group-tables node when database is selected", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:1:db2", "grouped");
        expect(parent?.id).toBe("conn:1:db2:__tables");
        expect(parent?.type).toBe("group-tables");
      });

      it("returns null when database/schema in grouped mode has no group-tables", () => {
        expect(resolveLocalTableSearchParent(treeNodes, "conn:grouped_routines:db", "grouped")).toBeNull();
        expect(resolveLocalTableSearchParent(treeNodes, "conn:grouped_routines:db:__procedures", "grouped")).toBeNull();
        expect(resolveLocalTableSearchParent(treeNodes, "conn:grouped_routines:db:proc1", "grouped")).toBeNull();
      });

      it("resolves collapsed database node before its children are loaded in grouped mode", () => {
        const parent = resolveLocalTableSearchParent(treeNodes, "conn:pg:db_collapsed", "grouped");
        expect(parent?.id).toBe("conn:pg:db_collapsed");
        expect(parent?.type).toBe("database");
      });
    });
  });
});
