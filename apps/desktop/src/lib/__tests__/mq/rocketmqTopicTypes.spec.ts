import { describe, expect, it } from "vitest";
import { DEFAULT_ROCKETMQ_TOPIC_TYPE_FILTERS, buildRocketMqTraceTopicOptions, isProtectedRocketMqTopic, matchesRocketMqTypeFilters, resolveRocketMqMessageType } from "@/lib/mq/rocketmqTopicTypes";
import type { TopicInfo } from "@/types/mq";

function topic(partial: Partial<TopicInfo>): TopicInfo {
  return {
    name: partial.name ?? partial.shortName ?? "demo",
    shortName: partial.shortName ?? partial.name ?? "demo",
    partitioned: partial.partitioned ?? false,
    persistent: partial.persistent ?? true,
    ...partial,
  };
}

describe("rocketmqTopicTypes", () => {
  it("resolves dashboard-style message types", () => {
    expect(resolveRocketMqMessageType(topic({ messageType: "NORMAL" }))).toBe("NORMAL");
    expect(resolveRocketMqMessageType(topic({ messageType: "DELAY" }))).toBe("DELAY");
    expect(resolveRocketMqMessageType(topic({ messageType: "ORDER" }))).toBe("FIFO");
    expect(resolveRocketMqMessageType(topic({ messageType: "RETRY" }))).toBe("RETRY");
    expect(resolveRocketMqMessageType(topic({ internal: true }))).toBe("SYSTEM");
    expect(resolveRocketMqMessageType(topic({}))).toBe("UNSPECIFIED");
  });

  it("filters topics by selected message types", () => {
    const filters = { ...DEFAULT_ROCKETMQ_TOPIC_TYPE_FILTERS };
    expect(matchesRocketMqTypeFilters(topic({ messageType: "NORMAL" }), filters)).toBe(true);
    expect(matchesRocketMqTypeFilters(topic({ messageType: "SYSTEM" }), filters)).toBe(false);
    filters.SYSTEM = true;
    expect(matchesRocketMqTypeFilters(topic({ messageType: "SYSTEM" }), filters)).toBe(true);
  });

  it("marks retry, dlq and system topics as protected", () => {
    expect(isProtectedRocketMqTopic(topic({ messageType: "NORMAL" }))).toBe(false);
    expect(isProtectedRocketMqTopic(topic({ messageType: "RETRY" }))).toBe(true);
    expect(isProtectedRocketMqTopic(topic({ messageType: "DLQ" }))).toBe(true);
    expect(isProtectedRocketMqTopic(topic({ internal: true }))).toBe(true);
  });

  it("builds trace topic options with default and trace-related topics", () => {
    expect(buildRocketMqTraceTopicOptions([])).toEqual(["RMQ_SYS_TRACE_TOPIC"]);
    expect(buildRocketMqTraceTopicOptions([topic({ shortName: "RMQ_SYS_TRACE_TOPIC", internal: true }), topic({ shortName: "MyCustomTraceTopic", messageType: "NORMAL" }), topic({ shortName: "orders", messageType: "NORMAL" })])).toEqual(["RMQ_SYS_TRACE_TOPIC", "MyCustomTraceTopic"]);
  });
});
