import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { connectionConfigFingerprint, databaseInfoCopyText, databaseInfoRows, isTauriCommandUnavailable, normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";

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

  it("fingerprints the complete submitted config without depending on object key order", () => {
    const original = config({ transport_layers: [{ id: "ssh", type: "ssh", host: "jump", port: 22, user: "root", password: "hop-secret" }] });
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as ConnectionConfig;
    expect(connectionConfigFingerprint(reordered)).toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, password: "changed" })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, name: "Renamed" })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint({ ...original, transport_layers: [{ ...original.transport_layers![0], host: "other-jump" }] })).not.toBe(connectionConfigFingerprint(original));
    expect(connectionConfigFingerprint(original, "")).not.toBe(connectionConfigFingerprint(original, original.name));
    expect(connectionConfigFingerprint({ ...original, database_info: { productName: "MySQL", productVersion: "8.4.0" } })).toBe(connectionConfigFingerprint(original));
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
