import { describe, expect, it } from "vitest";
import { postgresLegacyTlsEnabled, postgresTlsModeForForm, setPostgresLegacyTlsEnabled } from "@/lib/connection/postgresTlsMode";

describe("postgresTlsModeForForm", () => {
  it("uses prefer when legacy connections have no explicit mode", () => {
    expect(postgresTlsModeForForm(undefined, false)).toBe("prefer");
  });

  it("keeps the legacy TLS toggle mapped to require", () => {
    expect(postgresTlsModeForForm(undefined, true)).toBe("require");
  });

  it("honors explicit modes and aliases", () => {
    expect(postgresTlsModeForForm("disable", false)).toBe("disable");
    expect(postgresTlsModeForForm("prefer", false)).toBe("prefer");
    expect(postgresTlsModeForForm("verify_identity", false)).toBe("verify-full");
  });
});

describe("PostgreSQL legacy TLS compatibility", () => {
  it("recognizes explicit enabled values", () => {
    expect(postgresLegacyTlsEnabled("sslmode=require&legacy_tls=true")).toBe(true);
    expect(postgresLegacyTlsEnabled("legacy_tls=1")).toBe(true);
    expect(postgresLegacyTlsEnabled("legacy_tls=false")).toBe(false);
  });

  it("preserves unrelated URL parameters when toggled", () => {
    const enabled = setPostgresLegacyTlsEnabled("sslmode=require&application_name=dbx", true);
    expect(enabled).toBe("sslmode=require&application_name=dbx&legacy_tls=true");
    expect(setPostgresLegacyTlsEnabled(enabled, false)).toBe("sslmode=require&application_name=dbx");
  });
});
