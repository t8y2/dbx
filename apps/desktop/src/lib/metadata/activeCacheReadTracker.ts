export interface ActiveCacheReadToken {
  readonly cacheKey: string;
  invalidated: boolean;
}

/** Tracks only currently running L2 reads, so invalidation state is bounded by concurrency. */
export class ActiveCacheReadTracker {
  private readonly readsByKey = new Map<string, Set<ActiveCacheReadToken>>();
  private count = 0;

  begin(cacheKey: string): ActiveCacheReadToken {
    const token: ActiveCacheReadToken = { cacheKey, invalidated: false };
    const existing = this.readsByKey.get(cacheKey);
    if (existing) existing.add(token);
    else this.readsByKey.set(cacheKey, new Set([token]));
    this.count += 1;
    return token;
  }

  finish(token: ActiveCacheReadToken): void {
    const reads = this.readsByKey.get(token.cacheKey);
    if (!reads?.delete(token)) return;
    this.count -= 1;
    if (reads.size === 0) this.readsByKey.delete(token.cacheKey);
  }

  invalidatePrefix(prefix: string): void {
    for (const [cacheKey, reads] of this.readsByKey) {
      if (!cacheKey.startsWith(prefix)) continue;
      for (const token of reads) token.invalidated = true;
    }
  }

  get activeCount(): number {
    return this.count;
  }
}
