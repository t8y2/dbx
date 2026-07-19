import { describe, expect, it } from "vitest";
import { detectMqUiAuthKind, isMqAuthKindAllowedForSystem } from "@/lib/connection/mqAuth";

describe("mqAuth", () => {
  it("allows basic auth for RocketMQ", () => {
    expect(isMqAuthKindAllowedForSystem("rocketmq", "basic")).toBe(true);
    expect(isMqAuthKindAllowedForSystem("rocketmq", "kerberos")).toBe(false);
  });

  it("detects RocketMQ basic auth from config", () => {
    expect(
      detectMqUiAuthKind({
        systemKind: "rocketmq",
        authKind: "basic",
        saslMechanism: "",
        jaasConfig: "",
      }),
    ).toBe("basic");
  });
});
