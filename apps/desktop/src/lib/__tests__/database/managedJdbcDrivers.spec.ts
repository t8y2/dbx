import { describe, expect, it, vi } from "vitest";
import { installRegisteredManagedJdbcDriver, managedJdbcDriverDefinition, managedJdbcDriverRows } from "@/lib/database/managedJdbcDrivers";
import { PHOENIX_MANAGED_MAVEN_COORDINATES } from "@/lib/database/phoenixBuiltinDriver";
import { PRESTOSQL_JDBC_DRIVER_COORDINATE } from "@/lib/database/prestoSqlBuiltinDriver";
import type { JdbcDriverInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";

function pluginStatus(): JdbcPluginStatus {
  return {
    installed: true,
    version: "1.0.0",
    protocol_version: 1,
    compatible: true,
    latest_version: null,
    latest_protocol_version: null,
    update_available: false,
    path: "/plugins/jdbc",
  };
}

describe("managedJdbcDrivers", () => {
  it("registers Phoenix and PrestoSQL through the same row model", () => {
    expect(managedJdbcDriverDefinition("phoenix")?.bundles.map(({ coordinate }) => coordinate)).toEqual(PHOENIX_MANAGED_MAVEN_COORDINATES);
    expect(managedJdbcDriverDefinition("prestosql")?.bundles.map(({ coordinate }) => coordinate)).toEqual([PRESTOSQL_JDBC_DRIVER_COORDINATE]);
    expect(managedJdbcDriverRows([], pluginStatus()).map(({ db_type }) => db_type)).toEqual(["prestosql", "phoenix"]);
  });

  it("installs PrestoSQL through the generic Maven resolver", async () => {
    const installed: JdbcMavenBundleInfo = {
      id: "io.prestosql_presto-jdbc_350",
      coordinate: PRESTOSQL_JDBC_DRIVER_COORDINATE,
      scope: "runtime",
      repositories: ["https://repo.maven.apache.org/maven2/"],
      installed_at: "2026-08-06T00:00:00Z",
      path: "/drivers/presto",
      artifacts: [],
    };
    const installJdbcDriverFromMaven = vi.fn(async () => [] as JdbcDriverInfo[]);
    const result = await installRegisteredManagedJdbcDriver("prestosql", [], pluginStatus(), {
      installJdbcPlugin: vi.fn(async () => pluginStatus()),
      installJdbcDriverFromMaven,
      listJdbcMavenBundles: vi.fn(async () => [installed]),
      deleteJdbcMavenBundle: vi.fn(async () => [] as JdbcDriverInfo[]),
    });

    expect(installJdbcDriverFromMaven).toHaveBeenCalledWith(PRESTOSQL_JDBC_DRIVER_COORDINATE, ["https://repo.maven.apache.org/maven2/"]);
    expect(result?.bundles).toEqual([installed]);
  });
});
