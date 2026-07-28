import type { SubscriptionInfo } from "@/types/mq";

export type RocketMqConsumerGroupType = "NORMAL" | "FIFO" | "SYSTEM";

export const ROCKETMQ_CONSUMER_GROUP_TYPES: readonly RocketMqConsumerGroupType[] = ["NORMAL", "FIFO", "SYSTEM"];

export const DEFAULT_ROCKETMQ_CONSUMER_GROUP_TYPE_FILTERS: Record<RocketMqConsumerGroupType, boolean> = {
  NORMAL: true,
  FIFO: true,
  SYSTEM: false,
};

export function resolveRocketMqConsumerGroupType(sub: Pick<SubscriptionInfo, "consumerGroupType" | "subType">): RocketMqConsumerGroupType {
  const raw = (sub.consumerGroupType ?? sub.subType)?.trim().toUpperCase();
  if (raw === "FIFO" || raw === "ORDER" || raw === "ORDERLY") return "FIFO";
  if (raw === "SYSTEM") return "SYSTEM";
  if (raw === "NORMAL") return "NORMAL";
  return "NORMAL";
}

export function matchesRocketMqConsumerGroupTypeFilters(sub: Pick<SubscriptionInfo, "consumerGroupType" | "subType">, filters: Record<RocketMqConsumerGroupType, boolean>): boolean {
  return filters[resolveRocketMqConsumerGroupType(sub)] === true;
}

export function resolveRocketMqConsumerGroupMessageModel(sub: Pick<SubscriptionInfo, "messageModel">): "CLUSTERING" | "BROADCASTING" {
  return sub.messageModel?.trim().toUpperCase() === "BROADCASTING" ? "BROADCASTING" : "CLUSTERING";
}
