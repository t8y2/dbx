import type { ConnectionConfig } from "@/types/database";

export function hasEnabledTransportLayers(connection?: Pick<ConnectionConfig, "transport_layers"> | null): boolean {
  return !!connection?.transport_layers?.some((layer) => layer.enabled !== false);
}
