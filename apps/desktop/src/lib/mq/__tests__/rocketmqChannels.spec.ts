import { describe, expect, it } from "vitest";
import { resolveRocketMqChannels } from "../rocketmqChannels";

describe("RocketMQ channel states", () => {
  it("exposes optional management degradation independently of ready messaging", () => {
    expect(resolveRocketMqChannels({ channels: { messaging: { status: "ready" }, management: { status: "degraded", error: "NameServer unavailable" } } })).toEqual([
      { channel: "messaging", status: "ready", error: undefined },
      { channel: "management", status: "degraded", error: "NameServer unavailable" },
    ]);
  });
  it("does not infer channel health for legacy or malformed data", () => {
    expect(resolveRocketMqChannels(undefined)).toEqual([]);
    expect(resolveRocketMqChannels({ channels: { management: { status: "unexpected" } } })).toEqual([]);
  });
});
