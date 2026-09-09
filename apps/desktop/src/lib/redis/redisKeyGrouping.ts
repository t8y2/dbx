/** Connection-persisted rules. Classification never changes Redis keys or SCAN. */
export interface RedisKeyGroupRule {
  id: string;
  name: string;
  enabled: boolean;
  includes: string[];
  excludes: string[];
}

export interface RedisKeyGrouping {
  version: 1;
  enabled: boolean;
  inner_view: "list" | "tree";
  rules: RedisKeyGroupRule[];
}

export function defaultRedisKeyGrouping(): RedisKeyGrouping {
  return { version: 1, enabled: false, inner_view: "list", rules: [] };
}

/** Reject invalid edits/imports rather than silently discarding saved rules. */
export function validateRedisKeyGrouping(value: unknown): RedisKeyGrouping {
  if (!value || typeof value !== "object") throw new Error("Invalid Redis grouping configuration");
  const config = value as Partial<RedisKeyGrouping>;
  if (config.version !== 1 || typeof config.enabled !== "boolean" || !["list", "tree"].includes(config.inner_view ?? "") || !Array.isArray(config.rules) || config.rules.length > 64) throw new Error("Invalid Redis grouping configuration");
  const ids = new Set<string>();
  const rules = config.rules.map((rule) => {
    if (!rule || typeof rule.id !== "string" || !rule.id || ids.has(rule.id) || typeof rule.name !== "string" || !rule.name.trim() || typeof rule.enabled !== "boolean") throw new Error("Invalid Redis grouping rule");
    ids.add(rule.id);
    for (const patterns of [rule.includes, rule.excludes]) {
      if (!Array.isArray(patterns) || patterns.length > 64 || patterns.some((pattern) => typeof pattern !== "string" || new TextEncoder().encode(pattern).length > 1024)) throw new Error("Invalid Redis grouping patterns");
    }
    if (!rule.includes.length && !rule.excludes.length) throw new Error("Empty Redis grouping rule");
    return { ...rule, name: rule.name.trim(), includes: [...rule.includes], excludes: [...rule.excludes] };
  });
  return { version: 1, enabled: config.enabled, inner_view: config.inner_view!, rules };
}

type Token = { kind: "star" } | { kind: "byte"; value: number } | { kind: "any" } | { kind: "class"; values: Set<number>; negate: boolean };

/** Redis MATCH is byte-oriented, including ? and bracket ranges. */
export function compileRedisGroupGlob(pattern: string): (bytes: Uint8Array) => boolean {
  const source = new TextEncoder().encode(pattern);
  const tokens: Token[] = [];
  for (let i = 0; i < source.length; i++) {
    const byte = source[i]!;
    if (byte === 42) {
      if (tokens[tokens.length - 1]?.kind !== "star") tokens.push({ kind: "star" });
    } else if (byte === 63) tokens.push({ kind: "any" });
    else if (byte === 92 && i + 1 < source.length) tokens.push({ kind: "byte", value: source[++i]! });
    else if (byte === 91) {
      const values = new Set<number>();
      let cursor = i + 1;
      const negate = source[cursor] === 94;
      if (negate) cursor++;
      while (cursor < source.length && source[cursor] !== 93) {
        if (source[cursor] === 92 && cursor + 1 < source.length) values.add(source[++cursor]!);
        else if (cursor + 2 < source.length && source[cursor + 1] === 45) {
          const a = source[cursor]!;
          const b = source[cursor + 2]!;
          for (let n = Math.min(a, b); n <= Math.max(a, b); n++) values.add(n);
          cursor += 2;
        } else values.add(source[cursor]!);
        cursor++;
      }
      tokens.push({ kind: "class", values, negate });
      i = cursor;
    } else tokens.push({ kind: "byte", value: byte });
  }
  // Greedy star retry is bounded O(pattern * key), not recursive/exponential.
  return (bytes) => {
    // Redis SCAN special-cases MATCH "*"; other nonempty patterns do not
    // match an empty key, even a run of stars such as "**".
    if (!bytes.length) return source.length === 0 || pattern === "*";
    let p = 0;
    let k = 0;
    let star = -1;
    let retry = 0;
    while (k < bytes.length) {
      const token = tokens[p];
      if (token?.kind === "star") {
        star = p++;
        retry = k;
        continue;
      }
      if (token && (token.kind === "any" || (token.kind === "byte" && token.value === bytes[k]) || (token.kind === "class" && token.values.has(bytes[k]!) !== token.negate))) {
        p++;
        k++;
        continue;
      }
      if (star < 0) return false;
      p = star + 1;
      k = ++retry;
    }
    while (tokens[p]?.kind === "star") p++;
    return p === tokens.length;
  };
}

export function compileRedisKeyGroups(rules: readonly RedisKeyGroupRule[]): (keyRaw: string) => string | null {
  const compiled = rules.filter((rule) => rule.enabled).map((rule) => ({ id: rule.id, includes: rule.includes.map(compileRedisGroupGlob), excludes: rule.excludes.map(compileRedisGroupGlob) }));
  return (keyRaw) => {
    const bytes = Uint8Array.from(atob(keyRaw), (char) => char.charCodeAt(0));
    for (const rule of compiled) {
      if ((!rule.includes.length || rule.includes.some((matches) => matches(bytes))) && !rule.excludes.some((matches) => matches(bytes))) return rule.id;
    }
    return null;
  };
}
