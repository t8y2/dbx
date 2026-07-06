import { describe, expect, it } from "vitest";
import { appendConnectionErrorHints } from "@/lib/connection/connectionErrorHints";
import type { ConnectionConfig } from "@/types/database";

function mysqlConfig(urlParams: string | undefined): ConnectionConfig {
  return {
    id: "mysql-test",
    name: "MySQL",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: undefined,
    url_params: urlParams,
    ssl: false,
  };
}

const t = (key: string) => (key === "connection.mysqlTlsConnectionFailureHint" ? "Set TLS Mode to Disabled." : key);

describe("appendConnectionErrorHints", () => {
  it("adds a MySQL TLS hint for non-disabled TLS failures", () => {
    const message = appendConnectionErrorHints(mysqlConfig("ssl-mode=preferred"), "MySQL connection failed: TLS handshake failed", t);

    expect(message).toContain("TLS handshake failed");
    expect(message).toContain("Set TLS Mode to Disabled.");
  });

  it("adds the TLS hint for camel-case MySQL sslMode params", () => {
    const message = appendConnectionErrorHints(mysqlConfig("sslMode=REQUIRED"), "MySQL connection failed: Driver error: `Client asked for SSL but server does not have this capability'", t);

    expect(message).toContain("server does not have this capability");
    expect(message).toContain("Set TLS Mode to Disabled.");
  });

  it("does not add the TLS hint when MySQL TLS is disabled", () => {
    const message = appendConnectionErrorHints(mysqlConfig("ssl-mode=disabled"), "MySQL connection failed: TLS handshake failed", t);

    expect(message).toBe("MySQL connection failed: TLS handshake failed");
  });

  it("does not add the TLS hint for non-TLS errors", () => {
    const message = appendConnectionErrorHints(mysqlConfig("ssl-mode=preferred"), "Access denied for user root", t);

    expect(message).toBe("Access denied for user root");
  });
});
