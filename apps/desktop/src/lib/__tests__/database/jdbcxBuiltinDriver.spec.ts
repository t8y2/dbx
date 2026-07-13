import { describe, expect, it, vi } from "vitest";
import { ensureJdbcxRuntimeDrivers, isJdbcxRuntimePath } from "@/lib/database/jdbcxBuiltinDriver";
import type { ConnectionConfig } from "@/types/database";

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

function runtimeApi(paths: string[]) {
  return {
    listJdbcMavenBundles: async () => [],
    listJdbcDrivers: async () => paths.map((path) => ({ name: path.split("/").at(-1) ?? path, path, size: 1 })),
    jdbcPluginStatus: async () => ({ installed: true, compatible: true }),
    installJdbcPlugin: vi.fn(async () => undefined),
  };
}

describe("jdbcxBuiltinDriver", () => {
  it("recognizes user-installed JDBCX runtime JARs", () => {
    expect(isJdbcxRuntimePath("/drivers/jdbcx-driver-0.8.0.jar")).toBe(true);
    expect(isJdbcxRuntimePath("C:\\drivers\\jdbcx-core-0.8.0.jar")).toBe(true);
    expect(isJdbcxRuntimePath("/drivers/postgresql-42.7.7.jar")).toBe(false);
  });

  it("uses the user-installed JDBCX runtime and all delegate drivers", async () => {
    const config = jdbcxConfig();
    const result = await ensureJdbcxRuntimeDrivers(config, runtimeApi(["/drivers/jdbcx-driver-0.8.0.jar", "/drivers/postgresql-42.7.7.jar", "/drivers/acme-proprietary-driver.jar"]));

    expect(result?.paths).toEqual(["/drivers/jdbcx-driver-0.8.0.jar", "/drivers/postgresql-42.7.7.jar", "/drivers/acme-proprietary-driver.jar"]);
    expect(config.jdbc_driver_paths).toEqual(result?.paths);
  });

  it("asks the user to install JDBCX when its runtime is missing", async () => {
    await expect(ensureJdbcxRuntimeDrivers(jdbcxConfig(), runtimeApi(["/drivers/mysql-connector-j-9.2.0.jar"]))).rejects.toThrow("Install io.github.jdbcx:jdbcx-driver:<version> in Driver Store");
  });
});
