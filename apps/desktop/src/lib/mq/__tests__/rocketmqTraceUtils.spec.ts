import { describe, expect, it } from "vitest";
import { formatRocketMqTraceError, isParsedRocketMqTraceRecord, isRocketMqTraceTopicRouteMissingError, parseRocketMqTracePayload, splitRocketMqTraceKeys } from "@/lib/mq/rocketmqTraceUtils";

const SOH = "\u0001";
const STX = "\u0002";

function joinFields(...parts: string[]): string {
  return parts.join(SOH);
}

describe("rocketmqTraceUtils", () => {
  it("detects RocketMQ trace topic route missing errors", () => {
    expect(isRocketMqTraceTopicRouteMissingError(new Error("Agent RPC error (-1): CODE: 17 DESC: The topic[RMQ_SYS_TRACE_TOPIC] not matched route info"))).toBe(true);
    expect(isRocketMqTraceTopicRouteMissingError(new Error("CODE: 208 DESC: no matched message"))).toBe(false);
  });

  it("returns a friendly hint for trace topic route missing errors", () => {
    const hint = "Enable traceTopicEnable on broker";
    expect(formatRocketMqTraceError(new Error("CODE: 17 DESC: No topic route info in name server for the topic: RMQ_SYS_TRACE_TOPIC"), hint)).toBe(hint);
  });

  it("parses Pub records including optional clientHost", () => {
    const payload = joinFields(
      "Pub",
      "1785728122381",
      "DefaultRegion",
      "api-orch-server_producer",
      "SIGNATURE_OPERATE_LOG_TOPIC_DEV",
      "AC12021900073BCED0D20CC95A0D0197",
      "ADD_SIGNATURE_OPERATE_LOG_TAG",
      "AC12021900073BCED0D20CC95A0D0197 AC12021900073BCED0D20CC95BFF019F",
      "192.168.3.25:10911",
      "512",
      "4",
      "0",
      "AC12021900073BCED0D20CC95A0D0197",
      "true",
      "192.168.2.25",
    );

    const [record] = parseRocketMqTracePayload(payload);
    expect(record.type).toBe("Pub");
    expect(record.timestamp).toBe(1785728122381);
    expect(record.success).toBe(true);
    expect(isParsedRocketMqTraceRecord(record)).toBe(true);
    expect(record.fields.find((field) => field.key === "group")?.value).toBe("api-orch-server_producer");
    expect(record.fields.find((field) => field.key === "topic")?.value).toBe("SIGNATURE_OPERATE_LOG_TOPIC_DEV");
    expect(record.fields.find((field) => field.key === "costTime")?.value).toBe("4 ms");
    expect(record.fields.find((field) => field.key === "clientHost")?.value).toBe("192.168.2.25");
  });

  it("parses SubBefore and SubAfter with version-tolerant lengths", () => {
    const subBefore = joinFields("SubBefore", "1785728123000", "DefaultRegion", "LISTING_AGREEMENT_SYNC_TOPIC_LISTING_FULL_AGREEMENT_CONSUMER_DEV", "req-1", "AC12021900073BCED0D20CC95BFF019F", "0", "null", "192.168.2.30");
    const subAfterOld = joinFields("SubAfter", "req-1", "AC12021900073BCED0D20CC95BFF019F", "12", "true", "k1", "0");
    const subAfterNew = joinFields("SubAfter", "req-2", "AC12021900073BCED0D20CC95BFF019F", "20", "false", "k2", "1", "1785728123120", "LISTING_AGREEMENT_SYNC_TOPIC_LISTING_FULL_AGREEMENT_CONSUMER_DEV");

    const records = parseRocketMqTracePayload(`${subBefore}${STX}${subAfterOld}${STX}${subAfterNew}`);
    expect(records).toHaveLength(3);
    expect(records[0].type).toBe("SubBefore");
    expect(records[0].fields.find((field) => field.key === "retryTimes")?.value).toBe("0");
    expect(records[0].fields.find((field) => field.key === "keys")?.value).toBe("-");
    expect(records[0].fields.find((field) => field.key === "clientHost")?.value).toBe("192.168.2.30");

    expect(records[1].type).toBe("SubAfter");
    expect(records[1].success).toBe(true);
    expect(records[1].timestamp).toBeUndefined();
    expect(records[1].fields.find((field) => field.key === "costTime")?.value).toBe("12 ms");

    expect(records[2].type).toBe("SubAfter");
    expect(records[2].success).toBe(false);
    expect(records[2].timestamp).toBe(1785728123120);
    expect(records[2].fields.find((field) => field.key === "group")?.value).toBe("LISTING_AGREEMENT_SYNC_TOPIC_LISTING_FULL_AGREEMENT_CONSUMER_DEV");
  });

  it("normalizes Type@ prefix and falls back for unknown payloads", () => {
    const withAt = `Pub@1785728122381${SOH}DefaultRegion${SOH}g${SOH}t${SOH}m${SOH}tag${SOH}k${SOH}host${SOH}1${SOH}2${SOH}0${SOH}off${SOH}true`;
    const [parsed] = parseRocketMqTracePayload(withAt);
    expect(parsed.type).toBe("Pub");
    expect(parsed.fields.find((field) => field.key === "group")?.value).toBe("g");

    const [unknown] = parseRocketMqTracePayload("not-a-trace-payload");
    expect(unknown.type).toBe("Unknown");
    expect(isParsedRocketMqTraceRecord(unknown)).toBe(false);
    expect(unknown.raw).toBe("not-a-trace-payload");
  });

  it("splits KEYS into chips", () => {
    expect(splitRocketMqTraceKeys("a b,c")).toEqual(["a", "b", "c"]);
    expect(splitRocketMqTraceKeys("null")).toEqual([]);
    expect(splitRocketMqTraceKeys("-")).toEqual([]);
  });
});
