import { describe, expect, it } from "vitest";
import { isSqlServerLegacyCompatibilityMode, requiresSqlServerLegacyCompatibilityComponent, setSqlServerLegacyCompatibilityMode } from "@/lib/connection/sqlServerLegacyCompatibility";
import type { ConnectionConfig } from "@/types/database";

function connectionConfig(urlParams?: string): ConnectionConfig {
  return {
    id: "sqlserver",
    name: "SQL Server",
    db_type: "sqlserver",
    driver_profile: "sqlserver",
    driver_label: "SQL Server",
    host: "127.0.0.1",
    port: 1433,
    username: "sa",
    password: "secret",
    database: "master",
    url_params: urlParams,
    ssl: false,
    ssh_enabled: false,
    read_only: false,
    one_time: false,
    transport_layers: [],
    agent_java_options: [],
  };
}

describe("SQL Server legacy compatibility", () => {
  it("treats existing disabled encryption params as legacy compatibility opt-in", () => {
    expect(isSqlServerLegacyCompatibilityMode("sqlserverEncryption=disabled")).toBe(true);
    expect(isSqlServerLegacyCompatibilityMode("applicationName=dbx;encrypt=false")).toBe(true);
    expect(isSqlServerLegacyCompatibilityMode("?Encrypt=0&applicationName=dbx")).toBe(true);
    expect(isSqlServerLegacyCompatibilityMode("encrypt=true")).toBe(false);
  });

  it("updates URL params without keeping conflicting encryption params", () => {
    expect(setSqlServerLegacyCompatibilityMode("applicationName=dbx;encrypt=true", true)).toBe("applicationName=dbx&sqlserverEncryption=disabled");
    expect(setSqlServerLegacyCompatibilityMode("applicationName=dbx;sqlserverEncryption=disabled", false)).toBe("applicationName=dbx");
  });

  it("requires the hidden component only for SQL Server legacy compatibility connections", () => {
    expect(requiresSqlServerLegacyCompatibilityComponent(connectionConfig("sqlserverEncryption=disabled"))).toBe(true);
    expect(requiresSqlServerLegacyCompatibilityComponent(connectionConfig("encrypt=true"))).toBe(false);
    expect(
      requiresSqlServerLegacyCompatibilityComponent({
        ...connectionConfig("sqlserverEncryption=disabled"),
        db_type: "mysql",
      }),
    ).toBe(false);
  });
});
