import { describe, expect, it, vi } from "vitest";
import { JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION, ensureJdbcxRuntimeDrivers, isJdbcxRuntimePath, jdbcxHighPrivilegeExtensionsEnabled, setJdbcxHighPrivilegeExtensionsEnabled } from "@/lib/database/jdbcxBuiltinDriver";
import type { ConnectionConfig, JdbcMavenBundleInfo } from "@/types/database";

function jdbcxConfig(): ConnectionConfig {
  return {
    id: "jdbcx-1",
    name: "JDBCX database",
    db_type: "jdbc",
    driver_profile: "jdbcx",
    driver_label: "JDBCX",
    host: "",
    port: 0,
    username: "root",
    password: "",
    connection_string: "jdbcx:prql:vendor://127.0.0.1:1234/test",
    jdbc_driver_paths: [],
  };
}

function runtimeApi(paths: string[], bundles: JdbcMavenBundleInfo[] = []) {
  return {
    listJdbcMavenBundles: async () => bundles,
    listJdbcDrivers: async () => paths.map((path) => ({ name: path.split("/").at(-1) ?? path, path, size: 1 })),
    jdbcPluginStatus: async () => ({ installed: true, compatible: true }),
    installJdbcPlugin: vi.fn(async () => undefined),
  };
}

