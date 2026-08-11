const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;

export function parseConsulDurationMs(value: string): number | null {
  const input = value.trim();
  if (!input) return null;
  let total = 0;
  let offset = 0;
  for (const match of input.matchAll(DURATION_PART)) {
    if (match.index !== offset) return null;
    const amount = Number(match[1]);
    const multiplier = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
    total += amount * multiplier;
    offset += match[0].length;
  }
  return offset === input.length && Number.isFinite(total) && total >= 0 ? total : null;
}

export function consulSessionRenewDelayMs(ttl: string): number {
  const ttlMs = parseConsulDurationMs(ttl) ?? 20_000;
  return Math.max(1_000, Math.min(30_000, Math.floor(ttlMs / 2)));
}
