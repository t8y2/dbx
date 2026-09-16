import { describe, expect, it } from "vitest";
import { PRESTOSQL_JDBC_DRIVER_COORDINATE, PRESTOSQL_MANAGED_JDBC_DRIVER, prestoSqlBuiltinDriverPaths } from "@/lib/database/prestoSqlBuiltinDriver";
import { managedJdbcDriverBundles, managedJdbcDriverRow } from "@/lib/database/managedJdbcDriver";
import type { JdbcMavenBundleInfo } from "@/types/database";

function bundle(coordinate: string, version = "350"): JdbcMavenBundleInfo {
  return {
    id: `bundle:${coordinate}`,
    coordinate,
    scope: "runtime",
    repositories: ["https://repo.maven.apache.org/maven2/"],
    installed_at: "2026-06-18T00:00:00Z",
    path: "drivers/jdbc",
    artifacts: [
      {
        group_id: "io.prestosql",
        artifact_id: "presto-jdbc",
        version,
        classifier: "",
        extension: "jar",
        file_name: `presto-jdbc-${version}.jar`,
        path: `drivers/jdbc/presto-jdbc-${version}.jar`,
        size: 12_345,
        sha256: "abc",
      },
    ],
  };
}

describe("prestoSqlBuiltinDriver", () => {
  it("adds an uninstalled PrestoSQL row when the Maven bundle is absent", () => {
    const row = managedJdbcDriverRow(PRESTOSQL_MANAGED_JDBC_DRIVER, []);

    expect(row.db_type).toBe("prestosql");
    expect(row.label).toBe("PrestoSQL");
    expect(row.version).toBe("350");
    expect(row.installed).toBe(false);
    expect(row.installed_version).toBeNull();
    expect(row.jre).toBe("21");
  });

  it("marks PrestoSQL installed when its Maven coordinate is present", () => {
    const installed = bundle(PRESTOSQL_JDBC_DRIVER_COORDINATE);
    const row = managedJdbcDriverRow(PRESTOSQL_MANAGED_JDBC_DRIVER, [bundle("com.mysql:mysql-connector-j:9.2.0"), installed], { installed: true, compatible: true });

    expect(managedJdbcDriverBundles(PRESTOSQL_MANAGED_JDBC_DRIVER, [installed])[0]?.id).toBe(installed.id);
    expect(prestoSqlBuiltinDriverPaths([installed])).toEqual(["drivers/jdbc/presto-jdbc-350.jar"]);
    expect(row.installed).toBe(true);
    expect(row.installed_version).toBe("350");
  });
});
