import type { TransportLayerConfig } from "@/types/database";

type SqliteTransportLayer = Pick<TransportLayerConfig, "type" | "enabled">;

export type SqliteRemoteTransportError = "http_tunnel" | "final_ssh";

export function isSqliteRemoteTransportLayerType(type: TransportLayerConfig["type"]): boolean {
  return type === "ssh" || type === "proxy";
}

export function insertSqliteRemoteTransportLayer<T extends SqliteTransportLayer>(layers: readonly T[], layer: T): T[] {
  const next = [...layers];
  if (layer.type !== "proxy") {
    next.push(layer);
    return next;
  }
  let lastEnabledIndex = -1;
  for (let index = next.length - 1; index >= 0; index--) {
    if (next[index]?.enabled !== false) {
      lastEnabledIndex = index;
      break;
    }
  }
  if (lastEnabledIndex >= 0 && next[lastEnabledIndex]?.type === "ssh") {
    next.splice(lastEnabledIndex, 0, layer);
  } else {
    next.push(layer);
  }
  return next;
}

export function sqliteRemoteTransportError(layers: readonly SqliteTransportLayer[]): SqliteRemoteTransportError | null {
  const enabledLayers = layers.filter((layer) => layer.enabled !== false);
  if (enabledLayers.some((layer) => layer.type === "http_tunnel")) return "http_tunnel";
  if (enabledLayers.length > 0 && enabledLayers[enabledLayers.length - 1]?.type !== "ssh") return "final_ssh";
  return null;
}
