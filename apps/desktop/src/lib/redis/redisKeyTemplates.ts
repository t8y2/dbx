/**
 * Helpers for configurable Redis key-search templates.
 * Connection-level templates override the global list when non-empty.
 */

export function normalizeRedisKeyTemplates(value: unknown): string[] {
  const rawLines = typeof value === "string" ? value.split(/\r?\n/) : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const seen = new Set<string>();
  const templates: string[] = [];
  for (const raw of rawLines) {
    const template = raw.trim();
    if (!template || seen.has(template)) continue;
    seen.add(template);
    templates.push(template);
  }
  return templates;
}

/** Empty connection list means inherit global (not “no templates”). */
export function resolveRedisKeyTemplates(connectionTemplates: string[] | undefined | null, globalTemplates: string[] | undefined | null): string[] {
  const fromConnection = normalizeRedisKeyTemplates(connectionTemplates);
  if (fromConnection.length > 0) return fromConnection;
  return normalizeRedisKeyTemplates(globalTemplates);
}

export function filterRedisKeyTemplates(templates: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...templates];
  return templates.filter((template) => template.toLowerCase().includes(q));
}

export function redisKeyTemplatesToTextarea(templates: readonly string[] | undefined | null): string {
  return normalizeRedisKeyTemplates(templates).join("\n");
}
