import { describe, expect, it } from "vitest";
import { mysqlCleartextPasswordAuthEnabled, setMysqlCleartextPasswordAuthEnabled } from "../mysqlConnectionOptions";

describe("mysqlConnectionOptions", () => {
  it("detects cleartext password auth aliases", () => {
    expect(mysqlCleartextPasswordAuthEnabled("allowCleartextPasswords=true")).toBe(true);
    expect(mysqlCleartextPasswordAuthEnabled("enable_cleartext_plugin=true")).toBe(true);
    expect(mysqlCleartextPasswordAuthEnabled("?AllowCleartextPasswords=TRUE")).toBe(true);
    expect(mysqlCleartextPasswordAuthEnabled("allowCleartextPasswords=false")).toBe(false);
  });

  it("enables the canonical cleartext password auth param and removes aliases", () => {
    expect(setMysqlCleartextPasswordAuthEnabled("allowCleartextPasswords=true&charset=utf8mb4", true)).toBe("charset=utf8mb4&enable_cleartext_plugin=true");
  });

  it("disables cleartext password auth params while preserving unrelated params", () => {
    expect(setMysqlCleartextPasswordAuthEnabled("allowCleartextPasswords=true&enable_cleartext_plugin=true&charset=utf8mb4&connect_timeout=10", false)).toBe("charset=utf8mb4&connect_timeout=10");
  });
});
