import { describe, expect, it } from "vitest";
import { shouldAutoConfirmConnectionDeepLink, shouldAutoConfirmConnectionPrefill } from "@/lib/connection/connectionDeepLink";

describe("shouldAutoConfirmConnectionDeepLink", () => {
  it("confirms both kinds by default", () => {
    expect(shouldAutoConfirmConnectionDeepLink("create", "always")).toBe(false);
    expect(shouldAutoConfirmConnectionDeepLink("update", "always")).toBe(false);
  });

  it("only skips confirmation for the kind the mode names", () => {
    expect(shouldAutoConfirmConnectionDeepLink("create", "create")).toBe(true);
    expect(shouldAutoConfirmConnectionDeepLink("update", "create")).toBe(false);
    expect(shouldAutoConfirmConnectionDeepLink("create", "update")).toBe(false);
    expect(shouldAutoConfirmConnectionDeepLink("update", "update")).toBe(true);
  });

  it("skips confirmation for every link in all mode", () => {
    expect(shouldAutoConfirmConnectionDeepLink("create", "all")).toBe(true);
    expect(shouldAutoConfirmConnectionDeepLink("update", "all")).toBe(true);
  });
});

describe("shouldAutoConfirmConnectionPrefill", () => {
  it("follows the create rule for regular new connections", () => {
    expect(shouldAutoConfirmConnectionPrefill({}, "always")).toBe(false);
    expect(shouldAutoConfirmConnectionPrefill({}, "create")).toBe(true);
    expect(shouldAutoConfirmConnectionPrefill({}, "update")).toBe(false);
    expect(shouldAutoConfirmConnectionPrefill({}, "all")).toBe(true);
  });

  it("always auto-submits one-time connections, regardless of the mode", () => {
    // one_time 连接是临时预览，本来就不需要用户确认。
    for (const mode of ["always", "create", "update", "all"] as const) {
      expect(shouldAutoConfirmConnectionPrefill({ oneTime: true }, mode)).toBe(true);
    }
  });
});
