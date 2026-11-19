import { describe, expect, it } from "vitest";
import { appendConnectionErrorHints, isSqliteMissingEncryptionPasswordFailure } from "@/lib/connection/connectionErrorHints";
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

function jdbcConfig(): ConnectionConfig {
  return {
    id: "jdbc-test",
    name: "TDengine JDBC",
    db_type: "jdbc",
    host: "127.0.0.1",
    port: 6041,
    username: "root",
    password: "",
    database: "dbx_tdengine_demo",
    ssl: false,
  };
}

const t = (key: string) => {
  if (key === "connection.mysqlTlsConnectionFailureHint") return "Set TLS Mode to Disabled.";
  if (key === "connection.mysqlUnsupportedTlsVersionHint") return "Use a TLS 1.2/1.3 server or compatible client. REQUIRE SSL rejects plaintext; SSH alone does not satisfy it.";
  if (key === "connection.mysqlDisabledTlsAccessDeniedHint") return "1045 may indicate REQUIRE SSL, invalid credentials, or grants. Check SHOW GRANTS from a working admin session.";
  if (key === "connection.mysqlUnsupportedCertVersionHint") return "Replace the certificate or use Required mode.";
  if (key === "connection.mysqlMissingPasswordHint") return "No database password was sent.";
  if (key === "connection.jdbcMissingRuntimeDependencyHint") return "Install from Maven or import every dependency JAR.";
  return key;
};

