import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PHOENIX_COMPATIBILITY_ARTIFACT_NAMES, PHOENIX_COMPATIBILITY_COORDINATE, PHOENIX_COMPATIBILITY_MANAGED_DRIVER, PHOENIX_COMPATIBILITY_RUNTIME_ID, PHOENIX_COMPATIBILITY_VERSION } from "@/lib/database/phoenixCompatibilityRuntime";
import { PHOENIX_JDBC_PRODUCT_PROFILE, PHOENIX_DIRECT_MAVEN_COORDINATE, PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, PHOENIX_QUERY_SERVER_MAVEN_COORDINATE } from "@/lib/database/phoenixConnection";
import { ensureRegisteredJdbcProductRuntimeDrivers } from "@/lib/database/jdbcProductProfiles";
import { jdbcProductConfiguredRuntime, jdbcProductManagedRuntimePaths, jdbcProductRuntimeOptions, selectJdbcProductRuntimePaths } from "@/lib/database/jdbcProductProfile";
import { installManagedJdbcDriver, importManagedJdbcCompatibilityRuntime, managedJdbcPluginReady, managedJdbcDriverRow, uninstallManagedJdbcDriver } from "@/lib/database/managedJdbcDriver";
import type { ConnectionConfig, JdbcMavenBundleInfo } from "@/types/database";

const profile = PHOENIX_JDBC_PRODUCT_PROFILE;
const plugin = { installed: true, compatible: true, capabilities: ["jdbc.external-classpath-isolation-v1"] };
function bundle(coordinate: string, names: readonly string[]): JdbcMavenBundleInfo {
  const id = coordinate.replace(/[^A-Za-z0-9.-]/g, "_");
  const path = `/plugins/jdbc/drivers/maven/${id}`;
  return { id, coordinate, scope: "runtime", repositories: [], installed_at: "", path, artifacts: names.map((file_name) => ({ group_id: "fixture", artifact_id: "fixture", version: "1", classifier: "", extension: "jar", file_name, path: `${path}/jars/${file_name}`, size: 1, sha256: "fixture" })) };
}
const compat = () => bundle(PHOENIX_COMPATIBILITY_COORDINATE, PHOENIX_COMPATIBILITY_ARTIFACT_NAMES);
const modern = () => [bundle(PHOENIX_DIRECT_MAVEN_COORDINATE, ["phoenix-client-embedded-hbase-2.5-5.2.1.jar"]), bundle(PHOENIX_DIRECT_LOGGING_MAVEN_COORDINATE, ["reload4j.jar"])];
function config(paths: string[] = []): ConnectionConfig {
  return { id: "test", name: "Phoenix", db_type: "jdbc", driver_profile: "phoenix", connection_string: "jdbc:phoenix:cluster:2181:/custom", jdbc_driver_class: "org.apache.phoenix.jdbc.PhoenixDriver", jdbc_driver_paths: paths, username: "tester" } as ConnectionConfig;
}
function runtimeApi(bundles: JdbcMavenBundleInfo[]) {
  return { jdbcPluginStatus: vi.fn(async () => plugin), listJdbcMavenBundles: vi.fn(async () => bundles) };
}

