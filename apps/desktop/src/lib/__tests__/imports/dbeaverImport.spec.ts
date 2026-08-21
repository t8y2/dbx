import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "../../../types/database";
import { parseDbeaverConnections, parseDbeaverImport } from "../../imports/dbeaverImport";

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

function clickhouseConnection(id: string, name: string, configuration: Record<string, unknown>) {
  return {
    id,
    name,
    provider: "clickhouse",
    driver: "com_clickhouse",
    configuration,
  };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DBeaver folder import", () => {
  it("imports a SQLite file path without treating it as a schema", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          sqlite: {
            id: "sqlite",
            name: "Local SQLite",
            provider: "sqlite",
            driver: "sqlite_jdbc",
            configuration: {
              url: "jdbc:sqlite:/tmp/app.sqlite",
              database: "/tmp/app.sqlite",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "Local SQLite",
      db_type: "sqlite",
      host: "/tmp/app.sqlite",
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for MySQL root JDBC URLs", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          mysql: {
            id: "mysql",
            name: "208",
            provider: "mysql",
            driver: "mysql8",
            configuration: {
              host: "192.168.3.12",
              port: "51345",
              url: "jdbc:mysql://192.168.3.12:51345/",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "208",
      db_type: "mysql",
      host: "192.168.3.12",
      port: 51345,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for ClickHouse root JDBC URLs", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          clickhouse: clickhouseConnection("clickhouse", "CH", {
            host: "192.168.1.39",
            port: "8123",
            url: "jdbc:clickhouse://192.168.1.39:8123",
          }),
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "CH",
      db_type: "clickhouse",
      host: "192.168.1.39",
      port: 8123,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for SQL Server connections without databaseName", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          sqlserver: {
            id: "sqlserver",
            name: "MSSQL",
            provider: "sqlserver",
            driver: "mssql_jdbc",
            configuration: {
              host: "192.168.10.25",
              port: "1433",
              url: "jdbc:sqlserver://192.168.10.25:1433;encrypt=true",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "MSSQL",
      db_type: "sqlserver",
      host: "192.168.10.25",
      port: 1433,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for Oracle connections without a configured service", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          oracle: {
            id: "oracle",
            name: "Oracle",
            provider: "oracle",
            driver: "oracle_jdbc",
            configuration: {
              host: "192.168.10.30",
              port: "1521",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "Oracle",
      db_type: "oracle",
      host: "192.168.10.30",
      port: 1521,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for PostgreSQL root JDBC URLs", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          postgres: {
            id: "postgres",
            name: "PG",
            provider: "postgresql",
            driver: "postgres-jdbc",
            configuration: {
              host: "192.168.10.40",
              port: "5432",
              url: "jdbc:postgresql://192.168.10.40:5432/",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "PG",
      db_type: "postgres",
      host: "192.168.10.40",
      port: 5432,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for MariaDB root JDBC URLs", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          mariadb: {
            id: "mariadb",
            name: "MariaDB",
            provider: "mysql",
            driver: "mariadb",
            configuration: {
              host: "192.168.10.50",
              port: "3306",
              url: "jdbc:mariadb://192.168.10.50:3306/",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "MariaDB",
      db_type: "mysql",
      driver_profile: "mariadb",
      host: "192.168.10.50",
      port: 3306,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("keeps the default database empty for DB2 connections (fallback to JDBC) without database configured", async () => {
    const [connection] = await parseDbeaverConnections(
      payload({
        connections: {
          db2: {
            id: "db2",
            name: "DB2",
            provider: "db2",
            driver: "db2",
            configuration: {
              host: "192.168.10.60",
              port: "50000",
              url: "jdbc:db2://192.168.10.60:50000/",
            },
          },
        },
      }),
    );

    expect(connection).toMatchObject({
      name: "DB2",
      db_type: "jdbc",
      host: "192.168.10.60",
      port: 50000,
    });
    expect(connection?.database).toBeUndefined();
  });

  it("drops address-shaped database values from host-based imports", async () => {
    const connections = await parseDbeaverConnections(
      payload({
        connections: {
          mysql: {
            id: "mysql",
            name: "208",
            provider: "mysql",
            driver: "mysql8",
            configuration: {
              host: "192.168.3.12",
              port: "51345",
              database: "192.168.3.12:51345",
              url: "jdbc:mysql://192.168.3.12:51345/",
            },
          },
          clickhouse: clickhouseConnection("clickhouse", "CH", {
            host: "192.168.1.39",
            port: "8123",
            database: "8123",
            url: "jdbc:clickhouse://192.168.1.39:8123",
          }),
        },
      }),
    );

    expect(connections[0]?.database).toBeUndefined();
    expect(connections[1]?.database).toBeUndefined();
  });

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

describe("DBeaver Cloudberry import", () => {
  it("preserves Cloudberry while reusing the PostgreSQL backend", async () => {
    const connections = await parseDbeaverConnections(
      payload({
        connections: {
          cloudberry: {
            id: "cloudberry",
            name: "analytics",
            provider: "cloudberry",
            driver: "cloudberry-jdbc",
            configuration: {
              host: "cb.example.com",
              port: 5432,
              database: "warehouse",
              user: "analyst",
            },
          },
        },
      }),
    );

    expect(connections[0]).toMatchObject({
      db_type: "postgres",
      driver_profile: "cloudberry",
      driver_label: "Apache Cloudberry",
      host: "cb.example.com",
      port: 5432,
      database: "warehouse",
      username: "analyst",
    });
  });
});

describe("DBeaver OpenTenBase import", () => {
  it("preserves OpenTenBase while reusing the PostgreSQL backend", async () => {
    const connections = await parseDbeaverConnections(
      payload({
        connections: {
          opentenbase: {
            id: "opentenbase",
            name: "distributed-postgres",
            provider: "opentenbase",
            driver: "opentenbase-postgresql",
            configuration: {
              host: "cn.example.com",
              port: 11000,
              database: "postgres",
              user: "opentenbase",
            },
          },
        },
      }),
    );

    expect(connections[0]).toMatchObject({
      db_type: "postgres",
      driver_profile: "opentenbase",
      driver_label: "OpenTenBase",
      host: "cn.example.com",
      port: 11000,
      database: "postgres",
      username: "opentenbase",
    });
  });
});
