import type { RedisCollectionPage } from "@/lib/backend/api";
import type { RedisCollectionItem } from "./redisValuePresentation";

export type RedisCollectionScope = {
  connectionId: string;
  db: number;
  keyRaw: string;
  kind: RedisCollectionPage["kind"];
  sortDirection?: "asc" | "desc";
};
export type RedisCollectionSearchState = {
  status: "idle" | "searching" | "partial" | "complete" | "paused" | "failed";
  query: string;
  items: RedisCollectionItem[];
  // Zero means the first request is still pending; null means the walk is complete.
  cursor: number | null;
  error?: unknown;
  pauseReason?: "stopped" | "inactive" | "stalled";
};
export const emptyRedisCollectionSearchState = (): RedisCollectionSearchState => ({ status: "idle", query: "", items: [], cursor: null });

export function mergeRedisCollectionItems(kind: RedisCollectionScope["kind"], previous: RedisCollectionItem[], incoming: RedisCollectionItem[]): RedisCollectionItem[] {
  if (incoming.length === 0) return previous;
  const identity = (item: RedisCollectionItem): string => {
    if (kind === "list" && "index" in item) return String(item.index);
    if ("field" in item) return item.field.raw_base64;
    if ("member" in item) return item.member.raw_base64;
    throw new Error("Unexpected Redis collection item");
  };
  const merged = new Map<string, RedisCollectionItem>();
  for (const item of [...previous, ...incoming]) merged.set(identity(item), item);
  return [...merged.values()];
}

type Request = { scope: RedisCollectionScope; cursor: number; query: string };
type Session = { scope: RedisCollectionScope; state: RedisCollectionSearchState; buffered?: { cursor: number; page: RedisCollectionPage } };
type Operation = { session: Session; revision: number; resolve: () => void };

/** Serializes real page requests, while replacing pending searches with the latest intent. */
export class RedisCollectionSearchController {
  private session?: Session;
  private browsingSession?: Session;
  private revision = 0;
  private pending?: Operation;
  private pumping = false;
  private active = true;
  private disposed = false;
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      fetchPage: (request: Request) => Promise<RedisCollectionPage>;
      changed: (state: RedisCollectionSearchState) => void;
    },
  ) {}

  private publish(state: RedisCollectionSearchState) {
    if (this.session) this.session.state = state;
    if (!this.disposed) this.options.changed(state);
  }

  private invalidate() {
    this.revision++;
    this.pending?.resolve();
    this.pending = undefined;
  }

  prepare(scope: RedisCollectionScope, query: string) {
    this.invalidate();
    if (query && this.session && !this.session.state.query && this.sameScope(this.session.scope, scope)) this.browsingSession = this.session;
    if (this.browsingSession && (!query || !this.sameScope(this.browsingSession.scope, scope))) this.browsingSession = undefined;
    this.session = { scope: { ...scope }, state: { status: "searching", query, items: [], cursor: 0 } };
    this.publish(this.session.state);
  }

  reset() {
    this.invalidate();
    this.session = undefined;
    this.browsingSession = undefined;
    this.publish(emptyRedisCollectionSearchState());
  }

  /** Keep a browsing page that may already have consumed a server overflow cursor. */
  cancelSearch() {
    this.invalidate();
    const browsing = this.browsingSession ?? (this.session && !this.session.state.query ? this.session : undefined);
    this.browsingSession = undefined;
    this.session = browsing;
    this.publish(browsing ? { ...browsing.state, status: "idle", error: undefined, pauseReason: undefined } : emptyRedisCollectionSearchState());
  }

  private sameScope(left: RedisCollectionScope, right: RedisCollectionScope) {
    return left.connectionId === right.connectionId && left.db === right.db && left.keyRaw === right.keyRaw && left.kind === right.kind && left.sortDirection === right.sortDirection;
  }

  stop(reason: "stopped" | "inactive" = "stopped") {
    this.invalidate();
    if (this.session?.state.cursor != null) this.publish({ ...this.session.state, status: "paused", pauseReason: reason, error: undefined });
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) this.stop("inactive");
  }

  dispose() {
    this.stop("inactive");
    this.disposed = true;
    this.active = false;
  }

  /** Ordinary load-more pages use the same request gate, without automatic empty-page scanning. */
  browse(scope: RedisCollectionScope, items: RedisCollectionItem[], cursor: number) {
    const current = this.session;
    const sameScope = current && this.sameScope(current.scope, scope);
    if (!sameScope || current.state.query || current.state.cursor !== cursor) this.prepare(scope, "");
    this.session!.state = { status: "searching", query: "", items, cursor };
    return this.start();
  }

  start(): Promise<void> {
    if (!this.session || this.session.state.cursor == null || !this.active || this.disposed) return Promise.resolve();
    this.invalidate();
    const session = this.session;
    this.publish({ ...session.state, status: "searching", pauseReason: undefined, error: undefined });
    const completion = new Promise<void>((resolve) => {
      this.pending = { session, revision: this.revision, resolve };
    });
    void this.pump();
    return completion;
  }

  /** Also gates the descending ZSet initial page used during a value reload. */
  async readPage(scope: RedisCollectionScope, cursor: number, query: string, valid: () => boolean = () => true): Promise<RedisCollectionPage | undefined> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.disposed || !this.active || !valid()) return undefined;
      return await this.options.fetchPage({ scope, cursor, query });
    } finally {
      release();
    }
  }

  private current(operation: Operation) {
    return this.active && !this.disposed && this.session === operation.session && this.revision === operation.revision;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending && this.active && !this.disposed) {
        const operation = this.pending;
        this.pending = undefined;
        try {
          await this.scan(operation);
        } catch (error) {
          if (this.current(operation)) this.publish({ ...operation.session.state, status: "failed", error });
        } finally {
          operation.resolve();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async scan(operation: Operation) {
    while (this.current(operation)) {
      const { scope, state } = operation.session;
      if (state.cursor == null) return;
      const cursor = state.cursor;
      const buffered = operation.session.buffered;
      operation.session.buffered = undefined;
      const page = buffered?.cursor === cursor ? buffered.page : await this.readPage(scope, cursor, state.query, () => this.current(operation));
      if (!page) return;
      if (!this.current(operation)) {
        // Overflow cursors consume their page on the server. Keep the settled page
        // private until this same search is resumed, without changing paused UI.
        if ((this.session === operation.session || this.browsingSession === operation.session) && !this.disposed) operation.session.buffered = { cursor, page };
        return;
      }
      if (page.kind !== scope.kind) throw new Error("Unexpected Redis collection page type");
      const next = page.scan_cursor != null && page.scan_cursor > 0 ? page.scan_cursor : null;
      const items = mergeRedisCollectionItems(scope.kind, state.items, page.items);
      if (next == null || !state.query) {
        this.publish({ ...state, items, cursor: next, status: next == null ? "complete" : "partial" });
        return;
      }
      // Nonempty overflow pages may legitimately keep the same cursor.
      const reason = page.items.length === 0 && next === cursor ? "stalled" : undefined;
      this.publish({ ...state, items, cursor: next, status: reason ? "paused" : "searching", pauseReason: reason });
      if (reason) return;
    }
  }
}