describe("appendConnectionErrorHints", () => {
  const legacyTlsError = "MySQL connection failed: Input/output error: Input/output error: peer is incompatible: ServerDoesNotSupportTls12Or13";
  const accessDenied = "MySQL connection failed: Server error: `ERROR 1045 (28000): Access denied for user 'icc'@'127.0.0.1' (using password: YES)'";

  it.each(["ssl-mode=preferred", "sslMode=REQUIRED", "ssl-mode=verify_ca", "ssl-mode=verify_identity"])("explains unsupported TLS versions without recommending disabling TLS (%s)", (params) => {
    const message = appendConnectionErrorHints(mysqlConfig(params), legacyTlsError, t);

    expect(message).toContain(legacyTlsError);
    expect(message).toContain(t("connection.mysqlUnsupportedTlsVersionHint"));
    expect(message).not.toContain("Set TLS Mode to Disabled.");
    expect(appendConnectionErrorHints(mysqlConfig(params), message, t)).toBe(message);
  });

  it("retains both attempts while explaining a failed Preferred fallback", () => {
    const error = `MySQL TLS attempt failed: ${legacyTlsError}\n\nMySQL plaintext fallback failed: ${accessDenied}`;
    const message = appendConnectionErrorHints({ ...mysqlConfig("ssl-mode=preferred"), password: "secret" }, error, t);

    expect(message).toContain(error);
    expect(message).toContain(t("connection.mysqlUnsupportedTlsVersionHint"));
    expect(message).not.toContain("Set TLS Mode to Disabled.");
  });

  it.each(["ssl-mode=disabled", "sslMode=DISABLE", "require_ssl=false", "useSSL=false", undefined])("explains Disabled access denial conditionally without replacing it (%s)", (params) => {
    const config = { ...mysqlConfig(params), password: "secret" };
    const message = appendConnectionErrorHints(config, accessDenied, t);

    expect(message).toContain(accessDenied);
    expect(message).toContain(t("connection.mysqlDisabledTlsAccessDeniedHint"));
    expect(appendConnectionErrorHints(config, message, t)).toBe(message);
  });

  it.each(["ssl-mode=preferred", "ssl-mode=required", "ssl-mode=verify_ca"])("does not claim plaintext was used for an ordinary TLS-mode access denial (%s)", (params) => {
    expect(appendConnectionErrorHints({ ...mysqlConfig(params), password: "secret" }, accessDenied, t)).toBe(accessDenied);
  });

  it("keeps missing-password priority and ignores unrelated errors", () => {
    const noPassword = accessDenied.replace("password: YES", "password: NO");
    expect(appendConnectionErrorHints(mysqlConfig("ssl-mode=disabled"), noPassword, t)).toBe("No database password was sent.");
    const unknownPassword = accessDenied.replace(" (using password: YES)", "");
    expect(appendConnectionErrorHints(mysqlConfig("ssl-mode=disabled"), unknownPassword, t)).toBe(unknownPassword);
    expect(appendConnectionErrorHints({ ...mysqlConfig("ssl-mode=disabled"), password: "secret" }, "ERROR 1044 (42000): Access denied for user root", t)).toBe("ERROR 1044 (42000): Access denied for user root");
    expect(appendConnectionErrorHints(jdbcConfig(), legacyTlsError, t)).toBe(legacyTlsError);
    expect(appendConnectionErrorHints(undefined, legacyTlsError, t)).toBe(legacyTlsError);
  });

  it("uses server-reported password use when the saved config omits a transient password", () => {
    const config = mysqlConfig("ssl-mode=disabled");
    const message = appendConnectionErrorHints(config, accessDenied, t);

    expect(message).toContain(accessDenied);
    expect(message).toContain(t("connection.mysqlDisabledTlsAccessDeniedHint"));
  });

  it("recognizes an encrypted SQLite file that was first opened without a password", () => {
    const config = { ...mysqlConfig(undefined), db_type: "sqlite" as const, host: "/tmp/encrypted.db", port: 0 };

    expect(isSqliteMissingEncryptionPasswordFailure(config, "Selected file is not a valid SQLite database file.")).toBe(true);
    expect(isSqliteMissingEncryptionPasswordFailure({ ...config, password: "wrong" }, "Selected file is not a valid SQLite database file.")).toBe(false);
    expect(isSqliteMissingEncryptionPasswordFailure(config, "SQLite connection failed: unable to open database file")).toBe(false);
  });

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

  it("recognizes Connector/J TLS aliases", () => {
    const message = appendConnectionErrorHints(mysqlConfig("useSSL=true&requireSSL=true&verifyServerCertificate=true"), "MySQL connection failed: TLS handshake failed", t);

    expect(message).toContain("Set TLS Mode to Disabled.");
  });

  it("treats verifyServerCertificate as verified TLS unless useSSL is disabled", () => {
    const verified = appendConnectionErrorHints(mysqlConfig("verifyServerCertificate=true"), "MySQL connection failed: TLS handshake failed", t);
    const disabled = appendConnectionErrorHints(mysqlConfig("useSSL=false&requireSSL=true&verifyServerCertificate=true"), "MySQL connection failed: TLS handshake failed", t);

    expect(verified).toContain("Set TLS Mode to Disabled.");
    expect(disabled).toBe("MySQL connection failed: TLS handshake failed");
  });

  it("uses the last duplicate Connector/J TLS parameter", () => {
    const enabled = appendConnectionErrorHints(mysqlConfig("useSSL=false&useSSL=true"), "MySQL connection failed: TLS handshake failed", t);
    const disabled = appendConnectionErrorHints(mysqlConfig("useSSL=true&useSSL=false"), "MySQL connection failed: TLS handshake failed", t);

    expect(enabled).toContain("Set TLS Mode to Disabled.");
    expect(disabled).toBe("MySQL connection failed: TLS handshake failed");
  });

  it("prefers native require_ssl over Connector/J TLS aliases", () => {
    const disabled = appendConnectionErrorHints(mysqlConfig("require_ssl=false&verifyServerCertificate=true"), "MySQL connection failed: TLS handshake failed", t);
    const required = appendConnectionErrorHints(mysqlConfig("require_ssl=true&useSSL=false"), "MySQL connection failed: TLS handshake failed", t);

    expect(disabled).toBe("MySQL connection failed: TLS handshake failed");
    expect(required).toContain("Set TLS Mode to Disabled.");
  });

  it("uses the last duplicate native require_ssl value", () => {
    const required = appendConnectionErrorHints(mysqlConfig("require_ssl=false&require_ssl=true"), "MySQL connection failed: TLS handshake failed", t);
    const disabled = appendConnectionErrorHints(mysqlConfig("require_ssl=true&require_ssl=false"), "MySQL connection failed: TLS handshake failed", t);

    expect(required).toContain("Set TLS Mode to Disabled.");
    expect(disabled).toBe("MySQL connection failed: TLS handshake failed");
  });

  it("uses a certificate-specific hint for unsupported certificate versions", () => {
    const error = "MySQL connection failed: invalid peer certificate: Other(OtherError(UnsupportedCertVersion))";
    const message = appendConnectionErrorHints(mysqlConfig("sslMode=VERIFY_CA"), error, t);

    expect(message).toContain("Replace the certificate or use Required mode.");
    expect(message).not.toContain("Set TLS Mode to Disabled.");
  });

  it("does not add the TLS hint when MySQL TLS is disabled", () => {
    const message = appendConnectionErrorHints(mysqlConfig("ssl-mode=disabled"), "MySQL connection failed: TLS handshake failed", t);

    expect(message).toBe("MySQL connection failed: TLS handshake failed");
  });

  it("does not add the TLS hint for non-TLS errors", () => {
    const message = appendConnectionErrorHints(mysqlConfig("ssl-mode=preferred"), "Access denied for user root", t);

    expect(message).toBe("Access denied for user root");
  });

  it("replaces a passwordless MySQL access-denied error with an actionable message", () => {
    const message = appendConnectionErrorHints(mysqlConfig(undefined), "MySQL connection failed: Server error: `ERROR 1045 (28000): Access denied for user 'root'@'192.168.100.133' (using password: NO)'", t);

    expect(message).toBe("No database password was sent.");
    expect(message).not.toContain("192.168.100.133");
  });

  it("keeps the native MySQL access-denied error when a password was supplied", () => {
    const config = { ...mysqlConfig(undefined), password: "wrong-password" };
    const error = "Access denied for user 'root'@'192.168.100.133' (using password: YES)";

    expect(appendConnectionErrorHints(config, error, t)).toBe(error);
  });

  it("adds an installation hint when a custom JDBC driver is missing a runtime dependency", () => {
    const error = "Missing Java class com.alibaba.fastjson.JSONException. Install the required runtime dependency.";
    const message = appendConnectionErrorHints(jdbcConfig(), error, t);

    expect(message).toContain(error);
    expect(message).toContain("Install from Maven or import every dependency JAR.");
  });

  it("does not add the JDBC dependency hint to non-JDBC connections", () => {
    const error = "Missing Java class com.alibaba.fastjson.JSONException. Install the required runtime dependency.";

    expect(appendConnectionErrorHints(mysqlConfig(undefined), error, t)).toBe(error);
  });
});