describe("Phoenix compatibility runtime", () => {
  it("rejects offline import with an old plugin before any API call", async () => {
    const old = { installed: true, compatible: true };
    const api = { installJdbcCompatibilityRuntimeFromFile: vi.fn(async () => []), installJdbcPlugin: vi.fn() };
    await expect(importManagedJdbcCompatibilityRuntime(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, old, "/compat.zip", api)).rejects.toThrow("external classpath isolation");
    expect(api.installJdbcCompatibilityRuntimeFromFile).not.toHaveBeenCalled();
    expect(api.installJdbcPlugin).not.toHaveBeenCalled();
    await importManagedJdbcCompatibilityRuntime(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, plugin, "/compat.zip", api);
    expect(api.installJdbcCompatibilityRuntimeFromFile).toHaveBeenCalledWith(PHOENIX_COMPATIBILITY_RUNTIME_ID, "/compat.zip");
    expect(api.installJdbcPlugin).not.toHaveBeenCalled();
  });
  it("requires isolation capability for row readiness and offline import without changing the old status", () => {
    const old = { installed: true, compatible: true };
    expect(managedJdbcPluginReady(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, old)).toBe(false);
    expect(managedJdbcDriverRow(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [compat()], old).installed).toBe(false);
    expect(old).toEqual({ installed: true, compatible: true });
    expect(managedJdbcPluginReady(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, { ...plugin, capabilities: [] })).toBe(false);
  });

  it("checks the updated plugin capability before requesting the compatibility package", async () => {
    const old = { installed: true, compatible: true, update_available: false, path: "/plugins/jdbc" };
    const api = { installJdbcPlugin: vi.fn(async () => old), installJdbcCompatibilityRuntime: vi.fn(async () => []), installJdbcDriverFromMaven: vi.fn(), listJdbcMavenBundles: vi.fn(async () => [compat()]), deleteJdbcMavenBundle: vi.fn() };
    await expect(installManagedJdbcDriver(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [], old, api)).rejects.toThrow("external classpath isolation");
    expect(api.installJdbcPlugin).toHaveBeenCalledOnce();
    expect(api.installJdbcCompatibilityRuntime).not.toHaveBeenCalled();
    expect(api.listJdbcMavenBundles).not.toHaveBeenCalled();
    api.installJdbcPlugin.mockResolvedValueOnce({ ...old, ...plugin });
    await installManagedJdbcDriver(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [], old, api);
    expect(api.installJdbcCompatibilityRuntime).toHaveBeenCalledOnce();
  });

  it("matches the backend release catalog identity and required artifact names", () => {
    const catalog = JSON.parse(readFileSync(resolve(process.cwd(), "crates/dbx-core/assets/jdbc-compatibility-runtimes.json"), "utf8"));
    const runtime = catalog.runtimes.find((entry: { id: string }) => entry.id === PHOENIX_COMPATIBILITY_RUNTIME_ID);
    expect(runtime).toMatchObject({ version: PHOENIX_COMPATIBILITY_VERSION, coordinate: PHOENIX_COMPATIBILITY_COORDINATE });
    expect(runtime.artifacts.map((artifact: { file_name: string }) => artifact.file_name).sort()).toEqual([...PHOENIX_COMPATIBILITY_ARTIFACT_NAMES].sort());
  });
  it("is an optional direct runtime and does not change modern or PQS defaults", async () => {
    expect(jdbcProductRuntimeOptions(profile, "direct").map((runtime) => runtime.id)).toEqual(["", PHOENIX_COMPATIBILITY_RUNTIME_ID]);
    expect(jdbcProductRuntimeOptions(profile, "query-server").map((runtime) => runtime.id)).toEqual([""]);
    const modernBundles = modern();
    const result = await ensureRegisteredJdbcProductRuntimeDrivers(config(), runtimeApi([...modernBundles, compat()]));
    expect(result?.paths).toEqual(modernBundles.flatMap((entry) => entry.artifacts.map((artifact) => artifact.path)));
    expect(result?.runtimeSelectionId).toBe("phoenix:direct");
    const pqs = bundle(PHOENIX_QUERY_SERVER_MAVEN_COORDINATE, ["phoenix-queryserver-client-6.0.0.jar"]);
    const thin = { ...config(), connection_string: "jdbc:phoenix:thin:url=http://cluster:8765", jdbc_driver_class: "org.apache.phoenix.queryserver.client.Driver" };
    const thinResult = await ensureRegisteredJdbcProductRuntimeDrivers(thin, runtimeApi([pqs, compat()]));
    expect(thinResult?.paths).toEqual([pqs.artifacts[0].path]);
  });

  it("does not migrate an existing manual old driver just because compatibility is installed", async () => {
    const paths = ["/manual/phoenix-5.0.0-HBase-2.0-client.jar", "/manual/zookeeper-3.4.10.jar", "/conf/hbase-site.xml", "/conf"];
    const original = config(paths);
    const result = await ensureRegisteredJdbcProductRuntimeDrivers(original, runtimeApi([...modern(), compat()]));
    expect(result?.paths).toEqual(paths);
    expect(result?.runtimeSelectionId).toBeUndefined();
    expect(original.connection_string).toBe("jdbc:phoenix:cluster:2181:/custom");
    expect(original.username).toBe("tester");
  });

  it("explicit selection replaces conflicting runtime jars while preserving custom resources", async () => {
    const installed = compat();
    const runtimePaths = installed.artifacts.map((artifact) => artifact.path);
    const selected = selectJdbcProductRuntimePaths(profile, "direct", ["/old/phoenix-5.0.0-HBase-2.0-client.jar", "C:\\old\\zookeeper-3.4.10.jar", "/conf/hbase-site.xml", "/conf", "/auth/custom.jar", ...modern().flatMap((entry) => entry.artifacts.map((artifact) => artifact.path))], runtimePaths);
    expect(selected).toEqual(["/conf/hbase-site.xml", "/conf", "/auth/custom.jar", ...runtimePaths]);
    // The persisted paths select the same version in a fresh connection; modern is not substituted.
    const reopened = config(selected);
    const result = await ensureRegisteredJdbcProductRuntimeDrivers(reopened, runtimeApi([...modern(), installed]));
    expect(result?.paths).toEqual(selected);
    expect(result?.runtimeSelectionId).toBe(`phoenix:direct:${PHOENIX_COMPATIBILITY_RUNTIME_ID}`);
    expect(reopened.connection_string).toBe("jdbc:phoenix:cluster:2181:/custom");
    expect(reopened.username).toBe("tester");
    expect(
      jdbcProductConfiguredRuntime(
        profile,
        "direct",
        selected.map((path) => path.replaceAll("/", "\\")),
      ).id,
    ).toBe(PHOENIX_COMPATIBILITY_RUNTIME_ID);
  });

  it("does not fall back to modern when a selected compatibility bundle is missing or partial", async () => {
    const installed = compat();
    const paths = installed.artifacts.map((artifact) => artifact.path);
    const partial = { ...installed, artifacts: installed.artifacts.slice(0, 1) };
    expect(managedJdbcDriverRow(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [partial], plugin).installed).toBe(false);
    expect(jdbcProductManagedRuntimePaths(profile, [partial], "direct", PHOENIX_COMPATIBILITY_RUNTIME_ID)).toEqual([]);
    for (const bundles of [modern(), [...modern(), partial]]) {
      await expect(ensureRegisteredJdbcProductRuntimeDrivers(config(paths), runtimeApi(bundles))).rejects.toMatchObject({ kind: "driver-missing", managedDriverId: PHOENIX_COMPATIBILITY_RUNTIME_ID });
    }
  });

  it("installs through the allowlisted compatibility API without Maven and propagates failed verification", async () => {
    const installed = compat();
    const api = { installJdbcPlugin: vi.fn(), installJdbcCompatibilityRuntime: vi.fn(async () => []), installJdbcDriverFromMaven: vi.fn(), listJdbcMavenBundles: vi.fn(async () => [installed]), deleteJdbcMavenBundle: vi.fn() };
    await installManagedJdbcDriver(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [], plugin, api);
    expect(api.installJdbcCompatibilityRuntime).toHaveBeenCalledWith(PHOENIX_COMPATIBILITY_RUNTIME_ID);
    expect(api.installJdbcPlugin).not.toHaveBeenCalled();
    expect(api.installJdbcDriverFromMaven).not.toHaveBeenCalled();
    expect(managedJdbcDriverRow(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [installed], plugin).installed).toBe(true);
    api.installJdbcCompatibilityRuntime.mockRejectedValueOnce(new Error("checksum mismatch"));
    await expect(installManagedJdbcDriver(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [], plugin, api)).rejects.toThrow("checksum mismatch");
    expect(api.listJdbcMavenBundles).toHaveBeenCalledTimes(1);
  });

  it("uninstalls only compatibility, including a partial installation, while preserving modern", async () => {
    const installed = compat();
    const other = modern();
    const api = { installJdbcPlugin: vi.fn(), installJdbcDriverFromMaven: vi.fn(), listJdbcMavenBundles: vi.fn(async () => other), deleteJdbcMavenBundle: vi.fn(async () => []) };
    await uninstallManagedJdbcDriver(PHOENIX_COMPATIBILITY_MANAGED_DRIVER, [...other, { ...installed, artifacts: [] }], api);
    expect(api.deleteJdbcMavenBundle.mock.calls).toEqual([[installed.id]]);
  });
});
