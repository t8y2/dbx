import { decode as msgpackDecode } from "@msgpack/msgpack";

export interface RedisMsgpackDetail {
  formattedText: string;
  value: unknown;
}

export function decodeMsgpack(bytes: Uint8Array): RedisMsgpackDetail | null {
  if (bytes.length === 0) return null;
  try {
    const value = toJsonable(msgpackDecode(bytes));
    return {
      value,
      formattedText: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    };
  } catch {
    return null;
  }
}

function toJsonable(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value instanceof Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      return { $bytes: bytesToBase64(value) };
    }
  }
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
    return value.toString();
  }
  if (value instanceof Map) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of value) output[String(toJsonable(key, seen))] = toJsonable(item, seen);
    return output;
  }
  if (Array.isArray(value)) return value.map((item) => toJsonable(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return { $ref: true };
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = toJsonable(item, seen);
    return output;
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}
