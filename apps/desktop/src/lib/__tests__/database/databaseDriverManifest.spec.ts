import { describe, expect, it } from "vitest";
import { databaseConnectionFormKind, databaseDefaultPort, databaseManifestEntry, databaseRuntimeMode, usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";

describe("databaseDriverManifest", () => {
  it("uses agent cursor only for agent or external runtimes", () => {
    expect(databaseRuntimeMode("gaussdb")).toBe("native");
    expect(databaseRuntimeMode("meilisearch")).toBe("native");
    expect(databaseRuntimeMode("dynamodb")).toBe("native");
    expect(usesAgentCursorForQuery("gaussdb")).toBe(false);
    expect(usesAgentCursorForQuery("meilisearch")).toBe(false);
    expect(usesAgentCursorForQuery("dynamodb")).toBe(false);
    expect(usesAgentCursorForQuery("mysql")).toBe(false);
    expect(usesAgentCursorForQuery("jdbc")).toBe(true);
    expect(usesAgentCursorForQuery("prestosql")).toBe(true);
    expect(usesAgentCursorForQuery("sqlserver")).toBe(false);
    expect(usesAgentCursorForQuery("sqlserver", "sqlserver-legacy")).toBe(true);
    expect(usesAgentCursorForQuery("sqlserver", " SQLSERVER-LEGACY ")).toBe(true);
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

  it("routes only specialized connection forms explicitly", () => {
    expect(databaseConnectionFormKind("mysql")).toBe("standard");
    expect(databaseConnectionFormKind("jdbc")).toBe("jdbc");
    expect(databaseConnectionFormKind("mq")).toBe("mq");
    expect(databaseConnectionFormKind("mqtt")).toBe("mqtt");
    expect(databaseConnectionFormKind("nacos")).toBe("nacos");
  });
});
