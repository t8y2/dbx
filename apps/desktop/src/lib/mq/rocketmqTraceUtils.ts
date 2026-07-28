import { formatError } from "@/lib/backend/errorUtils";

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
