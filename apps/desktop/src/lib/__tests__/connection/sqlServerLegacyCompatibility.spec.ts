import { describe, expect, it } from "vitest";
import {
  isSqlServerNativeEncryptionDisabled,
  migrateSqlServerLegacyCompatibilityConfig,
  requiresSqlServerLegacyCompatibilityComponent,
  setSqlServerLegacyCompatibilityConfig,
  setSqlServerNativeEncryptionDisabled,
  sqlServerUsesLegacyCompatibility,
} from "@/lib/connection/sqlServerLegacyCompatibility";
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
  it("recognizes native encryption policy independently from the legacy driver profile", () => {
    expect(isSqlServerNativeEncryptionDisabled("sqlserverEncryption=disabled")).toBe(true);
    expect(isSqlServerNativeEncryptionDisabled("applicationName=dbx;encrypt=false")).toBe(true);
    expect(isSqlServerNativeEncryptionDisabled("?Encrypt=0&applicationName=dbx")).toBe(true);
    expect(isSqlServerNativeEncryptionDisabled("encrypt=true")).toBe(false);
  });

  it("updates native encryption params without changing the driver profile", () => {
    expect(setSqlServerNativeEncryptionDisabled("applicationName=dbx;encrypt=true", true)).toBe("applicationName=dbx&sqlserverEncryption=disabled");
    expect(setSqlServerNativeEncryptionDisabled("applicationName=dbx;sqlserverEncryption=disabled", false)).toBe("applicationName=dbx");
  });

  it("migrates historical disabled-encryption connections to the legacy driver profile", () => {
    const config = connectionConfig("sqlserverEncryption=disabled");
    migrateSqlServerLegacyCompatibilityConfig(config);

    expect(sqlServerUsesLegacyCompatibility(config)).toBe(true);
    expect(requiresSqlServerLegacyCompatibilityComponent(config)).toBe(true);
    expect(config.driver_label).toBe("SQL Server legacy compatibility component");
    expect(config.url_params).toBe("");
    expect(
      requiresSqlServerLegacyCompatibilityComponent({
        ...config,
        driver_profile: "sqlserver-legacy",
        db_type: "mysql",
      }),
    ).toBe(false);
  });

  it("preserves unrelated params while migrating the historical compatibility flag", () => {
    const config = connectionConfig("applicationName=dbx;sqlserverEncryption=off;encrypt=false");

    migrateSqlServerLegacyCompatibilityConfig(config);

    expect(config.driver_profile).toBe("sqlserver-legacy");
    expect(config.url_params).toBe("applicationName=dbx;encrypt=false");
  });

  it("preserves semicolons and special characters inside braced values during migration", () => {
    const config = connectionConfig("applicationName={DBX; Client};password=50%;sqlserverEncryption=disabled;encrypt=false");

    migrateSqlServerLegacyCompatibilityConfig(config);

    expect(config.driver_profile).toBe("sqlserver-legacy");
    expect(config.url_params).toBe("applicationName={DBX; Client};password=50%;encrypt=false");
  });

  it("keeps escaped closing braces from exposing separators inside braced values", () => {
    const config = connectionConfig("applicationName={DBX}}; Client};sqlserverEncryption=disabled;encrypt=false");

    migrateSqlServerLegacyCompatibilityConfig(config);

    expect(config.url_params).toBe("applicationName={DBX}}; Client};encrypt=false");
  });

  it("keeps generic JDBC encrypt=false on the native driver", () => {
    const config = connectionConfig("applicationName=dbx;encrypt=false");

    migrateSqlServerLegacyCompatibilityConfig(config);

    expect(config.driver_profile).toBe("sqlserver");
    expect(config.url_params).toBe("applicationName=dbx;encrypt=false");
  });

  it("treats a persisted legacy driver profile as compatibility mode", () => {
    const config = connectionConfig("");
    config.driver_profile = "sqlserver-legacy";

    expect(sqlServerUsesLegacyCompatibility(config)).toBe(true);
    expect(requiresSqlServerLegacyCompatibilityComponent(config)).toBe(true);
  });

  it("updates the explicit driver profile without rewriting native encryption params", () => {
    const config = connectionConfig("applicationName=dbx&encrypt=false");

    setSqlServerLegacyCompatibilityConfig(config, true);
    expect(config.driver_profile).toBe("sqlserver-legacy");
    expect(config.driver_label).toBe("SQL Server legacy compatibility component");
    expect(config.url_params).toBe("applicationName=dbx&encrypt=false");

    setSqlServerLegacyCompatibilityConfig(config, false);
    expect(config.driver_profile).toBe("sqlserver");
    expect(config.driver_label).toBe("SQL Server");
    expect(config.url_params).toBe("applicationName=dbx&encrypt=false");
  });
});
