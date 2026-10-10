import { describe, expect, it } from "vitest";
import { userPreviewRequest, validOraclePassword, type OracleUserChange } from "@/lib/database/oracleUserAdmin";

describe("Oracle user credential boundary", () => {
  it("uses a field allowlist so a password cannot enter a preview request", () => {
    const form = { action: "password", name: 'Mixed."User', password: "private-password" } as OracleUserChange;
    const request = userPreviewRequest(form);
    expect(request).toEqual({ operation: "preview", change: { action: "password", name: 'Mixed."User' } });
    expect(JSON.stringify(request)).not.toContain("private-password");
  });
  it.each(["", 'double"quote', "line\nbreak", "nul\0character"])("rejects unsupported password syntax without including the value in an error", (value) => {
    expect(validOraclePassword(value)).toBe(false);
  });
  it("keeps supported quotes, punctuation and Unicode in a password", () => {
    expect(validOraclePassword("a'b;密码")).toBe(true);
  });
});
