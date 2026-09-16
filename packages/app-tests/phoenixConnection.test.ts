import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, vi } from "vitest";
import {
  isPhoenixRuntimePath,
  PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE,
  PHOENIX_DIRECT_MAVEN_COORDINATE,
  PHOENIX_DIRECT_JDBC_DRIVER_CLASS,
  PHOENIX_DIRECT_JDBC_URL,
  PHOENIX_DRIVER_NOT_INSTALLED_ERROR,
  PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR,
  PHOENIX_JDBC_PRODUCT_PROFILE,
  PHOENIX_MAVEN_REPOSITORY,
  phoenixConnectionModeForConfig,
  PHOENIX_QUERY_SERVER_MAVEN_COORDINATE,
  PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
  PHOENIX_QUERY_SERVER_JDBC_URL,
} from "../../apps/desktop/src/lib/database/phoenixConnection.ts";
import {
  createJdbcProductConnectionFieldsByMode,
  ensureJdbcProductRuntimeDrivers,
  isJdbcProductDefaultDriverClass,
  isJdbcProductManagedMavenCoordinate,
  isJdbcProductManagedMavenPath,
  isJdbcProductRuntimeInstallError,
  jdbcProductConnectionDefaults,
  jdbcProductManagedRuntimePaths,
  jdbcProductMode,
  jdbcProductRuntimeSelectionId,
  rememberJdbcProductConnectionFields,
} from "../../apps/desktop/src/lib/database/jdbcProductProfile.ts";
import type { ConnectionConfig, JdbcMavenBundleInfo } from "../../apps/desktop/src/types/database.ts";

function phoenixConfig(mode: "direct" | "query-server" = "direct"): ConnectionConfig {
  const defaults = jdbcProductConnectionDefaults(PHOENIX_JDBC_PRODUCT_PROFILE, mode);
  return {
    id: "phoenix-1",
    name: "Apache Phoenix",
    db_type: "jdbc",
    driver_profile: "phoenix",
    driver_label: "Apache Phoenix",
    host: "",
    port: 0,
    username: "",
    password: "",
    connection_string: defaults.connectionString,
    jdbc_driver_class: defaults.driverClass,
    jdbc_driver_paths: [],
  };
}

function mavenBundle(coordinate: string): JdbcMavenBundleInfo {
  const [groupId, artifactId, version] = coordinate.split(":");
  const path = `/drivers/${artifactId}-${version}.jar`;
  return {
    id: `${artifactId}-${version}`,
    coordinate,
    scope: "runtime",
    repositories: [PHOENIX_MAVEN_REPOSITORY],
    installed_at: "2026-08-05T00:00:00Z",
    path: `/drivers/${artifactId}-${version}`,
    artifacts: [
      {
        group_id: groupId,
        artifact_id: artifactId,
        version,
        classifier: "",
        extension: "jar",
        file_name: `${artifactId}-${version}.jar`,
        path,
        size: 1,
        sha256: coordinate,
      },
    ],
  };
}

function runtimeApi(initialBundles: JdbcMavenBundleInfo[] = [], pluginInstalled = true) {
  const bundles = [...initialBundles];
  const jdbcPluginStatus = vi.fn(async () => ({ installed: pluginInstalled, compatible: pluginInstalled }));
  const listJdbcMavenBundles = vi.fn(async () => [...bundles]);
  return {
    bundles,
    api: {
      jdbcPluginStatus,
      listJdbcMavenBundles,
    },
    jdbcPluginStatus,
    listJdbcMavenBundles,
  };
}

test("provides official Phoenix JDBC defaults for both connection modes", () => {
  assert.equal(PHOENIX_QUERY_SERVER_JDBC_URL, "jdbc:phoenix:thin:url=http://127.0.0.1:8765;serialization=PROTOBUF");
  assert.deepEqual(jdbcProductConnectionDefaults(PHOENIX_JDBC_PRODUCT_PROFILE, "direct"), {
    connectionString: PHOENIX_DIRECT_JDBC_URL,
    driverClass: PHOENIX_DIRECT_JDBC_DRIVER_CLASS,
  });
  assert.deepEqual(jdbcProductConnectionDefaults(PHOENIX_JDBC_PRODUCT_PROFILE, "query-server"), {
    connectionString: PHOENIX_QUERY_SERVER_JDBC_URL,
    driverClass: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
  });
});

test("detects Query Server from either the thin URL or driver class", () => {
  assert.equal(phoenixConnectionModeForConfig({ connection_string: PHOENIX_DIRECT_JDBC_URL }), "direct");
  assert.equal(phoenixConnectionModeForConfig({ jdbc_driver_class: PHOENIX_DIRECT_JDBC_DRIVER_CLASS }), "direct");
  assert.equal(phoenixConnectionModeForConfig({ connection_string: "jdbc:phoenix:thin:url=https://phoenix.example.com:8765" }), "query-server");
  assert.equal(phoenixConnectionModeForConfig({ jdbc_driver_class: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS }), "query-server");
});

