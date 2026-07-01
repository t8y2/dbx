export interface MetadataTaskLimiterEvent {
  scope: string;
  kind: string;
  active: number;
  queued: number;
}

type MetadataTaskLimiterLogger = (event: MetadataTaskLimiterEvent & { event: "start" | "queued" | "done" }) => void;

interface QueuedTask<T> {
  kind: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface ScopeState {
  active: number;
  queue: QueuedTask<unknown>[];
}

export class MetadataTaskLimiter {
  private readonly scopes = new Map<string, ScopeState>();

  constructor(
    private readonly maxActive = 2,
    private readonly logger?: MetadataTaskLimiterLogger,
  ) {}

  run<T>(scope: string, kind: string, task: () => Promise<T>): Promise<T> {
    const normalizedScope = scope || "global";
    const state = this.stateForScope(normalizedScope);
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask<T> = { kind, run: task, resolve, reject };
      if (state.active < this.maxActive) {
        this.start(normalizedScope, state, queued);
        return;
      }
      state.queue.push(queued as QueuedTask<unknown>);
      this.logger?.({ event: "queued", scope: normalizedScope, kind, active: state.active, queued: state.queue.length });
    });
  }

  private stateForScope(scope: string): ScopeState {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { active: 0, queue: [] };
      this.scopes.set(scope, state);
    }
    return state;
  }

  private start<T>(scope: string, state: ScopeState, task: QueuedTask<T>) {
    state.active++;
    this.logger?.({ event: "start", scope, kind: task.kind, active: state.active, queued: state.queue.length });
    task
      .run()
      .then(task.resolve, task.reject)
      .finally(() => {
        state.active--;
        this.logger?.({ event: "done", scope, kind: task.kind, active: state.active, queued: state.queue.length });
        const next = state.queue.shift();
        if (next) {
          this.start(scope, state, next);
        } else if (state.active === 0) {
          this.scopes.delete(scope);
        }
      });
  }
}
