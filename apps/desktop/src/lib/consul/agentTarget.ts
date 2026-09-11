import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";

type AgentTargetConnection = {
  id?: string;
  read_only?: boolean;
  transport_layers?: Array<{ enabled?: boolean }>;
  external_config?: unknown;
};

function normalizeAddress(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  return value.includes(":") && /^[0-9a-f:]+$/i.test(value);
}

function isLoopback(value: string): boolean {
  const address = normalizeAddress(value);
  return address === "localhost" || address === "::1" || (isIpv4(address) && address.startsWith("127."));
}

export function consulAgentAddressesMatch(left: string, right: string): boolean {
  const a = normalizeAddress(left);
  const b = normalizeAddress(right);
  return a === b || (a === "localhost" && isLoopback(b)) || (b === "localhost" && isLoopback(a));
}

export type ConsulAgentWriteBlockedReason = "connectionUnavailable" | "readOnly" | "transport" | "targetRequired" | "identityUnavailable" | "nodeMismatch" | "directAddressRequired" | "addressMismatch" | "invalidAddress";

export function consulAgentWriteBlockedReason(connection: AgentTargetConnection | undefined, identityNode: string | undefined): ConsulAgentWriteBlockedReason | null {
  if (!connection) return "connectionUnavailable";
  if (connectionIsEffectivelyReadOnly(connection)) return "readOnly";
  if (connection.transport_layers?.some((layer) => layer.enabled !== false)) return "transport";
  const external = connection.external_config;
  if (!external || typeof external !== "object" || Array.isArray(external)) return "targetRequired";
  const config = external as Record<string, unknown>;
  const rawTarget = config.agentTarget || config.agent_target;
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) return "targetRequired";
  const target = rawTarget as Record<string, unknown>;
  const node = String(target.node || "").trim();
  const address = String(target.address || "").trim();
  if (!node || !address) return "targetRequired";
  const serverAddress = String(config.serverAddr || config.server_addr || "").trim();
  try {
    const host = normalizeAddress(new URL(serverAddress).hostname);
    if (host !== "localhost" && !isIpv4(host) && !isIpv6(host)) return "directAddressRequired";
    if (!consulAgentAddressesMatch(host, address)) return "addressMismatch";
  } catch {
    return "invalidAddress";
  }
  if (!identityNode) return "identityUnavailable";
  if (node !== identityNode) return "nodeMismatch";
  return null;
}

export function consulAgentWriteTargetSafe(connection: AgentTargetConnection | undefined, identityNode: string | undefined): boolean {
  return consulAgentWriteBlockedReason(connection, identityNode) === null;
}
