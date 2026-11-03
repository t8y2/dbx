export interface ActiveCacheReadToken {
  readonly cacheKey: string;
  invalidated: boolean;
  readonly controller: AbortController;
}

/** Tracks only currently running L2 reads, so invalidation state is bounded by concurrency. */
export class ActiveCacheReadTracker {
  private readonly readsByKey = new Map<string, Set<ActiveCacheReadToken>>();
  private count = 0;

  begin(cacheKey: string): ActiveCacheReadToken {
    const token: ActiveCacheReadToken = { cacheKey, invalidated: false, controller: new AbortController() };
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

  cancelPrefix(prefix: string): void {
    for (const [cacheKey, reads] of this.readsByKey) {
      if (!cacheKey.startsWith(prefix)) continue;
      for (const token of reads) {
        token.invalidated = true;
        token.controller.abort(new Error("Metadata waiting cancelled locally."));
      }
    }
  }

  get activeCount(): number {
    return this.count;
  }
}
