import { describe, expect, it } from "vitest";
import { DEFAULT_CONNECT_TIMEOUT_SECS, normalizeConnectTimeoutSecs } from "@/lib/connection/timeoutLimits";

describe("ConnectionDialog timeout controls", () => {
  it("restores the default when the connection timeout input is cleared", () => {
    expect(normalizeConnectTimeoutSecs("")).toBe(DEFAULT_CONNECT_TIMEOUT_SECS);
  });
});
