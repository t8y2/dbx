import { describe, expect, it } from "vitest";
import { favoriteTargetFromNode, favoriteTargetKey, sortFavorites } from "../target";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { TableFavorite } from "@/types/favorites";
const node: TreeNode = { id: "tree-id", label: "display name", objectName: "Users", type: "table", connectionId: "c", database: "db", schema: "public" };
const config = { id: "c", db_type: "postgres" } as ConnectionConfig;
describe("favorite table identity", () => {
  it("uses actual object names and excludes tree IDs", () => {
    const a = favoriteTargetFromNode(node, config)!;
    const b = favoriteTargetFromNode({ ...node, id: "rebuilt", label: "other label" }, config)!;
    expect(a.objectName).toBe("Users");
    expect(favoriteTargetKey(a)).toBe(favoriteTargetKey(b));
  });
  it("keeps case, schema, catalog and connection distinct", () => {
    const a = favoriteTargetFromNode(node, config)!;
    for (const change of [{ objectName: "users" }, { schema: "archive" }, { catalog: "other" }, { connectionId: "other" }]) {
      expect(favoriteTargetKey({ ...a, ...change })).not.toBe(favoriteTargetKey(a));
    }
  });
  it("uses existing MySQL schema normalization", () => {
    const mysql = { ...config, db_type: "mysql" } as ConnectionConfig;
    expect(favoriteTargetFromNode(node, mysql)?.schema).toBe("");
  });
  it("preserves an empty database context and rejects missing context", () => {
    expect(favoriteTargetFromNode({ ...node, database: "" }, config)).not.toBeNull();
    expect(favoriteTargetFromNode({ ...node, database: undefined }, config)).toBeNull();
  });
  it("does not offer favorites for views, special viewers, or linked server nodes", () => {
    expect(favoriteTargetFromNode({ ...node, type: "view" }, config)).toBeNull();
    expect(favoriteTargetFromNode({ ...node, linkedServer: "remote" }, config)).toBeNull();
    for (const db_type of ["mongodb", "hbase", "redis", "neo4j"]) expect(favoriteTargetFromNode(node, { ...config, db_type } as ConnectionConfig)).toBeNull();
  });
  it("sorts numeric codes naturally with stable UUID tie breaks", () => {
    const rows = [
      { id: "z", code: "F10" },
      { id: "b", code: "F2" },
      { id: "a", code: "F02" },
    ] as TableFavorite[];
    expect(sortFavorites(rows).map((item) => item.id)).toEqual(["a", "b", "z"]);
    expect(rows[0].id).toBe("z");
  });
});
