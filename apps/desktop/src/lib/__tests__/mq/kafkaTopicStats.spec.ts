import { describe, expect, it } from "vitest";
import { extractKafkaPartitionRows, isKafkaStatsPayload } from "@/lib/mq/kafkaTopicStats";

describe("Kafka topic stats", () => {
  it("normalizes and sorts partition rows", () => {
    expect(
      extractKafkaPartitionRows({
        partitionStats: [{ partition: 2, beginOffset: 8, endOffset: 20, messageCount: 12, leader: 3, replicas: [3, 4], isr: [3] }, { partition: 0, beginOffset: 1, endOffset: 4, messageCount: 3 }, null],
      }),
    ).toEqual([
      { partition: 0, beginOffset: 1, endOffset: 4, messageCount: 3, leader: -1, replicas: [], isr: [] },
      { partition: 2, beginOffset: 8, endOffset: 20, messageCount: 12, leader: 3, replicas: [3, 4], isr: [3] },
    ]);
  });

  it("recognizes Kafka summaries and rejects unrelated payloads", () => {
    expect(isKafkaStatsPayload({ partitionStats: [] })).toBe(true);
    expect(isKafkaStatsPayload({ partitions: 2, replicationFactor: 1, totalMessages: 4 })).toBe(true);
    expect(isKafkaStatsPayload({ partitions: 2 })).toBe(false);
    expect(extractKafkaPartitionRows(undefined)).toEqual([]);
  });
});