test("hydrates only the detected mode and preserves custom Phoenix fields", () => {
  const fields = createJdbcProductConnectionFieldsByMode(PHOENIX_JDBC_PRODUCT_PROFILE, {
    connection_string: "jdbc:phoenix:thin:url=https://phoenix.example.com:8765;serialization=PROTOBUF",
    jdbc_driver_class: "com.example.CustomPhoenixThinDriver",
  });

  assert.deepEqual(fields.direct, jdbcProductConnectionDefaults(PHOENIX_JDBC_PRODUCT_PROFILE, "direct"));
  assert.deepEqual(fields["query-server"], {
    connectionString: "jdbc:phoenix:thin:url=https://phoenix.example.com:8765;serialization=PROTOBUF",
    driverClass: "com.example.CustomPhoenixThinDriver",
  });
});

test("remembers independent custom values while switching modes", () => {
  let fields = createJdbcProductConnectionFieldsByMode(PHOENIX_JDBC_PRODUCT_PROFILE);
  fields = rememberJdbcProductConnectionFields(PHOENIX_JDBC_PRODUCT_PROFILE, fields, "direct", {
    connectionString: "jdbc:phoenix:zk1,zk2:2181:/hbase-secure",
    driverClass: "com.example.CustomPhoenixDriver",
  });
  fields = rememberJdbcProductConnectionFields(PHOENIX_JDBC_PRODUCT_PROFILE, fields, "query-server", {
    connectionString: "jdbc:phoenix:thin:url=https://query.example.com:8765",
    driverClass: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
  });

  assert.deepEqual(fields.direct, {
    connectionString: "jdbc:phoenix:zk1,zk2:2181:/hbase-secure",
    driverClass: "com.example.CustomPhoenixDriver",
  });
  assert.deepEqual(fields["query-server"], {
    connectionString: "jdbc:phoenix:thin:url=https://query.example.com:8765",
    driverClass: PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS,
  });
});

test("recognizes only generated Phoenix driver classes as replaceable defaults", () => {
  assert.equal(isJdbcProductDefaultDriverClass(PHOENIX_JDBC_PRODUCT_PROFILE, undefined), true);
  assert.equal(isJdbcProductDefaultDriverClass(PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_DIRECT_JDBC_DRIVER_CLASS), true);
  assert.equal(isJdbcProductDefaultDriverClass(PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_QUERY_SERVER_JDBC_DRIVER_CLASS), true);
  assert.equal(isJdbcProductDefaultDriverClass(PHOENIX_JDBC_PRODUCT_PROFILE, "com.example.CustomPhoenixDriver"), false);
});

test("defines mode-specific Phoenix Maven runtimes", () => {
  assert.deepEqual(jdbcProductMode(PHOENIX_JDBC_PRODUCT_PROFILE, "direct").managedCoordinates, [PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE]);
  assert.deepEqual(jdbcProductMode(PHOENIX_JDBC_PRODUCT_PROFILE, "query-server").managedCoordinates, [PHOENIX_QUERY_SERVER_MAVEN_COORDINATE]);
  assert.equal(isPhoenixRuntimePath("/drivers/phoenix-client-embedded-hbase-2.5-5.2.1.jar", "direct"), true);
  assert.equal(isPhoenixRuntimePath("/drivers/phoenix-queryserver-client-6.0.0.jar", "query-server"), true);
  assert.equal(isPhoenixRuntimePath("/drivers/phoenix-queryserver-client-6.0.0.jar", "direct"), false);
  assert.equal(isJdbcProductManagedMavenPath(PHOENIX_JDBC_PRODUCT_PROFILE, "/plugins/jdbc/drivers/maven/org.apache.phoenix_phoenix-queryserver-client_6.0.0/jars/phoenix-queryserver-client-6.0.0.jar"), true);
  assert.equal(isJdbcProductManagedMavenPath(PHOENIX_JDBC_PRODUCT_PROFILE, "/opt/phoenix-queryserver-client-6.0.0.jar"), false);
  assert.equal(isJdbcProductManagedMavenCoordinate(PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_DIRECT_MAVEN_COORDINATE), true);
  assert.equal(isJdbcProductManagedMavenCoordinate(PHOENIX_JDBC_PRODUCT_PROFILE, "com.example:custom-driver:1.0.0"), false);
  assert.equal(jdbcProductRuntimeSelectionId(PHOENIX_JDBC_PRODUCT_PROFILE, "direct"), "phoenix:direct");
});

test("builds one complete selector runtime for each installed Phoenix mode", () => {
  const direct = mavenBundle(PHOENIX_DIRECT_MAVEN_COORDINATE);
  const logging = mavenBundle(PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE);
  const queryServer = mavenBundle(PHOENIX_QUERY_SERVER_MAVEN_COORDINATE);

  assert.deepEqual(jdbcProductManagedRuntimePaths(PHOENIX_JDBC_PRODUCT_PROFILE, [direct, logging, queryServer], "direct"), [direct.artifacts[0].path, logging.artifacts[0].path]);
  assert.deepEqual(jdbcProductManagedRuntimePaths(PHOENIX_JDBC_PRODUCT_PROFILE, [direct, logging, queryServer], "query-server"), [queryServer.artifacts[0].path]);
  assert.deepEqual(jdbcProductManagedRuntimePaths(PHOENIX_JDBC_PRODUCT_PROFILE, [direct], "direct"), []);
});

