import type { PeekedMessage } from "@/types/mq";

function peekedPropertyNumber(properties: Record<string, string>, key: string): number | undefined {
  const raw = properties[key]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface RocketMqDisplayMessage {
  messageId?: string;
  partition?: number;
  offset?: number;
  key?: string;
  tag?: string;
  timestamp?: number;
  payloadText?: string;
  payloadBase64?: string;
  headers?: Record<string, string>;
  topic?: string;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseMessageRow(value: unknown): RocketMqDisplayMessage | undefined {
  const body = objectRecord(value);
  if (!Object.keys(body).length) return undefined;
  const headers = objectRecord(body.headers);
  const headerMap: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    headerMap[key] = typeof val === "string" ? val : String(val ?? "");
  }
  return {
    topic: stringField(body.topic),
    messageId: stringField(body.messageId) ?? stringField(body.msgId),
    partition: numberField(body.partition) ?? numberField(body.queueId),
    offset: numberField(body.offset) ?? numberField(body.queueOffset),
    key: stringField(body.key) ?? stringField(body.keys),
    tag: stringField(body.tag) ?? stringField(body.tags),
    timestamp: numberField(body.timestamp) ?? numberField(body.storeTimestamp),
    payloadText: stringField(body.payloadText),
    payloadBase64: stringField(body.payloadBase64),
    headers: headerMap,
  };
}

/** Parse messages from mqViewMessage / mqQueryMessagesByKey / mqQueryMessagesByTopic / mqQueryMessageTrace responses. */
export function parseRocketMqMessagesFromResult(result: unknown): RocketMqDisplayMessage[] {
  const root = objectRecord(result);
  const single = root.message ?? root.msg;
  if (single) {
    const parsed = parseMessageRow(single);
    return parsed ? [parsed] : [];
  }
  const list = root.messages;
  if (!Array.isArray(list)) return [];
  return list.map(parseMessageRow).filter((item): item is RocketMqDisplayMessage => !!item);
}

export function rocketMqMessagePayload(message: RocketMqDisplayMessage): string {
  if (message.payloadText) return message.payloadText;
  if (message.payloadBase64) {
    try {
      return decodeURIComponent(escape(atob(message.payloadBase64)));
    } catch {
      return message.payloadBase64;
    }
  }
  return "";
}

export function formatRocketMqMessagePayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export function rocketMqDisplayFromPeeked(msg: PeekedMessage, topic?: string): RocketMqDisplayMessage {
  const tagFromProps = msg.properties?.tag?.trim();
  const tagFromHeaders = msg.headers?.TAGS?.trim();
  return {
    messageId: msg.messageId,
    partition: peekedPropertyNumber(msg.properties, "partition"),
    offset: peekedPropertyNumber(msg.properties, "offset"),
    key: msg.key,
    tag: tagFromProps || tagFromHeaders || undefined,
    timestamp: msg.publishTime ? Number(msg.publishTime) : undefined,
    payloadText: msg.payloadText,
    payloadBase64: msg.payloadBase64,
    headers: msg.headers,
    topic,
  };
}

export function rocketMqMessageToPeeked(message: RocketMqDisplayMessage, position: number): PeekedMessage {
  const properties: Record<string, string> = {};
  if (message.partition != null) properties.partition = String(message.partition);
  if (message.offset != null) properties.offset = String(message.offset);
  if (message.tag) properties.tag = message.tag;
  return {
    position,
    messageId: message.messageId ?? (message.offset != null ? String(message.offset) : undefined),
    key: message.key,
    publishTime: message.timestamp != null ? String(message.timestamp) : undefined,
    eventTime: undefined,
    properties,
    headers: message.headers ?? {},
    payloadBase64: message.payloadBase64 ?? "",
    payloadText: message.payloadText,
  };
}

export function formatRocketMqTimestamp(value?: string | number): string {
  if (value == null || value === "") return "-";
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Date(numeric).toLocaleString();
}
