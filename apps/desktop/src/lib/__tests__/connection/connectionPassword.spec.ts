import { describe, expect, it } from "vitest";
import { connectionNeedsPasswordPrompt, connectionUsesPasswordlessAuthentication } from "@/lib/connection/connectionPassword";
import type { ConnectionConfig } from "@/types/database";

function connection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "connection-1",
    name: "Connection",
    db_type: "impala",
    host: "127.0.0.1",
    port: 21050,
    username: "",
    password: "",
    save_password: false,
    ...overrides,
  } as ConnectionConfig;
}

describe("connection password prompting", () => {
  it("treats Impala's default and explicit NOSASL modes as passwordless", () => {
    expect(connectionUsesPasswordlessAuthentication(connection())).toBe(true);
    expect(connectionUsesPasswordlessAuthentication(connection({ url_params: "transportMode=binary;auth=noSasl" }))).toBe(true);
    expect(connectionNeedsPasswordPrompt(connection({ url_params: "AUTH=NOSASL&fetchSize=1000" }))).toBe(false);
  });

  it("still prompts for Impala authentication modes that can require credentials", () => {
    expect(connectionNeedsPasswordPrompt(connection({ url_params: "auth=LDAP" }))).toBe(true);
    expect(connectionNeedsPasswordPrompt(connection({ url_params: "principal=impala/_HOST@EXAMPLE.COM" }))).toBe(true);
    expect(connectionNeedsPasswordPrompt(connection({ url_params: "auth=noSasl;principal=impala/_HOST@EXAMPLE.COM" }))).toBe(true);
  });

  it("allows Kyuubi NONE and NOSASL connections to persist an empty password", () => {
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "kyuubi", port: 10009, url_params: "auth=NONE" }))).toBe(false);
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "kyuubi", port: 10009, url_params: "auth=NOSASL" }))).toBe(false);
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "kyuubi", port: 10009, url_params: "" }))).toBe(false);
  });

  it("prompts for Kyuubi authentication modes that require credentials", () => {
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "kyuubi", port: 10009, url_params: "auth=LDAP" }))).toBe(true);
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "kyuubi", port: 10009, url_params: "principal=hive/_HOST@EXAMPLE.COM" }))).toBe(true);
  });

  it("does not change password prompting for other database types", () => {
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "mysql", port: 3306, url_params: "auth=noSasl" }))).toBe(true);
    expect(connectionNeedsPasswordPrompt(connection({ db_type: "postgres", port: 5432, save_password: true }))).toBe(false);
  });
});
