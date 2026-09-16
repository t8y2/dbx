import { describe, expect, it, vi } from "vitest";
import {
  createJdbcProductConnectionFieldsByMode,
  createJdbcProductProfileRegistry,
  ensureJdbcProductRuntimeDrivers,
  isJdbcProductDefaultDriverClass,
  jdbcProductManagedRuntimePaths,
  rememberJdbcProductConnectionFields,
  validateJdbcProductManagedDriver,
  type JdbcProductProfileDefinition,
} from "@/lib/database/jdbcProductProfile";
import type { ManagedJdbcDriverDefinition } from "@/lib/database/managedJdbcDriver";
import type { ConnectionConfig, JdbcMavenBundleInfo } from "@/types/database";

const directCoordinate = "com.example:fixture-direct:1.0.0";
const proxyCoordinate = "com.example:fixture-proxy:1.0.0";

const profile: JdbcProductProfileDefinition = {
  id: "fixture",
  label: "Fixture JDBC",
  icon: "fixture",
  category: "analytics",
  port: 0,
  user: "",
  match: { dbType: "jdbc", driverProfile: "fixture" },
  managedDriverId: "fixture",
  runtimeLabelKey: "connection.fixtureRuntime",
  driverManagerHintPrefixKey: "connection.fixtureHintPrefix",
  driverManagerHintSuffixKey: "connection.fixtureHintSuffix",
  docsLabelKey: "connection.fixtureDocs",
  docsUrl: "https://example.com/docs",
  missingDriverError: "Fixture driver is not installed.",
  missingPluginError: "JDBC plugin is not installed.",
  modes: [
    {
      id: "direct",
      labelKey: "connection.fixtureDirect",
      hintKey: "connection.fixtureDirectHint",
      defaultConnectionString: "jdbc:fixture:direct",
      defaultDriverClass: "com.example.DirectDriver",
      managedCoordinates: [directCoordinate],
    },
    {
      id: "proxy",
      labelKey: "connection.fixtureProxy",
      hintKey: "connection.fixtureProxyHint",
      defaultConnectionString: "jdbc:fixture:proxy",
      defaultDriverClass: "com.example.ProxyDriver",
      managedCoordinates: [proxyCoordinate],
    },
  ],
  detectMode: (config) => (config.connection_string?.includes(":proxy") ? "proxy" : "direct"),
  isCompatibleRuntimePath: (path, mode) => path.endsWith(`fixture-${mode}.jar`),
};

function config(mode: "direct" | "proxy" = "direct"): ConnectionConfig {
  return {
    id: "fixture-1",
    name: "Fixture",
    db_type: "jdbc",
    driver_profile: "fixture",
    host: "",
    port: 0,
    username: "",
    password: "",
    connection_string: `jdbc:fixture:${mode}`,
    jdbc_driver_class: mode === "direct" ? "com.example.DirectDriver" : "com.example.ProxyDriver",
    jdbc_driver_paths: [],
  };
}

function bundle(coordinate: string): JdbcMavenBundleInfo {
  const [groupId, artifactId, version] = coordinate.split(":");
  return {
    id: coordinate.replaceAll(":", "_"),
    coordinate,
    scope: "runtime",
    repositories: ["https://repo.example.com/"],
    installed_at: "2026-08-06T00:00:00Z",
    path: `/drivers/${artifactId}`,
    artifacts: [
      {
        group_id: groupId,
        artifact_id: artifactId,
        version,
        classifier: "",
        extension: "jar",
        file_name: `${artifactId}-${version}.jar`,
        path: `/drivers/${artifactId}-${version}.jar`,
        size: 1,
        sha256: coordinate,
      },
    ],
  };
}

describe("jdbcProductProfile", () => {
  it("rejects duplicate profile ids and matchers", () => {
    expect(() => createJdbcProductProfileRegistry([{ ...profile, id: "" }])).toThrow(/id must not be empty/);
    expect(() => createJdbcProductProfileRegistry([profile, { ...profile }])).toThrow(/Duplicate JDBC product profile id/);
    expect(() => createJdbcProductProfileRegistry([profile, { ...profile, id: "fixture-copy" }])).toThrow(/Duplicate JDBC product profile matcher/);
  });

  it("requires every profile runtime coordinate to be owned by its managed driver", () => {
    const driver: ManagedJdbcDriverDefinition = {
      id: "fixture",
      label: "Fixture JDBC",
      version: "1.0.0",
      jre: "21",
      bundles: [
        { coordinate: directCoordinate, repositories: [] },
        { coordinate: proxyCoordinate, repositories: [] },
      ],
    };

    expect(() => validateJdbcProductManagedDriver(profile, driver)).not.toThrow();
    expect(() => validateJdbcProductManagedDriver(profile, undefined)).toThrow(/unknown managed driver/);
    expect(() => validateJdbcProductManagedDriver(profile, { ...driver, bundles: driver.bundles.slice(0, 1) })).toThrow(/requires coordinate not owned/);
  });

  it("provides reusable per-mode defaults and field memory", () => {
    let fields = createJdbcProductConnectionFieldsByMode(profile);
    fields = rememberJdbcProductConnectionFields(profile, fields, "direct", {
      connectionString: "jdbc:fixture:custom",
      driverClass: "com.example.CustomDriver",
    });

    expect(fields.direct).toEqual({ connectionString: "jdbc:fixture:custom", driverClass: "com.example.CustomDriver" });
    expect(fields.proxy).toEqual({ connectionString: "jdbc:fixture:proxy", driverClass: "com.example.ProxyDriver" });
    expect(isJdbcProductDefaultDriverClass(profile, "com.example.ProxyDriver")).toBe(true);
    expect(isJdbcProductDefaultDriverClass(profile, "com.example.CustomDriver")).toBe(false);
  });

  it("selects the registered mode runtime while preserving unrelated paths", async () => {
    const direct = bundle(directCoordinate);
    const proxy = bundle(proxyCoordinate);
    const connection = config("proxy");
    connection.jdbc_driver_paths = [direct.artifacts[0].path, "/etc/fixture"];
    const api = {
      jdbcPluginStatus: vi.fn(async () => ({ installed: true, compatible: true })),
      listJdbcMavenBundles: vi.fn(async () => [direct, proxy]),
    };

    const result = await ensureJdbcProductRuntimeDrivers(profile, connection, api);

    expect(jdbcProductManagedRuntimePaths(profile, [direct, proxy], "proxy")).toEqual([proxy.artifacts[0].path]);
    expect(result?.paths).toEqual(["/etc/fixture", proxy.artifacts[0].path]);
    expect(result?.runtimeSelectionId).toBe("fixture:proxy");
  });

  it("preserves an explicitly selected compatible custom runtime", async () => {
    const connection = config();
    connection.jdbc_driver_paths = ["/opt/fixture-direct.jar", "/etc/fixture"];

    const result = await ensureJdbcProductRuntimeDrivers(profile, connection, {
      jdbcPluginStatus: vi.fn(async () => ({ installed: true, compatible: true })),
      listJdbcMavenBundles: vi.fn(async () => []),
    });

    expect(result?.paths).toEqual(connection.jdbc_driver_paths);
    expect(result?.runtimeSelectionId).toBeUndefined();
  });
});
