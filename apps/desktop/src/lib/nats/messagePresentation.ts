import type { NatsHeader, NatsMessage, NatsPublishRequest } from "@/types/nats";

export type NatsPayloadMode = "text" | "json" | "base64";

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

export function presentNatsMessage(message: NatsMessage): NatsMessagePresentation {
  if (message.payloadText === undefined) {
    return {
      payload: message.payloadBase64,
      mode: "base64",
      receivedAt: new Date(message.receivedAtMs).toISOString(),
      sizeLabel: `${message.sizeBytes} B`,
    };
  }
  try {
    return {
      payload: JSON.stringify(JSON.parse(message.payloadText), null, 2),
      mode: "json",
      receivedAt: new Date(message.receivedAtMs).toISOString(),
      sizeLabel: `${message.sizeBytes} B`,
    };
  } catch {
    return {
      payload: message.payloadText,
      mode: "text",
      receivedAt: new Date(message.receivedAtMs).toISOString(),
      sizeLabel: `${message.sizeBytes} B`,
    };
  }
}
