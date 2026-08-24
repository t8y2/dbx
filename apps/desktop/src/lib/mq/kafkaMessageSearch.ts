import type { PeekedMessage } from "@/types/mq";

function appendSearchValue(values: string[], value: unknown) {
  if (value == null || value === "") return;
  values.push(String(value));
}

export function normalizeKafkaMessageSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function buildKafkaMessageSearchText(message: PeekedMessage, formattedPublishTime?: string): string {
  const values: string[] = [];
  appendSearchValue(values, message.position);
  appendSearchValue(values, message.messageId);
  appendSearchValue(values, message.key);
  appendSearchValue(values, message.properties?.partition);
  appendSearchValue(values, message.publishTime);
  appendSearchValue(values, formattedPublishTime);
  for (const [key, value] of Object.entries(message.headers || {})) {
    appendSearchValue(values, key);
    appendSearchValue(values, value);
  }
  appendSearchValue(values, message.payloadText ?? message.payloadBase64);
  return values.join("\n").toLowerCase();
}

export function kafkaMessageSearchTextMatches(searchText: string, normalizedQuery: string): boolean {
  return normalizedQuery === "" || searchText.includes(normalizedQuery);
}
