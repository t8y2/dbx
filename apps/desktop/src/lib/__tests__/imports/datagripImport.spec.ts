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

  it("extracts username and password from JDBC authority and query parameters", () => {
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="MySQL Auth" uuid="mysql-1">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://myuser:mypass@127.0.0.1:3306/appdb</jdbc-url>
            </data-source>
            <data-source name="Postgres Query" uuid="pg-1">
              <driver-ref>postgresql</driver-ref>
              <jdbc-url>jdbc:postgresql://127.0.0.1:5432/appdb?user=custom_pg&amp;password=secret</jdbc-url>
            </data-source>
            <data-source name="SQL Server Params" uuid="mssql-1">
              <driver-ref>sqlserver</driver-ref>
              <jdbc-url>jdbc:sqlserver://127.0.0.1:1433;database=testdb;user=sa_user;password=sapass</jdbc-url>
            </data-source>
            <data-source name="Oracle Thin Auth" uuid="ora-1">
              <driver-ref>oracle</driver-ref>
              <jdbc-url>jdbc:oracle:thin:scott/tiger@//127.0.0.1:1521/orcl</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(result.fallbackUsernamesCount).toBe(0);
    expect(result.connections).toHaveLength(4);

    const mysqlConn = result.connections.find((c) => c.name === "MySQL Auth");
    expect(mysqlConn?.username).toBe("myuser");
    expect(mysqlConn?.password).toBe("mypass");

    const pgConn = result.connections.find((c) => c.name === "Postgres Query");
    expect(pgConn?.username).toBe("custom_pg");
    expect(pgConn?.password).toBe("secret");

    const mssqlConn = result.connections.find((c) => c.name === "SQL Server Params");
    expect(mssqlConn?.username).toBe("sa_user");
    expect(mssqlConn?.password).toBe("sapass");

    const oraConn = result.connections.find((c) => c.name === "Oracle Thin Auth");
    expect(oraConn?.username).toBe("scott");
    expect(oraConn?.password).toBe("tiger");
  });

  it("keeps a literal percent sequence in URL credentials instead of aborting the import", () => {
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Literal Percent" uuid="pct-1">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://myuser:p%40ss%zz@127.0.0.1:3306/appdb</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(result.connections).toHaveLength(1);
    const conn = result.connections.find((c) => c.name === "Literal Percent");
    expect(conn?.username).toBe("myuser");
    // Any invalid `%` sequence keeps the credential verbatim rather than throwing URIError.
    expect(conn?.password).toBe("p%40ss%zz");
  });

  it("extracts usernames from XML properties and tags without importing encrypted passwords", () => {
    const result = parseDataGripImport(
      payload(
        `
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="Prop User" uuid="prop-1">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://localhost:3306/db</jdbc-url>
              <property name="user" value="xml_user" />
              <property name="password" value="xml_pass" />
            </data-source>
            <data-source name="Tag Username" uuid="tag-1" user="attr_user">
              <driver-ref>postgresql</driver-ref>
              <jdbc-url>jdbc:postgresql://localhost:5432/db</jdbc-url>
            </data-source>
          </component>
        </project>
        `,
        `
        <project>
          <component name="DataSourceManagerImpl">
            <data-source uuid="tag-1">
              <user-name>local_user</user-name>
              <password>local_pass</password>
            </data-source>
          </component>
        </project>
        `,
      ),
    );

    expect(result.fallbackUsernamesCount).toBe(0);
    const propConn = result.connections.find((c) => c.name === "Prop User");
    expect(propConn?.username).toBe("xml_user");
    // DataGrip XML always stores encrypted ciphertext; importing it as the working password
    // would break auth, so XML passwords are ignored (URL-embedded credentials still apply).
    expect(propConn?.password).toBe("");

    const tagConn = result.connections.find((c) => c.name === "Tag Username");
    expect(tagConn?.username).toBe("local_user");
    expect(tagConn?.password).toBe("");
  });

  it("tracks fallback usernames count when no username is provided", () => {
    const result = parseDataGripImport(
      payload(`
        <project>
          <component name="DataSourceManagerImpl">
            <data-source name="MySQL Default" uuid="mysql-def">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://localhost:3306/db</jdbc-url>
            </data-source>
            <data-source name="Explicit User" uuid="mysql-exp">
              <driver-ref>mysql</driver-ref>
              <jdbc-url>jdbc:mysql://myuser@localhost:3306/db</jdbc-url>
            </data-source>
          </component>
        </project>
      `),
    );

    expect(result.fallbackUsernamesCount).toBe(1);
    const defConn = result.connections.find((c) => c.name === "MySQL Default");
    expect(defConn?.username).toBe("root");

    const expConn = result.connections.find((c) => c.name === "Explicit User");
    expect(expConn?.username).toBe("myuser");
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
