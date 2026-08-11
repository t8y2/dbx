import { describe, expect, it } from "vitest";
import { normalizeConsulSession } from "../sessionModel";

describe("Consul Session transport normalization", () => {
  it("accepts the legacy Checks response during a desktop backend hot restart", () => {
    const session = normalizeConsulSession({
      ID: "session-1",
      Name: "demo",
      Node: "node-1",
      LockDelay: 15_000_000_000,
      Behavior: "release",
      TTL: "",
      Checks: ["serfHealth"],
      CreateIndex: 12,
    });

    expect(session.NodeChecks).toEqual(["serfHealth"]);
    expect(session.ServiceChecks).toEqual([]);
    expect(session.ModifyIndex).toBe(12);
  });

  it("normalizes nullable Consul 2.0 check collections", () => {
    const session = normalizeConsulSession({
      ID: "session-2",
      NodeChecks: undefined,
      ServiceChecks: null as never,
    });

    expect(session.NodeChecks).toEqual([]);
    expect(session.ServiceChecks).toEqual([]);
  });
});
