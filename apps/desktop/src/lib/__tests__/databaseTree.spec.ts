import { describe, expect, it } from "vitest";
import { buildDatabaseTreeNodes, sortSidebarDatabases } from "@/lib/database/databaseTree";

describe("buildDatabaseTreeNodes", () => {
  it("passes size_bytes from DatabaseInfo to tree node sizeBytes", () => {
    const databases = [
      { name: "app_db", size_bytes: 1048576 },
      { name: "metrics", size_bytes: 5368709120 },
    ];
    const nodes = buildDatabaseTreeNodes("conn-1", databases);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.label === "app_db")?.sizeBytes).toBe(1048576);
    expect(nodes.find((n) => n.label === "metrics")?.sizeBytes).toBe(5368709120);
  });

  it("sets sizeBytes to null when size_bytes is undefined (drivers without size)", () => {
    const databases = [{ name: "my_db" }];
    const nodes = buildDatabaseTreeNodes("conn-1", databases);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sizeBytes).toBeNull();
  });

  it("sets sizeBytes to null when size_bytes is null (no CONNECT privilege)", () => {
    const databases = [{ name: "restricted_db", size_bytes: null }];
    const nodes = buildDatabaseTreeNodes("conn-1", databases as any);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].sizeBytes).toBeNull();
  });

  it("still builds nodes when size_bytes is missing for all databases", () => {
    const databases = [{ name: "db1" }, { name: "db2" }, { name: "db3" }];
    const nodes = buildDatabaseTreeNodes("conn-1", databases);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.sizeBytes === null)).toBe(true);
  });
});

describe("sortSidebarDatabases", () => {
  it("sorts databases alphabetically with numeric awareness", () => {
    const databases = [{ name: "db10" }, { name: "db2" }, { name: "db1" }];
    const sorted = sortSidebarDatabases(databases);
    expect(sorted.map((d) => d.name)).toEqual(["db1", "db2", "db10"]);
  });
});
