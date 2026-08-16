export const NATS_DEFAULT_SERVER_URL = "nats://127.0.0.1:4222";

export interface NatsConnectionTarget {
  serverUrl: string;
  host: string;
  port: number;
  tls: boolean;
}

/**
 * Keep credentials out of the connection URL. They are persisted through the
 * connection secret store and passed to the NATS agent as separate fields.
 */
export function natsConnectionTarget(value: string): NatsConnectionTarget {
  const serverUrl = value.trim();
  if (!serverUrl) throw new Error("NATS server URL is required");

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("NATS server URL is invalid");
  }

  if ((parsed.protocol !== "nats:" && parsed.protocol !== "tls:") || !parsed.hostname) {
    throw new Error("NATS server URL must use nats:// or tls:// and include a host");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("NATS server URL must not contain credentials, a path, query, or fragment");
  }

  return {
    serverUrl: `${parsed.protocol}//${parsed.host}`,
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 4222,
    tls: parsed.protocol === "tls:",
  };
}

export function natsServerUrlIsValid(value: string): boolean {
  try {
    natsConnectionTarget(value);
    return true;
  } catch {
    return false;
  }
}
