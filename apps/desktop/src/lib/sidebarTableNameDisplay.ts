export function normalizeSidebarHiddenTablePrefixes(value: unknown): string[] {
  const rawPrefixes = typeof value === "string" ? value.split(/\r?\n/) : Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  const seen = new Set<string>();
  const prefixes: string[] = [];

  for (const rawPrefix of rawPrefixes) {
    const prefix = rawPrefix.trim();
    if (!prefix || seen.has(prefix)) continue;
    seen.add(prefix);
    prefixes.push(prefix);
  }

  return prefixes.sort((a, b) => b.length - a.length);
}

export function sidebarDisplayTableName(name: string, prefixes: readonly string[]): string {
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((item) => name.startsWith(item) && name.length > item.length);
  return prefix ? `...${name.slice(prefix.length)}` : name;
}
