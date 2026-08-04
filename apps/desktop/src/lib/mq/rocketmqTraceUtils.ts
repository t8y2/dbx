import { formatError } from "@/lib/backend/errorUtils";
import { formatRocketMqTimestamp } from "@/lib/mq/rocketmqMessageUtils";

/** RocketMQ CODE 17: trace topic has no route on NameServer (trace not enabled or wrong topic). */
export function isRocketMqTraceTopicRouteMissingError(error: unknown): boolean {
  const message = formatError(error);
  return /CODE:\s*17/i.test(message) && /not matched route info|No topic route info/i.test(message);
}

export function formatRocketMqTraceError(error: unknown, traceTopicMissingHint: string): string {
  if (isRocketMqTraceTopicRouteMissingError(error)) {
    return traceTopicMissingHint;
  }
  return formatError(error);
}

/** Content / field splitters from Apache RocketMQ TraceConstants. */
const CONTENT_SPLITTER = "\u0001";
const FIELD_SPLITTER = "\u0002";

export type RocketMqTraceType = "Pub" | "SubBefore" | "SubAfter" | "EndTransaction" | "Unknown";

/** Stable field keys mapped to mqTrace.field* i18n labels in the dialog. */
export type RocketMqTraceFieldKey = "regionId" | "group" | "topic" | "msgId" | "tags" | "keys" | "storeHost" | "clientHost" | "bodyLength" | "costTime" | "msgType" | "offsetMsgId" | "requestId" | "retryTimes" | "contextCode";

export interface RocketMqTraceField {
  key: RocketMqTraceFieldKey;
  value: string;
}

export interface RocketMqTraceRecord {
  type: RocketMqTraceType;
  timestamp?: number;
  /** Parsed success flag when present (Pub / SubAfter). */
  success?: boolean;
  fields: RocketMqTraceField[];
  raw: string;
}

function emptyDisplay(value: string | undefined): string {
  if (value == null) return "-";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return "-";
  return trimmed;
}

