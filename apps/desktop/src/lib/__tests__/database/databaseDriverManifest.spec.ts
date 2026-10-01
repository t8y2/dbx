import { describe, expect, it } from "vitest";
import { databaseConnectionFormKind, databaseDefaultPort, databaseManifestEntry, databaseProductCapabilities, databaseRuntimeMode, supportsDatabaseFeature, usesAgentCursorForQuery, usesAgentCursorForTableData } from "@/lib/database/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("advertises implemented Xugu capabilities without enabling unsupported features", () => {
    expect(databaseProductCapabilities("xugu")).toEqual({
      queryExecution: true,
      metadataBrowse: true,
      objectBrowser: true,
      objectSource: true,
      schemaSearch: true,
      diagram: true,
      tableDataEdit: true,
      tableStructureEdit: true,
      tableImport: true,
      dataTransfer: false,
      sqlFileExecution: true,
      databaseCreate: false,
      fieldLineage: false,
      sqlExplain: false,
      userAdmin: true,
      driverManagement: true,
    });
    for (const capability of ["objectSource", "tableDataEdit", "userAdmin"] as const) {
      expect(supportsDatabaseFeature("xugu", capability), capability).toBe(true);
    }
    expect(supportsDatabaseFeature("xugu", "sqlExplain")).toBe(false);
  });

  it("uses agent cursor only for agent or external runtimes", () => {
    expect(databaseRuntimeMode("gaussdb")).toBe("native");
    expect(databaseRuntimeMode("meilisearch")).toBe("native");
    expect(databaseRuntimeMode("dynamodb")).toBe("native");
    expect(usesAgentCursorForQuery("gaussdb")).toBe(false);
    expect(usesAgentCursorForQuery("meilisearch")).toBe(false);
    expect(usesAgentCursorForQuery("dynamodb")).toBe(false);
    expect(usesAgentCursorForQuery("mysql")).toBe(false);
    expect(usesAgentCursorForQuery("cassandra")).toBe(true);
    expect(usesAgentCursorForQuery("jdbc")).toBe(true);
    expect(usesAgentCursorForQuery("prestosql")).toBe(true);
    expect(usesAgentCursorForQuery("sqlserver")).toBe(false);
    expect(usesAgentCursorForQuery("sqlserver", "sqlserver-legacy")).toBe(true);
    expect(usesAgentCursorForQuery("sqlserver", " SQLSERVER-LEGACY ")).toBe(true);
  });

  it("limits table-data agent cursors to Cassandra and SQL Server legacy", () => {
    expect(usesAgentCursorForTableData("cassandra")).toBe(true);
    expect(usesAgentCursorForTableData("sqlserver", "sqlserver-legacy")).toBe(true);
    expect(usesAgentCursorForTableData("sqlserver")).toBe(false);
    expect(usesAgentCursorForTableData("jdbc")).toBe(false);
    expect(usesAgentCursorForTableData("prestosql")).toBe(false);
  });

  it("exposes connection defaults from the shared manifest", () => {
    expect(databaseDefaultPort("mysql")).toBe(3306);
    expect(databaseManifestEntry("h2")).toMatchObject({
      dbType: "h2",
      runtimeMode: "agent",
      agentKey: "h2",
      skipTcpProbe: true,
      localFile: true,
    });
  });

  it("offers only the supported NebulaGraph 3.x profile", () => {
    expect(databaseManifestEntry("nebula")?.driverProfiles).toEqual([{ profile: "nebula-v3", agentKey: "nebula", label: "NebulaGraph 3.x", storeVisible: false }]);
  });

  it("routes only specialized connection forms explicitly", () => {
    expect(databaseConnectionFormKind("mysql")).toBe("standard");
    expect(databaseConnectionFormKind("jdbc")).toBe("jdbc");
    expect(databaseConnectionFormKind("mq")).toBe("mq");
    expect(databaseConnectionFormKind("mqtt")).toBe("mqtt");
    expect(databaseConnectionFormKind("nacos")).toBe("nacos");
  });
});