describe("jdbcxBuiltinDriver", () => {
  it("requires an explicit opt-in for high-privilege JDBCX extensions", () => {
    const config = jdbcxConfig();

    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(false);
    setJdbcxHighPrivilegeExtensionsEnabled(config, true);
    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(true);
    setJdbcxHighPrivilegeExtensionsEnabled(config, false);
    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(false);
  });

  it("canonicalizes whitespace-padded legacy opt-ins across edit round trips", () => {
    const config = jdbcxConfig();
    config.agent_java_options = [" -Ddbx.jdbcx.allowHighPrivilegeExtensions=false ", "-Xmx512m", "\t-Ddbx.jdbcx.allowHighPrivilegeExtensions=true\t"];

    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(true);

    setJdbcxHighPrivilegeExtensionsEnabled(config, true);
    expect(config.agent_java_options).toEqual(["-Xmx512m", JDBCX_HIGH_PRIVILEGE_EXTENSIONS_JAVA_OPTION]);
    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(true);

    setJdbcxHighPrivilegeExtensionsEnabled(config, false);
    expect(config.agent_java_options).toEqual(["-Xmx512m"]);
    expect(jdbcxHighPrivilegeExtensionsEnabled(config)).toBe(false);
  });

  it("recognizes user-installed JDBCX runtime JARs", () => {
    expect(isJdbcxRuntimePath("/drivers/jdbcx-driver-0.8.0.jar")).toBe(true);
    expect(isJdbcxRuntimePath("C:\\drivers\\jdbcx-core-0.8.0.jar")).toBe(false);
    expect(isJdbcxRuntimePath("/drivers/postgresql-42.7.7.jar")).toBe(false);
  });

  it("uses the connection-selected JDBCX runtime without unrelated driver JARs", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/postgresql-42.7.7.jar", "/drivers/jdbcx-driver-0.8.0.jar"];
    const result = await ensureJdbcxRuntimeDrivers(config, runtimeApi(["/drivers/jdbcx-driver-0.8.0.jar", "/drivers/acme-proprietary-driver.jar"]));

    expect(result?.paths).toEqual(["/drivers/postgresql-42.7.7.jar", "/drivers/jdbcx-driver-0.8.0.jar"]);
    expect(config.jdbc_driver_paths).toEqual(result?.paths);
  });

  it("honors a connection-selected JDBCX runtime outside the driver store", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/opt/jdbc/mysql-connector.jar", "/opt/jdbc/jdbcx-driver-0.8.0.jar"];

    const result = await ensureJdbcxRuntimeDrivers(config, runtimeApi([]));

    expect(result?.runtimeSelectionId).toBe("manual:/opt/jdbc/jdbcx-driver-0.8.0.jar");
    expect(result?.paths).toEqual(config.jdbc_driver_paths);
  });

  it("adds the complete installed JDBCX Maven bundle to the selected vendor classpath", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/mysql-connector-j-9.2.0.jar", "/drivers/jdbcx-driver-0.8.0.jar"];
    const bundle: JdbcMavenBundleInfo = {
      id: "jdbcx-0.8.0",
      coordinate: "io.github.jdbcx:jdbcx-driver:0.8.0",
      scope: "runtime",
      repositories: ["https://repo.maven.apache.org/maven2/"],
      installed_at: "2026-07-15T00:00:00Z",
      path: "/drivers/jdbcx",
      artifacts: [
        {
          group_id: "io.github.jdbcx",
          artifact_id: "jdbcx-driver",
          version: "0.8.0",
          classifier: "",
          extension: "jar",
          file_name: "jdbcx-driver-0.8.0.jar",
          path: "/drivers/jdbcx-driver-0.8.0.jar",
          size: 1,
          sha256: "abc",
        },
      ],
    };

    const result = await ensureJdbcxRuntimeDrivers(config, runtimeApi([], [bundle]));

    expect(result?.paths).toEqual(["/drivers/mysql-connector-j-9.2.0.jar", "/drivers/jdbcx-driver-0.8.0.jar"]);
  });

  it("keeps only the JDBCX runtime bundle explicitly selected by the connection", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/mysql-connector-j-9.2.0.jar", "/drivers/jdbcx-0.9.0/jdbcx-driver-0.9.0.jar"];
    const bundle = (version: string): JdbcMavenBundleInfo => ({
      id: `jdbcx-${version}`,
      coordinate: `io.github.jdbcx:jdbcx-driver:${version}`,
      scope: "runtime",
      repositories: [],
      installed_at: "2026-07-15T00:00:00Z",
      path: `/drivers/jdbcx-${version}`,
      artifacts: [
        {
          group_id: "io.github.jdbcx",
          artifact_id: "jdbcx-driver",
          version,
          classifier: "",
          extension: "jar",
          file_name: `jdbcx-driver-${version}.jar`,
          path: `/drivers/jdbcx-${version}/jdbcx-driver-${version}.jar`,
          size: 1,
          sha256: version,
        },
        {
          group_id: "org.example",
          artifact_id: "runtime-dependency",
          version,
          classifier: "",
          extension: "jar",
          file_name: `runtime-dependency-${version}.jar`,
          path: `/drivers/jdbcx-${version}/runtime-dependency-${version}.jar`,
          size: 1,
          sha256: `dependency-${version}`,
        },
      ],
    });

    const result = await ensureJdbcxRuntimeDrivers(config, runtimeApi([], [bundle("0.8.0"), bundle("0.9.0")]));

    expect(result?.runtimeSelectionId).toBe("maven:jdbcx-0.9.0");
    expect(result?.paths).toEqual(["/drivers/mysql-connector-j-9.2.0.jar", "/drivers/jdbcx-0.9.0/jdbcx-driver-0.9.0.jar", "/drivers/jdbcx-0.9.0/runtime-dependency-0.9.0.jar"]);
    expect(result?.paths.some((path) => path.includes("0.8.0"))).toBe(false);
  });

  it("rejects ambiguous installed JDBCX runtimes until the connection selects one", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/mysql-connector-j-9.2.0.jar"];
    const bundles = ["0.8.0", "0.9.0"].map(
      (version): JdbcMavenBundleInfo => ({
        id: `jdbcx-${version}`,
        coordinate: `io.github.jdbcx:jdbcx-driver:${version}`,
        scope: "runtime",
        repositories: [],
        installed_at: "2026-07-15T00:00:00Z",
        path: `/drivers/jdbcx-${version}`,
        artifacts: [
          {
            group_id: "io.github.jdbcx",
            artifact_id: "jdbcx-driver",
            version,
            classifier: "",
            extension: "jar",
            file_name: `jdbcx-driver-${version}.jar`,
            path: `/drivers/jdbcx-${version}/jdbcx-driver-${version}.jar`,
            size: 1,
            sha256: version,
          },
        ],
      }),
    );

    await expect(ensureJdbcxRuntimeDrivers(config, runtimeApi([], bundles))).rejects.toThrow("Select exactly one JDBCX bundle/runtime");
  });

  it("requires an explicit connection selection when only one JDBCX runtime is installed", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/mysql-connector-j-9.2.0.jar"];

    await expect(ensureJdbcxRuntimeDrivers(config, runtimeApi(["/drivers/jdbcx-driver-0.8.0.jar"]))).rejects.toThrow("installed but not selected");
  });

  it("rejects connections that select more than one JDBCX runtime", async () => {
    const config = jdbcxConfig();
    config.jdbc_driver_paths = ["/drivers/jdbcx-driver-0.8.0.jar", "/drivers/jdbcx-driver-0.9.0.jar"];

    await expect(ensureJdbcxRuntimeDrivers(config, runtimeApi(config.jdbc_driver_paths))).rejects.toThrow("Keep exactly one JDBCX bundle/runtime");
  });

  it("asks the user to install JDBCX when its runtime is missing", async () => {
    await expect(ensureJdbcxRuntimeDrivers(jdbcxConfig(), runtimeApi(["/drivers/mysql-connector-j-9.2.0.jar"]))).rejects.toThrow("Install io.github.jdbcx:jdbcx-driver:<version> in Driver Store");
  });
});
