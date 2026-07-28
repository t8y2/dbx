import type { QueryResult } from "@/types/database";

const ARRAY_OVERHEAD_BYTES = 24;
const OBJECT_OVERHEAD_BYTES = 32;
const VALUE_SLOT_BYTES = 8;

function estimateValueBytes(value: unknown, seen: WeakSet<object>): number {
  if (value == null) return VALUE_SLOT_BYTES;
  if (typeof value === "string") return VALUE_SLOT_BYTES + value.length * 2;
  if (typeof value === "number" || typeof value === "bigint") return 16;
  if (typeof value === "boolean") return 8;
  if (value instanceof Uint8Array) return OBJECT_OVERHEAD_BYTES + value.byteLength;
  if (value instanceof ArrayBuffer) return OBJECT_OVERHEAD_BYTES + value.byteLength;
  if (value instanceof Date) return OBJECT_OVERHEAD_BYTES;
  if (typeof value !== "object") return VALUE_SLOT_BYTES;
  if (seen.has(value)) return VALUE_SLOT_BYTES;
  seen.add(value);
  if (Array.isArray(value)) {
    return ARRAY_OVERHEAD_BYTES + value.reduce((total, item) => total + estimateValueBytes(item, seen), 0);
  }
  return OBJECT_OVERHEAD_BYTES + Object.entries(value).reduce((total, [key, entry]) => total + key.length * 2 + estimateValueBytes(entry, seen), 0);
}

export function estimateQueryResultBytes(result: QueryResult | undefined): number {
  if (!result) return 0;
  return estimateValueBytes(result, new WeakSet<object>());
}

export function estimateQueryResultsBytes(result: QueryResult | undefined, results: QueryResult[] | undefined): number {
  if (results?.length) return results.reduce((total, item) => total + estimateQueryResultBytes(item), ARRAY_OVERHEAD_BYTES);
  return estimateQueryResultBytes(result);
}

export interface InactiveResultResidency {
  id: string;
  estimatedBytes: number;
  accessedAt: number;
}

export function selectInactiveResultEvictions(entries: InactiveResultResidency[], maxBytes: number, maxCount: number): string[] {
  const ordered = [...entries].sort((left, right) => left.accessedAt - right.accessedAt);
  let bytes = ordered.reduce((total, entry) => total + entry.estimatedBytes, 0);
  const evicted: string[] = [];
  while (ordered.length - evicted.length > maxCount || bytes > maxBytes) {
    const entry = ordered[evicted.length];
    if (!entry) break;
    evicted.push(entry.id);
    bytes -= entry.estimatedBytes;
  }
  return evicted;
}
