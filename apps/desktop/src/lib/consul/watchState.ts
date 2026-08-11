import type { KvInt64 } from "@/lib/backend/tauri";
import type { ConsulWatchEvent } from "@/types/consul";

export interface ConsulWatchState {
  index: KvInt64 | null;
  connected: boolean;
  paused: boolean;
  generation: number;
}

export interface ConsulWatchIdentity {
  connectionId: string;
  operationId: string;
  generation: number;
}

export function isCurrentWatchEvent(identity: ConsulWatchIdentity, event: ConsulWatchEvent): boolean {
  return event.connectionId === identity.connectionId && event.operationId === identity.operationId && event.generation === identity.generation;
}

export function nextWatchIndex(current: KvInt64 | null, returned: KvInt64 | null): { index: KvInt64; reset: boolean } {
  const currentValue = parseIndex(current) || 1n;
  const returnedValue = parseIndex(returned);
  if (returnedValue === 0n || returnedValue < currentValue) return { index: "1" as KvInt64, reset: true };
  return { index: returned ?? ("1" as KvInt64), reset: false };
}

function parseIndex(index: KvInt64 | null): bigint {
  try {
    return BigInt(index ?? "0");
  } catch {
    return 0n;
  }
}
