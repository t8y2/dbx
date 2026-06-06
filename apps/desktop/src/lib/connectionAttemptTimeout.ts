import type { ConnectionConfig } from "@/types/database";

export const CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS = 2_000;
export const MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_SECS = 5;

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function connectionAttemptTimeoutMs(
  config: Pick<ConnectionConfig, "connect_timeout_secs" | "transport_layers"> &
    Partial<Pick<ConnectionConfig, "db_type">>,
): number {
  const timeouts = [positiveSeconds(config.connect_timeout_secs, DEFAULT_CONNECT_TIMEOUT_SECS)];
  for (const layer of config.transport_layers ?? []) {
    if (layer.type === "ssh") {
      timeouts.push(positiveSeconds(layer.connect_timeout_secs, DEFAULT_CONNECT_TIMEOUT_SECS));
    }
  }
  const fallbackBuffer = config.db_type === "mongodb" ? MONGO_LEGACY_FALLBACK_TIMEOUT_BUFFER_MS : 0;
  return Math.ceil(Math.max(...timeouts) * 1000 + CONNECTION_ATTEMPT_TIMEOUT_BUFFER_MS + fallbackBuffer);
}

export function connectionAttemptTimeoutMessage(timeoutMs: number): string {
  return `Connection attempt timed out after ${Math.ceil(timeoutMs / 1000)}s. Please check the network or VPN and try again.`;
}
