import { metadataScopeKey, metadataScopeParts, type MetadataScopeInput } from "./metadataLoadScope";

export interface MetadataCacheHit<T> {
  value: T;
  cachedAt: number;
  ageMs: number;
  stale: boolean;
}

export type MetadataCacheInvalidation = Partial<Omit<MetadataScopeInput, "extra">>;

interface MetadataCacheEntry<T> {
  scope: ReturnType<typeof metadataScopeParts>;
  value: T;
  cachedAt: number;
}

export interface MetadataResultCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

function normalizeInvalidation(match: MetadataCacheInvalidation): Partial<ReturnType<typeof metadataScopeParts>> {
  const normalized = metadataScopeParts({ ...match, kind: match.kind ?? "__metadata_cache_match__" });
  const result: Partial<ReturnType<typeof metadataScopeParts>> = {};
  for (const key of Object.keys(match) as (keyof MetadataCacheInvalidation)[]) {
    const value = normalized[key as keyof typeof normalized];
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right) || (left && typeof left === "object") || (right && typeof right === "object")) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

/** 将失效 match 编译为作用于 metadataScopeParts 结果的谓词，供缓存外的在途登记复用同一匹配语义 */
export function metadataCacheInvalidationMatcher(match: MetadataCacheInvalidation): (scope: ReturnType<typeof metadataScopeParts>) => boolean {
  const normalized = normalizeInvalidation(match);
  return (scope) => Object.entries(normalized).every(([field, value]) => valuesEqual(scope[field as keyof typeof scope], value));
}

export class MetadataResultCache<T> {
  private readonly entries = new Map<string, MetadataCacheEntry<T>>();
  private readonly now: () => number;

  constructor(private readonly options: MetadataResultCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get(scope: MetadataScopeInput, options?: { allowStale?: boolean }): MetadataCacheHit<T> | undefined {
    const key = metadataScopeKey(scope);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = Math.max(0, this.now() - entry.cachedAt);
    const stale = ageMs > this.options.ttlMs;
    if (stale && !options?.allowStale) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, cachedAt: entry.cachedAt, ageMs, stale };
  }

  set(scope: MetadataScopeInput, value: T): void {
    const key = metadataScopeKey(scope);
    this.entries.delete(key);
    this.entries.set(key, { scope: metadataScopeParts(scope), value, cachedAt: this.now() });
    this.evictOldest();
  }

  invalidate(match: MetadataCacheInvalidation): number {
    const matches = metadataCacheInvalidationMatcher(match);
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (matches(entry.scope)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