test("requires the JDBC plugin to be installed from Driver Manager", async () => {
  const config = phoenixConfig();
  const runtime = runtimeApi([], false);

  await assert.rejects(ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api), new RegExp(PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(runtime.listJdbcMavenBundles.mock.calls.length, 0);
  assert.equal(isJdbcProductRuntimeInstallError(PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_JDBC_PLUGIN_NOT_INSTALLED_ERROR), true);
});

test("does not download a missing Direct runtime while testing or connecting", async () => {
  const config = phoenixConfig();
  const runtime = runtimeApi();

  await assert.rejects(ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api), new RegExp(PHOENIX_DRIVER_NOT_INSTALLED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(runtime.listJdbcMavenBundles.mock.calls.length, 1);
  assert.equal(isJdbcProductRuntimeInstallError(PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_DRIVER_NOT_INSTALLED_ERROR), true);
});

test("reuses installed Direct bundles, removes stale managed PQS paths, and preserves configuration paths", async () => {
  const direct = mavenBundle(PHOENIX_DIRECT_MAVEN_COORDINATE);
  const logging = mavenBundle(PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE);
  const queryServer = mavenBundle(PHOENIX_QUERY_SERVER_MAVEN_COORDINATE);
  const config = phoenixConfig();
  config.jdbc_driver_paths = [queryServer.artifacts[0].path, "/etc/hbase", "/opt/custom-auth.jar"];
  const runtime = runtimeApi([direct, logging, queryServer]);

  const result = await ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api);

  assert.deepEqual(result?.paths, ["/etc/hbase", "/opt/custom-auth.jar", direct.artifacts[0].path, logging.artifacts[0].path]);
  assert.equal(result?.runtimeSelectionId, "phoenix:direct");
});

test("does not treat a deleted DBX-managed bundle path as a custom runtime", async () => {
  const config = phoenixConfig();
  config.jdbc_driver_paths = ["/plugins/jdbc/drivers/maven/org.apache.phoenix_phoenix-client-embedded-hbase-2.5_5.2.1/jars/phoenix-client-embedded-hbase-2.5-5.2.1.jar"];
  const runtime = runtimeApi();

  await assert.rejects(ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api), new RegExp(PHOENIX_DRIVER_NOT_INSTALLED_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("keeps a manually selected Phoenix runtime untouched", async () => {
  const config = phoenixConfig();
  config.jdbc_driver_paths = ["/opt/phoenix-client-embedded-hbase-2.6-5.3.2.jar", "/etc/hbase", "/opt/reload4j-1.2.26.jar"];
  const runtime = runtimeApi();

  const result = await ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api);

  assert.deepEqual(result?.paths, config.jdbc_driver_paths);
  assert.equal(result?.runtimeSelectionId, undefined);
});

test("selects only the standalone PQS client for Query Server mode", async () => {
  const config = phoenixConfig("query-server");
  const queryServer = mavenBundle(PHOENIX_QUERY_SERVER_MAVEN_COORDINATE);
  const runtime = runtimeApi([queryServer]);

  const result = await ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api);

  assert.deepEqual(result?.paths, ["/drivers/phoenix-queryserver-client-6.0.0.jar"]);
  assert.equal(result?.runtimeSelectionId, "phoenix:query-server");
});

test("does not provision Phoenix runtimes for another JDBC profile", async () => {
  const config = phoenixConfig();
  config.driver_profile = "jdbc";
  const runtime = runtimeApi();

  assert.equal(await ensureJdbcProductRuntimeDrivers(PHOENIX_JDBC_PRODUCT_PROFILE, config, runtime.api), undefined);
  assert.equal(runtime.jdbcPluginStatus.mock.calls.length, 0);
  assert.equal(runtime.listJdbcMavenBundles.mock.calls.length, 0);
});

test("registers Apache Phoenix as a declarative JDBC picker profile with both modes", () => {
  const profileSource = readFileSync(path.resolve("apps/desktop/src/lib/database/phoenixConnection.ts"), "utf8");
  const registrySource = readFileSync(path.resolve("apps/desktop/src/lib/database/jdbcProductProfiles.ts"), "utf8");

  assert.match(profileSource, /id:\s*PHOENIX_DRIVER_PROFILE/);
  assert.match(profileSource, /match:\s*\{\s*dbType:\s*"jdbc",\s*driverProfile:\s*PHOENIX_DRIVER_PROFILE\s*\}/);
  assert.match(profileSource, /id:\s*"direct"/);
  assert.match(profileSource, /id:\s*"query-server"/);
  assert.match(registrySource, /JDBC_PRODUCT_PROFILES\s*=\s*\[PHOENIX_JDBC_PRODUCT_PROFILE\]/);
});
