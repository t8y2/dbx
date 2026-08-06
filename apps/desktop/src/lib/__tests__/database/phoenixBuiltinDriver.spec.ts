import { describe, expect, it } from "vitest";
import { PHOENIX_JDBC_DRIVER_VERSION, PHOENIX_MANAGED_JDBC_DRIVER, PHOENIX_MANAGED_MAVEN_COORDINATES } from "@/lib/database/phoenixBuiltinDriver";
import { PHOENIX_MAVEN_REPOSITORY } from "@/lib/database/phoenixConnection";
import { managedJdbcDriverBundles, managedJdbcDriverRow, missingManagedJdbcDriverBundles } from "@/lib/database/managedJdbcDriver";
import type { JdbcMavenBundleInfo } from "@/types/database";

function bundle(coordinate: string, size = 100): JdbcMavenBundleInfo {
  const [groupId, artifactId, version] = coordinate.split(":");
  return {
    id: `bundle:${coordinate}`,
    coordinate,
    scope: "runtime",
    repositories: [PHOENIX_MAVEN_REPOSITORY],
    installed_at: "2026-08-05T00:00:00Z",
    path: "drivers/jdbc",
    artifacts: [
      {
        group_id: groupId,
        artifact_id: artifactId,
        version,
        classifier: "",
        extension: "jar",
        file_name: `${artifactId}-${version}.jar`,
        path: `drivers/jdbc/${artifactId}-${version}.jar`,
        size,
        sha256: coordinate,
      },
    ],
  };
}

describe("phoenixBuiltinDriver", () => {
  it("shows one uninstalled Apache Phoenix JDBC row when no managed bundle exists", () => {
    const row = managedJdbcDriverRow(PHOENIX_MANAGED_JDBC_DRIVER, []);

    expect(row.db_type).toBe("phoenix");
    expect(row.label).toBe("Apache Phoenix JDBC");
    expect(row.version).toBe(PHOENIX_JDBC_DRIVER_VERSION);
    expect(row.installed).toBe(false);
    expect(row.installed_version).toBeNull();
    expect(row.jre).toBe("21");
    expect(missingManagedJdbcDriverBundles(PHOENIX_MANAGED_JDBC_DRIVER, []).map(({ coordinate }) => coordinate)).toEqual(PHOENIX_MANAGED_MAVEN_COORDINATES);
  });

  it("stays uninstalled for a partial runtime and reports only missing coordinates", () => {
    const direct = bundle(PHOENIX_MANAGED_MAVEN_COORDINATES[0], 120);
    const row = managedJdbcDriverRow(PHOENIX_MANAGED_JDBC_DRIVER, [direct]);

    expect(row.installed).toBe(false);
    expect(row.size).toBe(120);
    expect(managedJdbcDriverBundles(PHOENIX_MANAGED_JDBC_DRIVER, [direct])).toEqual([direct]);
    expect(missingManagedJdbcDriverBundles(PHOENIX_MANAGED_JDBC_DRIVER, [direct]).map(({ coordinate }) => coordinate)).toEqual(PHOENIX_MANAGED_MAVEN_COORDINATES.slice(1));
  });

  it("is installed only when Direct, logging, and PQS bundles are all present", () => {
    const unrelated = bundle("com.mysql:mysql-connector-j:9.2.0", 999);
    const managed = PHOENIX_MANAGED_MAVEN_COORDINATES.map((coordinate, index) => bundle(coordinate, index + 1));
    const row = managedJdbcDriverRow(PHOENIX_MANAGED_JDBC_DRIVER, [unrelated, ...managed], { installed: true, compatible: true });

    expect(row.installed).toBe(true);
    expect(row.installed_version).toBe(PHOENIX_JDBC_DRIVER_VERSION);
    expect(row.size).toBe(6);
    expect(managedJdbcDriverBundles(PHOENIX_MANAGED_JDBC_DRIVER, [unrelated, ...managed])).toEqual(managed);
    expect(missingManagedJdbcDriverBundles(PHOENIX_MANAGED_JDBC_DRIVER, [unrelated, ...managed])).toEqual([]);
  });

  it("stays uninstalled when all bundles exist but the shared JDBC plugin is unavailable", () => {
    const managed = PHOENIX_MANAGED_MAVEN_COORDINATES.map((coordinate) => bundle(coordinate));

    expect(managedJdbcDriverRow(PHOENIX_MANAGED_JDBC_DRIVER, managed, { installed: false, compatible: true }).installed).toBe(false);
    expect(managedJdbcDriverRow(PHOENIX_MANAGED_JDBC_DRIVER, managed, { installed: true, compatible: false }).installed).toBe(false);
  });
});
