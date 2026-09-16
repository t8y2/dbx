export interface KafkaPartitionStatsRow {
  partition: number;
  beginOffset: number;
  endOffset: number;
  messageCount: number;
  leader: number;
  replicas: number[];
  isr: number[];
}

export function extractKafkaPartitionRows(raw: unknown): KafkaPartitionStatsRow[] {
  return arrayObjects(objectRecord(raw).partitionStats)
    .map((body) => ({
      partition: numberField(body.partition) ?? 0,
      beginOffset: numberField(body.beginOffset) ?? 0,
      endOffset: numberField(body.endOffset) ?? 0,
      messageCount: numberField(body.messageCount) ?? 0,
      leader: numberField(body.leader) ?? -1,
      replicas: numberArrayField(body.replicas),
      isr: numberArrayField(body.isr),
    }))
    .sort((left, right) => left.partition - right.partition);
}

export function isKafkaStatsPayload(raw: unknown): boolean {
  const root = objectRecord(raw);
  return Array.isArray(root.partitionStats) || (numberField(root.partitions) !== undefined && numberField(root.replicationFactor) !== undefined && numberField(root.totalMessages) !== undefined);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberArrayField(value: unknown): number[] {
  return Array.isArray(value) ? value.map(numberField).filter((item): item is number => item !== undefined) : [];
}
