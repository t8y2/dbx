// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";
import { matchDataGripImportFiles, parseDataGripConnections, parseDataGripImport, type DataGripImportPayload } from "@/lib/imports/datagripImport";

function payload(dataSources: string, dataSourcesLocal?: string, dbForestConfig?: string): DataGripImportPayload {
  return { format: "datagrip-import", dataSources, dataSourcesLocal, dbForestConfig };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DataGrip connection import", () => {
  it("imports a SQLite file path without treating it as a schema", () => {
    const [connection] = parseDataGripConnections(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Local SQLite" uuid="sqlite-1">
              <driver-ref>sqlite.xerial</driver-ref>
              <jdbc-url>jdbc:sqlite:/tmp/app.sqlite</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(connection).toMatchObject({
      name: "Local SQLite",
      db_type: "sqlite",
      host: "/tmp/app.sqlite",
    });
    expect(connection?.database).toBeUndefined();
  });

  it("recognizes Kingbase custom JDBC drivers", () => {
    const connections = parseDataGripConnections(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Kingbase V8R6" uuid="kingbase-1">
              <driver-ref>java.sql.Driver</driver-ref>
              <jdbc-driver>com.kingbase8.Driver</jdbc-driver>
              <jdbc-url>jdbc:kingbase8://192.168.31.87:54321/test</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      name: "Kingbase V8R6",
      db_type: "kingbase",
      driver_profile: "kingbase",
      driver_label: "KingbaseES",
      host: "192.168.31.87",
      port: 54321,
      database: "test",
      username: "SYSTEM",
    });
  });

  it("imports Kingbase data sources configured by URL without a driver-ref", () => {
    // DataGrip has no built-in Kingbase driver, so every Kingbase connection is
    // a custom driver. Real exports use <configured-by-url>true</configured-by-url>
    // with NO <driver-ref> element — the driver identity lives only in
    // <jdbc-driver> + <jdbc-url>. Such connections must still import.
    const connections = parseDataGripConnections(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Kingbase Dev" uuid="kingbase-url">
              <configured-by-url>true</configured-by-url>
              <jdbc-driver>com.kingbase8.Driver</jdbc-driver>
              <jdbc-url>jdbc:kingbase8://192.0.2.1:54321/app</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      name: "Kingbase Dev",
      db_type: "kingbase",
      driver_profile: "kingbase",
      driver_label: "KingbaseES",
      host: "192.0.2.1",
      port: 54321,
      database: "app",
      username: "SYSTEM",
    });
  });

  it("drops unknown custom drivers configured by URL", () => {
    // No <driver-ref> + an unrecognised driver class/subprotocol must NOT leak
    // in as a generic JDBC connection. It stays dropped. This guards the
    // mergeFragments "" sentinel contract (see parseDataGripImport guard).
    const connections = parseDataGripConnections(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Mystery DB" uuid="mystery-1">
              <configured-by-url>true</configured-by-url>
              <jdbc-driver>com.example.mystery.Driver</jdbc-driver>
              <jdbc-url>jdbc:mystery://10.0.0.1:9999/db</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(connections).toHaveLength(0);
  });

  it("preserves DataGrip connection groups as sidebar groups", () => {
    const result = parseDataGripImport(
      payload(
        `
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Production" uuid="mysql-prod">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://prod.example.com:3306/app</jdbc-url>
            </data-source>
            <data-source name="Development" uuid="mysql-dev">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://dev.example.com:3306/app</jdbc-url>
            </data-source>
            <data-source name="Ungrouped" uuid="mysql-root">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://localhost:3306/app</jdbc-url>
            </data-source>
          </component>
        </project>
      `,
        undefined,
        `
          <project>
            <component name="db-forest-configuration">
              <data version="2">.
                1:0:group-environment:Environment
                2:1:group-production:Production
                3:1:group-development:Development
                ----------------------------------------
                4:2:mysql-prod
                5:3:mysql-dev
                6:0:mysql-root
                .</data>
            </component>
          </project>
        `,
      ),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([
      {
        group: "Environment",
        children: [
          { group: "Production", children: ["Production"] },
          { group: "Development", children: ["Development"] },
        ],
      },
      "Ungrouped",
    ]);
  });

  it("keeps legacy group-name imports compatible", () => {
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Legacy" uuid="mysql-legacy" group-name="Legacy Group">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://localhost:3306/legacy</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([{ group: "Legacy Group", children: ["Legacy"] }]);
  });

  it("preserves the modern DataGrip group attribute", () => {
    // Real DataGrip exports use a `group` attribute on <data-source> (not the
    // legacy `group-name`). Connections sharing a group land under one folder.
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Prod" uuid="mysql-prod" group="production">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://prod.example.com:3306/app</jdbc-url>
            </data-source>
            <data-source name="Dev" uuid="mysql-dev" group="development">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://dev.example.com:3306/app</jdbc-url>
            </data-source>
            <data-source name="Lonely" uuid="mysql-solo">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://localhost:3306/app</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    const names = new Map(result.connections.map((connection) => [connection.id, connection.name]));
    expect(layoutLabels(result.layout!, names)).toEqual([{ group: "production", children: ["Prod"] }, { group: "development", children: ["Dev"] }, "Lonely"]);
  });

  it("keeps the connection-only API and empty layout behavior", () => {
    const importPayload = payload(`
      <project>
        <component name="DataSourceManagerImpl">
          <data-source name="PostgreSQL" uuid="postgres-1">
            <driver-ref>postgresql</driver-ref>
            <jdbc-url>jdbc:postgresql://localhost:5432/postgres</jdbc-url>
          </data-source>
        </component>
      </project>
    `);

    expect(parseDataGripConnections(importPayload)).toHaveLength(1);
    expect(parseDataGripImport(importPayload).layout).toBeUndefined();
  });
});

