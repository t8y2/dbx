import type { PeekedMessage } from "@/types/mq";

export type KafkaMessageDisplayOrder = "newest" | "oldest";

function parsePublishTime(value?: string): number | null {
  if (value == null || value.trim() === "") return null;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortKafkaMessagesByPublishTime(messages: readonly PeekedMessage[], order: KafkaMessageDisplayOrder): PeekedMessage[] {
  return messages
    .map((message, index) => ({ message, index, timestamp: parsePublishTime(message.publishTime) }))
    .sort((left, right) => {
      if (left.timestamp == null && right.timestamp != null) return 1;
      if (left.timestamp != null && right.timestamp == null) return -1;
      if (left.timestamp != null && right.timestamp != null && left.timestamp !== right.timestamp) {
        return order === "newest" ? right.timestamp - left.timestamp : left.timestamp - right.timestamp;
      }
      return left.index - right.index;
    })
    .map(({ message }) => message);
}
