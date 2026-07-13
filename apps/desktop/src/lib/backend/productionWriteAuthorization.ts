import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";

export interface ProductionWriteAuthorization {
  token: string;
  operation: string;
  requestDigest: string;
}

let activeAuthorization: ProductionWriteAuthorization | undefined;

/**
 * Carries one authorization only while the selected backend function starts its
 * HTTP request or Tauri invocation. Transport helpers capture the value before
 * returning their promise, so concurrent writes cannot share ambient state.
 */
export function withProductionWriteAuthorization<T>(authorization: ProductionWriteAuthorization | undefined, invokeMutation: () => Promise<T>): Promise<T> {
  const previous = activeAuthorization;
  activeAuthorization = authorization;
  try {
    return invokeMutation();
  } finally {
    activeAuthorization = previous;
  }
}

export function productionWriteAuthorizationHeaders(): Record<string, string> {
  if (!activeAuthorization) return {};
  return {
    "X-DBX-Production-Write-Token": activeAuthorization.token,
    "X-DBX-Production-Write-Operation": activeAuthorization.operation,
    "X-DBX-Production-Write-Digest": activeAuthorization.requestDigest,
  };
}

/** Invokes a Tauri command while attaching the authorization captured for this mutation. */
export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  const authorization = activeAuthorization;
  return tauriInvoke(command, authorization ? { ...args, productionWriteAuthorization: authorization } : args);
}

/** Creates a stable SHA-256 fingerprint for the exact frontend mutation arguments. */
export async function productionWriteRequestDigest(operation: string, args: readonly unknown[]): Promise<string> {
  const normalized = await normalizeForDigest([operation, ...args], new WeakSet<object>());
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function normalizeForDigest(value: unknown, seen: WeakSet<object>): Promise<unknown> {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "number" && !Number.isFinite(value)) return { $type: "number", value: String(value) };
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof ArrayBuffer) return digestBinary(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return digestBinary(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value)) {
    if (value.length > 1024 && value.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)) {
      return digestBinary(Uint8Array.from(value as number[]));
    }
    return Promise.all(value.map((item) => normalizeForDigest(item, seen)));
  }
  if (typeof value !== "object") return { $type: typeof value, value: String(value) };
  if (seen.has(value)) throw new Error("Production write arguments must not contain circular references");
  seen.add(value);
  try {
    const entries = await Promise.all(
      Object.keys(value)
        .sort()
        .map(async (key) => [key, await normalizeForDigest((value as Record<string, unknown>)[key], seen)] as const),
    );
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

async function digestBinary(bytes: Uint8Array): Promise<Record<string, string | number>> {
  // Web Crypto requires an ArrayBuffer-backed view; callers may provide a
  // SharedArrayBuffer-backed typed array, so copy the exact byte range first.
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { $type: "binary", byteLength: bytes.byteLength, sha256: hash };
}
