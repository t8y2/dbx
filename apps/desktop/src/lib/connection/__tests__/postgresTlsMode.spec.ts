import { describe, expect, it } from "vitest";
import { postgresTlsModeForForm } from "@/lib/connection/postgresTlsMode";

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
