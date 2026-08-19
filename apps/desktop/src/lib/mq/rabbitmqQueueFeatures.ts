import type { TopicInfo } from "@/types/mq";

/**
 * Compact RabbitMQ queue feature badge shown in the queues table.
 * `label` is the terse badge text (e.g. "TTL", "DLX"); `title` is the
 * full tooltip (argument name + value); `kind` drives the badge color.
 */
export interface RabbitMqFeatureBadge {
  key: string;
  kind: "feature" | "argument";
  label: string;
  title: string;
}

/** Arguments with dedicated compact badges; everything else folds into the "Args" count. */
const KNOWN_ARGUMENT_BADGES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "x-message-ttl", label: "TTL" },
  { key: "x-expires", label: "EXP" },
  { key: "x-max-length", label: "ML" },
  { key: "x-max-length-bytes", label: "MB" },
  { key: "x-max-priority", label: "MP" },
  { key: "x-dead-letter-exchange", label: "DLX" },
  { key: "x-dead-letter-routing-key", label: "DLK" },
  { key: "x-single-active-consumer", label: "SAC" },
  { key: "x-queue-mode", label: "QM" },
  { key: "x-queue-master-locator", label: "QML" },
];

const KNOWN_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  // Badged arguments.
  ...KNOWN_ARGUMENT_BADGES.map((entry) => entry.key),
  // Queue type is displayed in its own column, never as a feature badge.
  "x-queue-type",
]);

/** Render an argument value for tooltips without dropping its type. */
export function rabbitMqArgumentText(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Build the compact feature badges for a RabbitMQ queue row: durability flags
 * plus the interesting x-arguments. Unknown / future arguments are never
 * dropped — they fold into an "Args" count badge so new features keep
 * surfacing without hard-coding them into the UI.
 */
export function rabbitMqFeatureBadges(topic: Pick<TopicInfo, "persistent" | "autoDelete" | "exclusive" | "arguments">): RabbitMqFeatureBadge[] {
  const badges: RabbitMqFeatureBadge[] = [];
  if (topic.persistent) {
    badges.push({ key: "durable", kind: "feature", label: "D", title: "Durable" });
  }
  if (topic.autoDelete) {
    badges.push({ key: "autoDelete", kind: "feature", label: "AD", title: "Auto-delete" });
  }
  if (topic.exclusive) {
    badges.push({ key: "exclusive", kind: "feature", label: "EX", title: "Exclusive" });
  }
  const argumentsMap = topic.arguments ?? {};
  const extraKeys: string[] = [];
  for (const [key, value] of Object.entries(argumentsMap)) {
    const known = KNOWN_ARGUMENT_BADGES.find((entry) => entry.key === key);
    if (known) {
      badges.push({
        key: `arg:${key}`,
        kind: "argument",
        label: known.label,
        title: `${key}: ${rabbitMqArgumentText(value)}`,
      });
    } else if (!KNOWN_ARGUMENT_KEYS.has(key)) {
      extraKeys.push(key);
    }
  }
  if (extraKeys.length > 0) {
    badges.push({
      key: "args",
      kind: "argument",
      label: `${extraKeys.length}A`,
      title: extraKeys.map((key) => `${key}: ${rabbitMqArgumentText(argumentsMap[key])}`).join(" · "),
    });
  }
  return badges;
}

/**
 * Full arguments summary for the row tooltip, e.g.
 * "x-message-ttl: 60000 · x-max-length: 1000". Returns undefined when the
 * queue has no arguments at all.
 */
export function rabbitMqArgumentsSummary(topic: Pick<TopicInfo, "arguments">): string | undefined {
  const argumentsMap = topic.arguments;
  if (!argumentsMap || Object.keys(argumentsMap).length === 0) return undefined;
  return Object.entries(argumentsMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${rabbitMqArgumentText(value)}`)
    .join(" · ");
}

/** Whether any x-argument is unknown to the current UI — signals new features. */
export function rabbitMqHasUnknownArguments(topic: Pick<TopicInfo, "arguments">): boolean {
  const argumentsMap = topic.arguments ?? {};
  return Object.keys(argumentsMap).some((key) => !KNOWN_ARGUMENT_KEYS.has(key));
}

/**
 * RabbitMQ queue type for display. Prefers the management API's `type` field,
 * falls back to the x-queue-type argument, and never guesses "classic" when
 * neither is present.
 */
export function rabbitMqQueueType(topic: Pick<TopicInfo, "queueType" | "arguments">): string | undefined {
  if (topic.queueType) return topic.queueType;
  const argumentType = topic.arguments?.["x-queue-type"];
  return typeof argumentType === "string" && argumentType.trim() ? argumentType.trim() : undefined;
}

/**
 * Format a message rate for display. `undefined` (the management API sampled
 * no message_stats) renders as "-" — distinct from a genuine sampled rate of
 * zero, which renders as "0.00/s".
 */
export function formatMqRate(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(2)}/s`;
}

/**
 * Compact per-cell rate value (no unit) for the queues table; the column
 * header carries the unit. Missing data renders as "-".
 */
export function formatMqRateCompact(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}
