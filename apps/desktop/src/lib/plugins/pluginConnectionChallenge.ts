import type { PluginEvent } from "@/types/database";

export const PLUGIN_CONNECTION_CHALLENGE_EVENT = "connection/challenge";
export const PLUGIN_CONNECTION_CHALLENGE_RESOLVE_METHOD = "connection/challenge/resolve";

export interface PluginConnectionChallenge {
  pluginId: string;
  challengeId: string;
  operationId: string;
  connectionId?: string;
  kind: "host-key";
  title: string;
  message: string;
  host?: string;
  port?: number;
  keyType?: string;
  fingerprint: string;
}

export function parsePluginConnectionChallenge(event: PluginEvent, pluginId?: string, connectionId?: string): PluginConnectionChallenge | undefined {
  if ((pluginId && event.pluginId !== pluginId) || event.method !== PLUGIN_CONNECTION_CHALLENGE_EVENT || !isRecord(event.params)) return undefined;
  const params = event.params;
  const challengeId = safeToken(params.challengeId, 128);
  const operationId = safeToken(params.operationId, 128);
  const eventConnectionId = optionalText(params.connectionId, 128);
  const fingerprint = text(params.fingerprint, 512);
  if (!challengeId || !operationId || !fingerprint || params.kind !== "host-key") return undefined;
  if (connectionId && eventConnectionId && eventConnectionId !== connectionId) return undefined;
  const port = typeof params.port === "number" && Number.isInteger(params.port) && params.port >= 1 && params.port <= 65_535 ? params.port : undefined;
  return {
    pluginId: event.pluginId,
    challengeId,
    operationId,
    connectionId: eventConnectionId,
    kind: "host-key",
    title: optionalText(params.title, 160) || "Verify plugin connection",
    message: optionalText(params.message, 2_000) || "Confirm the server identity before credentials are sent.",
    host: optionalText(params.host, 255),
    port,
    keyType: optionalText(params.keyType, 128),
    fingerprint,
  };
}

export function pluginConnectionChallengeKey(challenge: PluginConnectionChallenge): string {
  return `${challenge.pluginId}\u0000${challenge.operationId}\u0000${challenge.challengeId}`;
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || !value || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : text(value, maxLength);
}

function safeToken(value: unknown, maxLength: number): string | undefined {
  const candidate = text(value, maxLength);
  return candidate && /^[A-Za-z0-9._:-]+$/.test(candidate) ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
