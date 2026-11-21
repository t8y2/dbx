// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseNavicatConnections } from "./navicatImport";

describe("Navicat saved JSON connections", () => {
  it("reads connection maps and normalizes native field names", async () => {
    const connections = await parseNavicatConnections(
      JSON.stringify({
        connections: {
          first: { conn_type: "MYSQL", conn_name: "Production", host: "mysql.example", port: 3307, user_name: "reader", database: "app" },
          second: { ConnectionType: "POSTGRESQL", ConnectionName: "Analytics", Host: "pg.example", Port: 5432 },
        },
      }),
    );
    expect(connections.map(({ name, db_type, host, port }) => ({ name, db_type, host, port }))).toEqual([
      { name: "Production", db_type: "mysql", host: "mysql.example", port: 3307 },
      { name: "Analytics", db_type: "postgres", host: "pg.example", port: 5432 },
    ]);
    expect(connections[0].username).toBe("reader");
    expect(connections[0].database).toBe("app");
  });

  it("reads nested connection settings without importing metadata as a connection", async () => {
    const connections = await parseNavicatConnections(
      JSON.stringify({
        connections: [
          { name: "Local", general: { connType: "MYSQL", host: "localhost", port: 3306 } },
          { name: "Local", general: { connType: "MYSQL", host: "localhost", port: 3306 } },
        ],
        profiles: { name: "Profiles", count: 2 },
      }),
    );
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe("Local");
  });

  it("rejects invalid JSON", async () => {
    await expect(parseNavicatConnections("{invalid")).rejects.toThrow();
  });
});
