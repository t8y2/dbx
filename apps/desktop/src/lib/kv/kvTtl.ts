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
