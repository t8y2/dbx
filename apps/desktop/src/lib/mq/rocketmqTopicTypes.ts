import type { RocketMqTopicMessageType, TopicInfo } from "@/types/mq";

export const ROCKETMQ_TOPIC_MESSAGE_TYPES: readonly RocketMqTopicMessageType[] = ["NORMAL", "DELAY", "FIFO", "TRANSACTION", "UNSPECIFIED", "RETRY", "DLQ", "SYSTEM"];

export const ROCKETMQ_CREATABLE_TOPIC_MESSAGE_TYPES: readonly RocketMqTopicMessageType[] = ["NORMAL", "DELAY", "FIFO", "TRANSACTION"];

export const DEFAULT_ROCKETMQ_TOPIC_TYPE_FILTERS: Record<RocketMqTopicMessageType, boolean> = {
  NORMAL: true,
  DELAY: true,
  FIFO: true,
  TRANSACTION: true,
  UNSPECIFIED: true,
  RETRY: false,
  DLQ: false,
  SYSTEM: false,
};

export function resolveRocketMqMessageType(topic: Pick<TopicInfo, "messageType" | "internal">): RocketMqTopicMessageType {
  const raw = topic.messageType?.trim().toUpperCase();
  if (raw === "ORDER") return "FIFO";
  if (raw && ROCKETMQ_TOPIC_MESSAGE_TYPES.includes(raw as RocketMqTopicMessageType)) {
    return raw as RocketMqTopicMessageType;
  }
  if (topic.internal) return "SYSTEM";
  return "UNSPECIFIED";
}

export function isRocketMqBusinessMessageType(type: RocketMqTopicMessageType): boolean {
  return type !== "SYSTEM" && type !== "RETRY" && type !== "DLQ";
}

export function isProtectedRocketMqTopic(topic: Pick<TopicInfo, "messageType" | "internal">): boolean {
  return !isRocketMqBusinessMessageType(resolveRocketMqMessageType(topic));
}

/** Default RocketMQ system trace topic; most clusters use this unless trace storage is customized. */
export const DEFAULT_ROCKETMQ_TRACE_TOPIC = "RMQ_SYS_TRACE_TOPIC";

/** Build selectable trace topic names from cluster metadata. */
export function buildRocketMqTraceTopicOptions(topics: Pick<TopicInfo, "shortName" | "messageType" | "internal">[]): string[] {
  const options = new Set<string>([DEFAULT_ROCKETMQ_TRACE_TOPIC]);
  for (const topic of topics) {
    const name = topic.shortName.trim();
    if (!name) continue;
    const type = resolveRocketMqMessageType(topic);
    if (type === "SYSTEM" || /trace/i.test(name)) {
      options.add(name);
    }
  }
  return [...options].sort((left, right) => {
    if (left === DEFAULT_ROCKETMQ_TRACE_TOPIC) return -1;
    if (right === DEFAULT_ROCKETMQ_TRACE_TOPIC) return 1;
    return left.localeCompare(right);
  });
}

export function matchesRocketMqTypeFilters(topic: Pick<TopicInfo, "messageType" | "internal">, filters: Record<RocketMqTopicMessageType, boolean>): boolean {
  return filters[resolveRocketMqMessageType(topic)] === true;
}
