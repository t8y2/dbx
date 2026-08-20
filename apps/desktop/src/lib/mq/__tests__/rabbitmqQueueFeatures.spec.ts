import { describe, expect, it } from "vitest";
import { formatMqRate, rabbitMqArgumentText, rabbitMqArgumentsSummary, rabbitMqFeatureBadges, rabbitMqHasUnknownArguments, rabbitMqQueueType } from "@/lib/mq/rabbitmqQueueFeatures";
import type { TopicInfo } from "@/types/mq";

function topic(partial: Partial<TopicInfo>): TopicInfo {
  return { name: "q", shortName: "q", partitioned: false, persistent: true, ...partial };
}

describe("rabbitMqFeatureBadges", () => {
  it("maps durability flags and known x-arguments to compact badges", () => {
    const badges = rabbitMqFeatureBadges(
      topic({
        autoDelete: true,
        exclusive: true,
        arguments: {
          "x-queue-type": "quorum",
          "x-message-ttl": 60000,
          "x-dead-letter-exchange": "dlx",
        },
      }),
    );

    expect(badges.map((badge) => badge.label)).toEqual(["D", "AD", "EX", "TTL", "DLX"]);
    expect(badges.find((badge) => badge.label === "D")?.title).toBe("Durable");
    expect(badges.find((badge) => badge.label === "TTL")?.title).toBe("x-message-ttl: 60000");
  });

  it("keeps unknown x-arguments in an Args count badge with full details", () => {
    const badges = rabbitMqFeatureBadges(
      topic({
        arguments: { "x-message-ttl": 100, "x-new-feature": true, "x-other": { nested: [1, 2] } },
      }),
    );

    const argsBadge = badges.find((badge) => badge.key === "args");
    expect(argsBadge?.label).toBe("2A");
    expect(argsBadge?.title).toContain("x-new-feature: true");
    expect(argsBadge?.title).toContain('x-other: {"nested":[1,2]}');
  });

  it("returns no badges for a plain queue", () => {
    expect(rabbitMqFeatureBadges(topic({ persistent: false }))).toEqual([]);
  });

  it("preserves argument value types in tooltips", () => {
    expect(rabbitMqArgumentText(60000)).toBe("60000");
    expect(rabbitMqArgumentText(true)).toBe("true");
    expect(rabbitMqArgumentText(null)).toBe("null");
    expect(rabbitMqArgumentText({ nested: 1 })).toBe('{"nested":1}');
  });
});

describe("rabbitMqArgumentsSummary", () => {
  it("joins sorted key/value pairs", () => {
    const summary = rabbitMqArgumentsSummary(topic({ arguments: { "x-max-length": 10, "x-message-ttl": 5 } }));
    expect(summary).toBe("x-max-length: 10 · x-message-ttl: 5");
  });

  it("returns undefined without arguments", () => {
    expect(rabbitMqArgumentsSummary(topic({}))).toBeUndefined();
  });
});

describe("rabbitMqQueueType", () => {
  it("prefers the explicit type field", () => {
    expect(rabbitMqQueueType(topic({ queueType: "quorum", arguments: { "x-queue-type": "stream" } }))).toBe("quorum");
  });

  it("falls back to the x-queue-type argument for older brokers", () => {
    expect(rabbitMqQueueType(topic({ arguments: { "x-queue-type": "stream" } }))).toBe("stream");
  });

  it("never guesses classic when the type is unknown", () => {
    expect(rabbitMqQueueType(topic({}))).toBeUndefined();
  });
});

describe("formatMqRate", () => {
  it("renders a sampled rate with two decimals", () => {
    expect(formatMqRate(12.5)).toBe("12.50/s");
  });

  it("renders a genuine zero rate as zero, not as no-data", () => {
    expect(formatMqRate(0)).toBe("0.00/s");
  });

  it("renders missing data as a dash, never as a fabricated zero", () => {
    expect(formatMqRate(undefined)).toBe("-");
  });
});

describe("rabbitMqHasUnknownArguments", () => {
  it("flags unknown arguments", () => {
    expect(rabbitMqHasUnknownArguments(topic({ arguments: { "x-brand-new": 1 } }))).toBe(true);
    expect(rabbitMqHasUnknownArguments(topic({ arguments: { "x-message-ttl": 1 } }))).toBe(false);
  });
});
