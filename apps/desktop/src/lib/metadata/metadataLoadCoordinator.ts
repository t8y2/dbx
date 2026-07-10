import { metadataScopeKey, type MetadataScopeInput } from "./metadataLoadScope";

export type MetadataLoadCacheStatus = "none" | "hit" | "miss" | "stale" | "refresh";

export interface MetadataLoadTraceDetails {
  cacheStatus?: MetadataLoadCacheStatus;
  resultCount?: number;
  deduped?: boolean;
  force?: boolean;
  stale?: boolean;
  superseded?: boolean;
  error?: unknown;
}

export interface MetadataLoadTraceEvent extends MetadataLoadTraceDetails {
  event: string;
  traceId: string;
  scopeKey: string;
  elapsedMs: number;
}

export type MetadataLoadTraceLogger = (event: MetadataLoadTraceEvent) => void;

export interface MetadataLoadTrace {
  traceId: string;
  scopeKey: string;
  startedAt: number;
  elapsedMs: () => number;
  event: (event: string, details?: MetadataLoadTraceDetails) => MetadataLoadTraceEvent;
}

export interface MetadataLoadCoordinatorEvent {
  event: "start" | "dedupe" | "done" | "error";
  key: string;
  kind: string;
  active: number;
  force: boolean;
}

export type MetadataLoadCoordinatorLogger = (event: MetadataLoadCoordinatorEvent) => void;

export interface MetadataLoadCoordinatorOptions {
  force?: boolean;
  kind?: string;
}

interface InFlightLoad<T> {
  kind: string;
  promise: Promise<T>;
}

function defaultTraceId() {
  return Math.random().toString(16).slice(2, 10);
}

function defaultNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function createMetadataLoadTrace(
  scope: MetadataScopeInput | string,
  options?: {
    traceId?: string;
    now?: () => number;
  },
): MetadataLoadTrace {
  const now = options?.now ?? defaultNow;
  const startedAt = now();
  const scopeKey = typeof scope === "string" ? scope : metadataScopeKey(scope);
  const traceId = options?.traceId ?? defaultTraceId();
  const elapsedMs = () => Math.max(0, Math.round(now() - startedAt));
  return {
    traceId,
    scopeKey,
    startedAt,
    elapsedMs,
    event: (event, details = {}) => ({
      event,
      traceId,
      scopeKey,
      elapsedMs: elapsedMs(),
      ...details,
    }),
  };
}

export function logMetadataLoadTrace(logger: MetadataLoadTraceLogger | undefined, trace: MetadataLoadTrace, event: string, details?: MetadataLoadTraceDetails) {
  logger?.(trace.event(event, details));
}

export class MetadataLoadCoordinator {
  private readonly inFlight = new Map<string, InFlightLoad<unknown>>();

  constructor(private readonly logger?: MetadataLoadCoordinatorLogger) {}

  run<T>(scope: MetadataScopeInput | string, load: () => Promise<T>, options?: MetadataLoadCoordinatorOptions): Promise<T> {
    const key = typeof scope === "string" ? scope : metadataScopeKey(scope);
    const kind = options?.kind ?? (typeof scope === "string" ? "metadata" : scope.kind);
    const force = options?.force === true;
    const existing = force ? undefined : this.inFlight.get(key);
    if (existing) {
      this.logger?.({ event: "dedupe", key, kind: existing.kind, active: this.inFlight.size, force: false });
      return existing.promise as Promise<T>;
    }

    this.logger?.({ event: "start", key, kind, active: this.inFlight.size + 1, force });
    const promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          this.logger?.({ event: "done", key, kind, active: this.inFlight.size, force });
          return value;
        },
        (error) => {
          this.logger?.({ event: "error", key, kind, active: this.inFlight.size, force });
          throw error;
        },
      )
      .finally(() => {
        const current = this.inFlight.get(key);
        if (current?.promise === promise) {
          this.inFlight.delete(key);
        }
      });

    if (!force) {
      this.inFlight.set(key, { kind, promise });
    }
    return promise;
  }

  has(scope: MetadataScopeInput | string): boolean {
    const key = typeof scope === "string" ? scope : metadataScopeKey(scope);
    return this.inFlight.has(key);
  }

  clear(scope?: MetadataScopeInput | string) {
    if (scope === undefined) {
      this.inFlight.clear();
      return;
    }
    const key = typeof scope === "string" ? scope : metadataScopeKey(scope);
    this.inFlight.delete(key);
  }
}
