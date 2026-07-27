import type { KvInt64 } from "@/lib/backend/api";

export type ParsedOptionalTtl = { ok: true; ttl: number | null } | { ok: false };

export function parseOptionalTtl(value: string | number | null | undefined): ParsedOptionalTtl {
  if (value == null) return { ok: true, ttl: null };

  const trimmed = String(value).trim();
  if (!trimmed) return { ok: true, ttl: null };
  if (!/^[1-9]\d*$/.test(trimmed)) return { ok: false };

  const ttl = Number(trimmed);
  if (!Number.isSafeInteger(ttl)) return { ok: false };
  return { ok: true, ttl };
}

export function parseKvLeaseId(value: string | number | null | undefined): KvInt64 | null {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  try {
    if (BigInt(normalized) > 9_223_372_036_854_775_807n) return null;
  } catch {
    return null;
  }
  return normalized;
}
