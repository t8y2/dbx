import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";
import { parseDbeaverConnections, parseDbeaverImport } from "@/lib/imports/dbeaverImport";

function payload(dataSources: Record<string, unknown>) {
  return JSON.stringify({ format: "dbeaver-import", dataSources: JSON.stringify(dataSources) });
}

function mysqlConnection(id: string, name: string, folder?: string) {
  return {
    id,
    name,
    folder,
    provider: "mysql",
    driver: "mysql",
    configuration: { host: "127.0.0.1", port: 3306, database: name },
  };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DBeaver folder import", () => {
  it("keeps parseDbeaverConnections compatible when no folders exist", async () => {
    const connections = await parseDbeaverConnections(payload({ connections: { root: mysqlConnection("root", "Root") } }));

    expect(connections).toHaveLength(1);
    expect(connections[0]?.name).toBe("Root");
    expect((await parseDbeaverImport(payload({ connections: {} }))).layout).toBeUndefined();
  });

  it("builds nested groups from declared folders and connection folder paths", async () => {
    const result = await parseDbeaverImport(
      payload({
        folders: {
          Environment: {},
          Region: { parent: "Environment" },
          Team: { parent: "Environment/Region" },
        },
        connections: {
          nested: mysqlConnection("nested", "Nested", "Environment/Region/Team"),
          root: mysqlConnection("root", "Root"),
        },
      }),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([
      {
        group: "Environment",
        children: [{ group: "Region", children: [{ group: "Team", children: ["Nested"] }] }],
      },
      "Root",
    ]);
  });

  it("creates missing parent folders declared only by a child folder", async () => {
    const result = await parseDbeaverImport(
      payload({
        folders: { Leaf: { parent: "Missing/Parent" } },
        connections: { nested: mysqlConnection("nested", "Nested", "Missing/Parent/Leaf") },
      }),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([
      {
        group: "Missing",
        children: [{ group: "Parent", children: [{ group: "Leaf", children: ["Nested"] }] }],
      },
    ]);
  });

  it("creates unknown folders referenced only by a connection", async () => {
    const result = await parseDbeaverImport(payload({ connections: { nested: mysqlConnection("nested", "Nested", "Ad hoc/Production") } }));

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([{ group: "Ad hoc", children: [{ group: "Production", children: ["Nested"] }] }]);
  });
});
