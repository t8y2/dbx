import { describe, expect, it } from "vitest";
import { driverRuntimeProtocolLabel } from "./driverRuntimeDisplay";

describe("driverRuntimeProtocolLabel", () => {
  it("shows aggregated multi-session counts", () => {
    expect(driverRuntimeProtocolLabel({ protocol_mode: "multi_session", active_sessions: 4 })).toBe("Multi-session · 4 sessions");
  });

  it("labels legacy runtimes and hides unknown modes", () => {
    expect(driverRuntimeProtocolLabel({ protocol_mode: "legacy", active_sessions: null })).toBe("Legacy");
    expect(driverRuntimeProtocolLabel({ protocol_mode: null, active_sessions: null })).toBeNull();
  });
});
