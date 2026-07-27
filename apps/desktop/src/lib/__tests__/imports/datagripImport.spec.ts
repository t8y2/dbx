// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import type { SidebarLayout, SidebarOrderEntry } from "@/types/database";
import { parseDataGripConnections, parseDataGripImport, type DataGripImportPayload } from "@/lib/imports/datagripImport";

function payload(dataSources: string, dataSourcesLocal?: string, dbForestConfig?: string): DataGripImportPayload {
  return { format: "datagrip-import", dataSources, dataSourcesLocal, dbForestConfig };
}

function layoutLabels(layout: SidebarLayout, connectionNames: Map<string, string>): unknown[] {
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const visit = (entries: SidebarOrderEntry[]): unknown[] => entries.map((entry) => (entry.type === "connection" ? connectionNames.get(entry.id) : { group: groupNames.get(entry.id), children: visit(entry.children ?? []) }));
  return visit(layout.order);
}

describe("DataGrip connection import", () => {
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