describe("matchDataGripImportFiles", () => {
  it("picks the three DataGrip config files by name regardless of order", () => {
    const paths = ["C:/proj/.idea/db-forest-config.xml", "C:/proj/.idea/dataSources.local.xml", "C:/proj/.idea/dataSources.xml"];
    expect(matchDataGripImportFiles(paths)).toEqual({
      dataSources: "C:/proj/.idea/dataSources.xml",
      local: "C:/proj/.idea/dataSources.local.xml",
      forest: "C:/proj/.idea/db-forest-config.xml",
    });
  });

  it("allows missing optional local and forest files", () => {
    expect(matchDataGripImportFiles(["C:/proj/.idea/dataSources.xml"])).toEqual({
      dataSources: "C:/proj/.idea/dataSources.xml",
      local: undefined,
      forest: undefined,
    });
  });

  it("throws a coded error when dataSources.xml is not among the selected files", () => {
    let caught: unknown;
    try {
      matchDataGripImportFiles(["C:/proj/other.xml", "C:/proj/dataSources.local.xml"]);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/dataSources\.xml/i);
    expect((caught as Error & { code?: string }).code).toBe("DATAGRIP_IMPORT_MISSING_DATASOURCES");
  });

  it("matches file names case-insensitively", () => {
    const result = matchDataGripImportFiles(["C:/proj/.idea/DataSources.XML", "C:/proj/.idea/datasources.local.xml"]);
    expect(result.dataSources).toBe("C:/proj/.idea/DataSources.XML");
    expect(result.local).toBe("C:/proj/.idea/datasources.local.xml");
  });

  it("handles Windows backslash paths", () => {
    const result = matchDataGripImportFiles(["C:\\proj\\.idea\\dataSources.xml", "C:\\proj\\.idea\\dataSources.local.xml"]);
    expect(result.dataSources).toBe("C:\\proj\\.idea\\dataSources.xml");
    expect(result.local).toBe("C:\\proj\\.idea\\dataSources.local.xml");
  });
});
