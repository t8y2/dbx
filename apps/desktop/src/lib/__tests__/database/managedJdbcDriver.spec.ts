import { describe, expect, it, vi } from "vitest";
import {
  createManagedJdbcDriverRegistry,
  installManagedJdbcDriver,
  managedJdbcDriverBundles,
  managedJdbcDriverPaths,
  managedJdbcDriverRow,
  missingManagedJdbcDriverBundles,
  uninstallManagedJdbcDriver,
  type ManagedJdbcDriverApi,
  type ManagedJdbcDriverDefinition,
} from "@/lib/database/managedJdbcDriver";
import type { JdbcDriverInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";

const definition: ManagedJdbcDriverDefinition = {
  id: "fixture",
  label: "Fixture JDBC",
  version: "1.0.0",
  jre: "21",
  bundles: [
    { coordinate: "com.example:fixture-core:1.0.0", repositories: ["https://repo.example.com/"] },
    { coordinate: "com.example:fixture-extra:1.0.0", repositories: ["https://repo.example.com/"] },
  ],
};

function bundle(coordinate: string, size = 10): JdbcMavenBundleInfo {
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
        size,
        sha256: coordinate,
      },
    ],
  };
}

function pluginStatus(installed = true): JdbcPluginStatus {
  return {
    installed,
    version: installed ? "1.0.0" : null,
    protocol_version: installed ? 1 : null,
    compatible: installed,
    latest_version: null,
    latest_protocol_version: null,
    update_available: false,
    path: "/plugins/jdbc",
  };
}

function api(overrides: Partial<ManagedJdbcDriverApi> = {}): ManagedJdbcDriverApi {
  return {
    installJdbcPlugin: vi.fn(async () => pluginStatus()),
    installJdbcDriverFromMaven: vi.fn(async () => [] as JdbcDriverInfo[]),
    listJdbcMavenBundles: vi.fn(async () => []),
    deleteJdbcMavenBundle: vi.fn(async () => [] as JdbcDriverInfo[]),
    ...overrides,
  };
}

describe("managedJdbcDriver", () => {
  it("rejects duplicate ids and ambiguous Maven bundle ownership", () => {
    expect(() => createManagedJdbcDriverRegistry([{ ...definition, id: "" }])).toThrow(/id must not be empty/);
    expect(() => createManagedJdbcDriverRegistry([definition, { ...definition }])).toThrow(/Duplicate managed JDBC driver id/);
    expect(() => createManagedJdbcDriverRegistry([definition, { ...definition, id: "fixture-copy" }])).toThrow(/is owned by both/);
  });

  it("derives exact bundle state, paths, size, and plugin-aware installation", () => {
    const core = bundle(definition.bundles[0].coordinate, 12);
    const extra = bundle(definition.bundles[1].coordinate, 18);
    const unrelated = bundle("com.example:unrelated:1.0.0", 999);

    expect(managedJdbcDriverBundles(definition, [unrelated, extra, core])).toEqual([core, extra]);
    expect(missingManagedJdbcDriverBundles(definition, [core])).toEqual([definition.bundles[1]]);
    expect(managedJdbcDriverPaths(definition, [core, extra])).toEqual([core.artifacts[0].path, extra.artifacts[0].path]);
    expect(managedJdbcDriverPaths(definition, [core])).toEqual([]);
    expect(managedJdbcDriverRow(definition, [core, extra], pluginStatus())).toMatchObject({ installed: true, size: 30, installed_version: "1.0.0" });
    expect(managedJdbcDriverRow(definition, [core, extra])).toMatchObject({ installed: false, size: 30, installed_version: null });
    expect(managedJdbcDriverRow(definition, [core, extra], pluginStatus(false))).toMatchObject({ installed: false, size: 30, installed_version: null });
  });

  it("ensures the plugin and installs only missing coordinates", async () => {
    const core = bundle(definition.bundles[0].coordinate);
    const extra = bundle(definition.bundles[1].coordinate);
    const installJdbcPlugin = vi.fn(async () => pluginStatus());
    const installJdbcDriverFromMaven = vi.fn(async () => [] as JdbcDriverInfo[]);
    const listJdbcMavenBundles = vi.fn(async () => [core, extra]);
    const runtimeApi = api({ installJdbcPlugin, installJdbcDriverFromMaven, listJdbcMavenBundles });

    const result = await installManagedJdbcDriver(definition, [core], pluginStatus(false), runtimeApi);

    expect(installJdbcPlugin).toHaveBeenCalledOnce();
    expect(installJdbcDriverFromMaven).toHaveBeenCalledOnce();
    expect(installJdbcDriverFromMaven).toHaveBeenCalledWith(definition.bundles[1].coordinate, ["https://repo.example.com/"]);
    expect(result.bundles).toEqual([core, extra]);
    expect(result.pluginStatus?.installed).toBe(true);
  });

  it("uninstalls only bundles owned by the selected definition", async () => {
    const core = bundle(definition.bundles[0].coordinate);
    const extra = bundle(definition.bundles[1].coordinate);
    const unrelated = bundle("com.example:unrelated:1.0.0");
    const deleteJdbcMavenBundle = vi.fn(async () => [] as JdbcDriverInfo[]);
    const listJdbcMavenBundles = vi.fn(async () => [unrelated]);
    const runtimeApi = api({ deleteJdbcMavenBundle, listJdbcMavenBundles });

    const result = await uninstallManagedJdbcDriver(definition, [unrelated, core, extra], runtimeApi);

    expect(deleteJdbcMavenBundle.mock.calls).toEqual([[core.id], [extra.id]]);
    expect(result.bundles).toEqual([unrelated]);
  });
});