function parseTimestamp(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseSuccess(raw: string | undefined): boolean | undefined {
  if (raw == null || !raw.trim()) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function formatCostTime(raw: string | undefined): string {
  const value = emptyDisplay(raw);
  if (value === "-") return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return `${numeric} ms`;
}

function pushField(fields: RocketMqTraceField[], key: RocketMqTraceFieldKey, value: string | undefined): void {
  const display = key === "costTime" ? formatCostTime(value) : emptyDisplay(value);
  // Keep tags/keys/retry visible even when empty so Pub/Sub cards stay scannable.
  if (display === "-" && key !== "tags" && key !== "keys" && key !== "retryTimes") return;
  fields.push({ key, value: display });
}

/** Normalize rare "Type@fields" prefix into official Type\\u0001fields form. */
function normalizeTraceSegment(segment: string): string {
  return segment.replace(/^(Pub|SubBefore|SubAfter|EndTransaction)@/, `$1${CONTENT_SPLITTER}`);
}

function parsePub(parts: string[], raw: string): RocketMqTraceRecord {
  // Pub: type, ts, region, group, topic, msgId, tags, keys, storeHost, bodyLength, cost, msgType, offsetMsgId, success[, clientHost]
  const timestamp = parseTimestamp(parts[1]);
  const success = parseSuccess(parts[13]);
  const fields: RocketMqTraceField[] = [];
  pushField(fields, "regionId", parts[2]);
  pushField(fields, "group", parts[3]);
  pushField(fields, "topic", parts[4]);
  pushField(fields, "msgId", parts[5]);
  pushField(fields, "tags", parts[6]);
  pushField(fields, "keys", parts[7]);
  pushField(fields, "storeHost", parts[8]);
  pushField(fields, "bodyLength", parts[9]);
  pushField(fields, "costTime", parts[10]);
  pushField(fields, "msgType", parts[11]);
  pushField(fields, "offsetMsgId", parts[12]);
  if (parts.length >= 15) pushField(fields, "clientHost", parts[14]);
  return { type: "Pub", timestamp, success, fields, raw };
}

function parseSubBefore(parts: string[], raw: string): RocketMqTraceRecord {
  // SubBefore: type, ts, region, group, requestId, msgId, retryTimes, keys[, clientHost]
  // Some encoders also append storeHost before clientHost (length >= 9/10).
  const timestamp = parseTimestamp(parts[1]);
  const fields: RocketMqTraceField[] = [];
  pushField(fields, "regionId", parts[2]);
  pushField(fields, "group", parts[3]);
  pushField(fields, "requestId", parts[4]);
  pushField(fields, "msgId", parts[5]);
  pushField(fields, "retryTimes", parts[6]);
  pushField(fields, "keys", parts[7]);
  if (parts.length >= 10) {
    pushField(fields, "storeHost", parts[8]);
    pushField(fields, "clientHost", parts[9]);
  } else if (parts.length >= 9) {
    pushField(fields, "clientHost", parts[8]);
  }
  return { type: "SubBefore", timestamp, fields, raw };
}

function parseSubAfter(parts: string[], raw: string): RocketMqTraceRecord {
  // SubAfter: type, requestId, msgId, cost, success, keys, contextCode[, timestamp, groupName]
  const success = parseSuccess(parts[4]);
  const timestamp = parts.length >= 8 ? parseTimestamp(parts[7]) : undefined;
  const fields: RocketMqTraceField[] = [];
  pushField(fields, "requestId", parts[1]);
  pushField(fields, "msgId", parts[2]);
  pushField(fields, "costTime", parts[3]);
  pushField(fields, "keys", parts[5]);
  pushField(fields, "contextCode", parts[6]);
  if (parts.length >= 9) pushField(fields, "group", parts[8]);
  return { type: "SubAfter", timestamp, success, fields, raw };
}

function parseEndTransaction(parts: string[], raw: string): RocketMqTraceRecord {
  // EndTransaction: type, ts, region, group, topic, msgId, tags, keys, storeHost, msgType, clientHost, ...
  const timestamp = parseTimestamp(parts[1]);
  const fields: RocketMqTraceField[] = [];
  pushField(fields, "regionId", parts[2]);
  pushField(fields, "group", parts[3]);
  pushField(fields, "topic", parts[4]);
  pushField(fields, "msgId", parts[5]);
  pushField(fields, "tags", parts[6]);
  pushField(fields, "keys", parts[7]);
  pushField(fields, "storeHost", parts[8]);
  pushField(fields, "msgType", parts[9]);
  if (parts.length >= 11) pushField(fields, "clientHost", parts[10]);
  return { type: "EndTransaction", timestamp, fields, raw };
}

function parseTraceSegment(segment: string): RocketMqTraceRecord {
  const raw = segment;
  const normalized = normalizeTraceSegment(segment.trim());
  if (!normalized) {
    return { type: "Unknown", fields: [], raw };
  }
  const parts = normalized.split(CONTENT_SPLITTER);
  const type = parts[0]?.trim();
  if (type === "Pub" && parts.length >= 14) return parsePub(parts, raw);
  if (type === "SubBefore" && parts.length >= 8) return parseSubBefore(parts, raw);
  if (type === "SubAfter" && parts.length >= 7) return parseSubAfter(parts, raw);
  if (type === "EndTransaction" && parts.length >= 9) return parseEndTransaction(parts, raw);
  return { type: "Unknown", fields: [], raw };
}

/**
 * Parse RocketMQ trace message body into structured records.
 * Official format: Type\\u0001field...\\u0002Type\\u0001...
 */
export function parseRocketMqTracePayload(payload: string): RocketMqTraceRecord[] {
  if (!payload?.trim()) return [];
  const segments = payload
    .split(FIELD_SPLITTER)
    .map((part) => part.trim())
    .filter(Boolean);
  // Body may be a single record without trailing STX.
  const units = segments.length ? segments : [payload.trim()];
  return units.map(parseTraceSegment);
}

export function isParsedRocketMqTraceRecord(record: RocketMqTraceRecord): boolean {
  return record.type !== "Unknown" && record.fields.length > 0;
}

/** Split KEYS header / keys field into display chips. */
export function splitRocketMqTraceKeys(value: string | undefined): string[] {
  if (!value?.trim() || value.trim() === "-" || value.trim() === "null") return [];
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function rocketMqTraceRecordTimeLabel(record: RocketMqTraceRecord, fallbackTimestamp?: number): string {
  return formatRocketMqTimestamp(record.timestamp ?? fallbackTimestamp);
}
