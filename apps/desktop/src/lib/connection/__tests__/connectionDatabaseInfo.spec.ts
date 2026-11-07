import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { connectionConfigFingerprint, databaseInfoCopyText, databaseInfoRows, isTauriCommandUnavailable, normalizeConnectionTestResult, supportsConnectionDatabaseInfo } from "@/lib/connection/connectionDatabaseInfo";

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Local H2",
    db_type: "h2",
    driver_label: "H2",
    host: "127.0.0.1",
    port: 9092,
    username: "sa",
    password: "secret",
    ...overrides,
  };
}

describe("connectionDatabaseInfo", () => {
  it.each(["pg", "oracle", "mysql", "sqlserver", "future_mode"])("preserves %s compatibility metadata across connection testing and persistence", (mode) => {
    const original = config({ db_type: "kingbase" });
    const result = normalizeConnectionTestResult({ message: "ok", databaseInfo: { compatibilityMode: ` ${mode} `, productVersion: "V009R001" } }, original);
    expect(result.databaseInfo?.compatibilityMode).toBe(mode);
    const stored = JSON.parse(JSON.stringify({ ...original, database_info: result.databaseInfo })) as ConnectionConfig;
    expect(stored.database_info?.compatibilityMode).toBe(mode);
    expect(connectionConfigFingerprint(stored)).toBe(connectionConfigFingerprint(original));
  });

  it("hides database information for connections without database metadata", () => {
    for (const dbType of ["dynamodb", "elasticsearch", "easysearch", "meilisearch", "solr", "qdrant", "weaviate", "chromadb", "etcd", "zookeeper", "nacos", "consul", "mq", "mqtt", "victoriametrics"] as const) {
      expect(supportsConnectionDatabaseInfo(dbType)).toBe(false);
    }
    for (const dbType of ["mysql", "redis", "mongodb", "milvus", "turso", "cloudflare-d1", "plugin"] as const) {
      expect(supportsConnectionDatabaseInfo(dbType)).toBe(true);
    }
  });

  it("normalizes structured and legacy responses with a configured product fallback", () => {
    expect(normalizeConnectionTestResult("Connection successful", config())).toEqual({
      message: "Connection successful",
      databaseInfo: { productName: "H2" },
    });
    expect(normalizeConnectionTestResult("Connection successful", config({ database: "app" })).databaseInfo).toMatchObject({
      productName: "H2",
      currentDatabase: "app",
    });
    expect(
      normalizeConnectionTestResult(
        {
          message: "Connection successful",
          databaseInfo: {
            productName: "  H2  ",
            productVersion: " 2.2.224 ",
            currentDatabase: " testdb ",
            serverCharset: " utf8mb4 ",
            driverName: " ",
            unquotedIdentifierCase: "UPPER",
          },
        },
        config(),
      ).databaseInfo,
    ).toEqual({
      productName: "H2",
      productVersion: "2.2.224",
      currentDatabase: "testdb",
      serverComment: undefined,
      serverCharset: "utf8mb4",
      serverCollation: undefined,
      unquotedIdentifierCase: "upper",
      quotedIdentifierCase: undefined,
      driverName: undefined,
      driverVersion: undefined,
      jdbcVersion: undefined,
    });
  });

  it("fingerprints connection-affecting config without depending on object key order", () => {
    const original = config({ transport_layers: [{ id: "ssh", type: "ssh", host: "jump", port: 22, user: "root", password: "hop-secret" }] });
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as ConnectionConfig;
    expect(connectionConfigFingerprint(reordered)).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, password: "changed" })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, name: "Renamed" })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, transport_layers: [{ ...original.transport_layers![0], host: "other-jump" }] })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint(original, "")).not.toBe(connectionConfigFingerprint(original, original.name));
    expect(connectionConfigFingerprint({ ...original, database_info: { productName: "MySQL", productVersion: "8.4.0" } })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, note: "Production reporting" })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, default_schema: "archive" })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, sidebar_auto_load_all_tables: true })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, show_database_links: false })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, show_native_jobs: false, show_user_admin: true })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, show_extensions: false })).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, jdbc_dialect: "oceanbase-oracle" })).toBe(connectionConfigFingerprint(original));
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("canonicalizes only %s native defaults and presentation fields", (engine) => {
    const original = config({ db_type: engine, driver_label: undefined, driver_profile: undefined, external_config: null });
    const edited = {
      ...original,
      external_config: undefined,
      show_extensions: false,
      color: "",
      production_badge_scope: "database" as const,
      driver_label: "Display label",
      driver_profile: engine,
      sysdba: false,
      jdbc_driver_paths: [],
      gbase_server: "",
      informix_server: "",
      ...(engine === "oracle" ? { oracle_connection_type: "service_name" } : {}),
    };
    expect(connectionConfigFingerprint(edited)).toBe(connectionConfigFingerprint(original));
    for (const driver_profile of ["oci", "oracle-legacy", "oracle-10g", "custom-driver"]) {
      expect(connectionConfigFingerprint({ ...edited, driver_profile })).not.toBe(connectionConfigFingerprint(original));
    }
    for (const change of [
      { host: "other.test" },
      { username: "other" },
      { password: "other" },
      { read_only: true },
      { is_production: true },
      { production_databases: ["other"] },
      { sysdba: true },
      { jdbc_driver_paths: ["driver.jar"] },
      { gbase_server: "nonempty" },
      { informix_server: "nonempty" },
      { oracle_connection_type: "sid" },
      { oracle_connection_type: "tns" },
    ]) {
      expect(connectionConfigFingerprint({ ...edited, ...change })).not.toBe(connectionConfigFingerprint(original));
    }
    expect(connectionConfigFingerprint({ ...edited, jdbc_driver_paths: ["a.jar", "b.jar"] })).not.toBe(connectionConfigFingerprint({ ...edited, jdbc_driver_paths: ["b.jar", "a.jar"] }));
    for (const external_config of [{}, { custom: true }, [], "custom"]) {
      expect(connectionConfigFingerprint({ ...edited, external_config })).not.toBe(connectionConfigFingerprint(original));
    }
    expect(connectionConfigFingerprint({ ...edited, external_config: { custom: true } })).not.toBe(connectionConfigFingerprint({ ...edited, external_config: { custom: false } }));
    for (const db_type of ["jdbc", "plugin"] as const) {
      const external = config({ db_type, driver_label: "Oracle" });
      expect(connectionConfigFingerprint({ ...external, driver_label: "PostgreSQL" })).not.toBe(connectionConfigFingerprint(external));
      expect(connectionConfigFingerprint({ ...external, driver_profile: db_type })).not.toBe(connectionConfigFingerprint(external));
      expect(connectionConfigFingerprint({ ...external, external_config: null })).not.toBe(connectionConfigFingerprint(external));
    }
  });

  it("formats only database metadata for rows and copied text", () => {
    const info = normalizeConnectionTestResult(
      {
        message: "ok",
        databaseInfo: { productName: "H2", currentDatabase: "app", driverName: "H2 JDBC Driver", jdbcVersion: "4.2" },
      },
      config(),
    ).databaseInfo!;
    const copy = databaseInfoCopyText(
      info,
      (field) => field,
      (value) => value,
    );

    expect(databaseInfoRows(info).map((row) => row.key)).toEqual(["productName", "currentDatabase", "driverName", "jdbcVersion"]);
    expect(copy).toContain("productName: H2");
    expect(copy).toContain("currentDatabase: app");
    expect(copy).not.toContain("127.0.0.1");
    expect(copy).not.toContain("secret");
    expect(copy).not.toContain("connection_string");
  });

  it("recognizes only explicit missing-command errors for Tauri fallback", () => {
    expect(isTauriCommandUnavailable("Command test_connection_with_info not found", "test_connection_with_info")).toBe(true);
    expect(isTauriCommandUnavailable("unknown command 'test_connection_with_info'", "test_connection_with_info")).toBe(true);
    expect(isTauriCommandUnavailable("Authentication failed", "test_connection_with_info")).toBe(false);
    expect(isTauriCommandUnavailable("Command test_connection not found", "test_connection_with_info")).toBe(false);
    expect(isTauriCommandUnavailable("Database not found while invoking command test_connection_with_info", "test_connection_with_info")).toBe(false);
  });
});
