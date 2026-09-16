import { describe, expect, it } from "vitest";
import { consulSessionRenewDelayMs, parseConsulDurationMs } from "../sessionRenew";

describe("Consul Session renew timing", () => {
  it("parses compound Consul durations", () => {
    expect(parseConsulDurationMs("1m30s")).toBe(90_000);
    expect(parseConsulDurationMs("250ms")).toBe(250);
    expect(parseConsulDurationMs("0s")).toBe(0);
    expect(parseConsulDurationMs("not-a-duration")).toBeNull();
  });

  it("renews halfway through the TTL within safe timer bounds", () => {
    expect(consulSessionRenewDelayMs("10s")).toBe(5_000);
    expect(consulSessionRenewDelayMs("2m")).toBe(30_000);
    expect(consulSessionRenewDelayMs("250ms")).toBe(1_000);
  });
});
