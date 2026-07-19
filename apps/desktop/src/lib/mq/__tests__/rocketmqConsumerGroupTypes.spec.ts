import { describe, expect, it } from "vitest";
import { matchesRocketMqConsumerGroupTypeFilters, resolveRocketMqConsumerGroupMessageModel, resolveRocketMqConsumerGroupType } from "@/lib/mq/rocketmqConsumerGroupTypes";

describe("rocketmqConsumerGroupTypes", () => {
  it("resolves group type from consumerGroupType or subType", () => {
    expect(resolveRocketMqConsumerGroupType({ consumerGroupType: "FIFO", subType: "NORMAL" })).toBe("FIFO");
    expect(resolveRocketMqConsumerGroupType({ subType: "SYSTEM" })).toBe("SYSTEM");
    expect(resolveRocketMqConsumerGroupType({ subType: "CONSUME_PASSIVELY ? CLUSTERING" })).toBe("NORMAL");
  });

  it("filters by dashboard group types", () => {
    const filters = { NORMAL: true, FIFO: true, SYSTEM: false };
    expect(matchesRocketMqConsumerGroupTypeFilters({ consumerGroupType: "NORMAL", subType: "NORMAL" }, filters)).toBe(true);
    expect(matchesRocketMqConsumerGroupTypeFilters({ consumerGroupType: "SYSTEM", subType: "SYSTEM" }, filters)).toBe(false);
  });

  it("resolves message model", () => {
    expect(resolveRocketMqConsumerGroupMessageModel({ messageModel: "BROADCASTING" })).toBe("BROADCASTING");
    expect(resolveRocketMqConsumerGroupMessageModel({})).toBe("CLUSTERING");
  });
});
