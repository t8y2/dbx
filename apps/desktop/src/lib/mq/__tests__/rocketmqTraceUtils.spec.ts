import { describe, expect, it } from "vitest";
import { formatRocketMqTraceError, isRocketMqTraceTopicRouteMissingError } from "@/lib/mq/rocketmqTraceUtils";

describe("rocketmqTraceUtils", () => {
  it("detects RocketMQ trace topic route missing errors", () => {
    expect(isRocketMqTraceTopicRouteMissingError(new Error("Agent RPC error (-1): CODE: 17 DESC: The topic[RMQ_SYS_TRACE_TOPIC] not matched route info"))).toBe(true);
    expect(isRocketMqTraceTopicRouteMissingError(new Error("CODE: 208 DESC: no matched message"))).toBe(false);
  });

  it("returns a friendly hint for trace topic route missing errors", () => {
    const hint = "Enable traceTopicEnable on broker";
    expect(formatRocketMqTraceError(new Error("CODE: 17 DESC: No topic route info in name server for the topic: RMQ_SYS_TRACE_TOPIC"), hint)).toBe(hint);
  });
});
