import type { NatsHeader, NatsMessage, NatsPublishRequest } from "@/types/nats";

export type NatsPayloadMode = "text" | "json" | "base64";

/**
 * Payloads larger than this render collapsed by default so a single large
 * message cannot block Vue rendering of the live list (design §4.2).
 */
export const LARGE_PAYLOAD_BYTES = 16 * 1024;

/** A subject usable for publishing must not contain NATS wildcards (`*` or `>`). */
export function isWildcardSubject(subject: string): boolean {
  return /[*]|>/.test(subject);
}

/** Serialize headers for clipboard copy as one `Key: Value` line each. */
export function formatHeadersForCopy(headers: NatsHeader[]): string {
  return headers.map((header) => `${header.key}: ${header.value}`).join("\n");
}

export interface NatsMessagePresentation {
  payload: string;
  mode: NatsPayloadMode;
  receivedAt: string;
  sizeLabel: string;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function canonicalBase64(value: string): string {
  const base64 = value.trim();
  if (!base64) return "";
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Payload must be canonical Base64");
  }
  if (btoa(binary) !== base64) throw new Error("Payload must be canonical Base64");
  return base64;
}

export function parseNatsHeaders(value: string): NatsHeader[] {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("Each header must use Key: Value format");
      return { key: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
    });
}

export function buildNatsPublishRequest(subject: string, reply: string, headerText: string, payload: string, mode: NatsPayloadMode): NatsPublishRequest {
  let payloadBase64: string;
  if (mode === "base64") {
    payloadBase64 = canonicalBase64(payload);
  } else if (mode === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error("Payload must be valid JSON");
    }
    payloadBase64 = encodeUtf8Base64(JSON.stringify(parsed));
  } else {
    payloadBase64 = encodeUtf8Base64(payload);
  }
  const trimmedReply = reply.trim();
  return {
    subject: subject.trim(),
    ...(trimmedReply ? { reply: trimmedReply } : {}),
    headers: parseNatsHeaders(headerText),
    payloadBase64,
  };
}

/** How the viewer should decode a message payload (mainstream NATS GUIs offer this toggle). */
export type NatsViewMode = "auto" | NatsPayloadMode;

/**
 * Which decode modes make sense for a message: Base64 is always possible; JSON
 * and plain text are only offered when the payload is valid UTF-8 (has text).
 */
export function availableViewModes(message: NatsMessage): NatsViewMode[] {
  if (message.payloadText === undefined) return ["base64"];
  return ["auto", "json", "text", "base64"];
}

export function presentNatsMessage(message: NatsMessage, mode: NatsViewMode = "auto"): NatsMessagePresentation {
  const receivedAt = new Date(message.receivedAtMs).toISOString();
  const sizeLabel = `${message.sizeBytes} B`;

  // No decodable text (invalid UTF-8) or explicit base64 request → raw Base64.
  if (message.payloadText === undefined || mode === "base64") {
    return { payload: message.payloadBase64, mode: "base64", receivedAt, sizeLabel };
  }
  if (mode === "text") {
    return { payload: message.payloadText, mode: "text", receivedAt, sizeLabel };
  }
  // "auto" and "json" both try to pretty-print JSON; invalid JSON falls back to
  // the raw text without ever mutating the original payload.
  try {
    return { payload: JSON.stringify(JSON.parse(message.payloadText), null, 2), mode: "json", receivedAt, sizeLabel };
  } catch {
    return { payload: message.payloadText, mode: "text", receivedAt, sizeLabel };
  }
}
