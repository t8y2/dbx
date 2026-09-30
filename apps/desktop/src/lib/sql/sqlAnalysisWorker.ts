export interface SqlAnalysisWorker<Input, Result> {
  analyze: (input: Input, fallback?: () => Result) => Promise<Result | null>;
  cancel: () => void;
  dispose: () => void;
}

export function createSqlAnalysisWorker<Input, Result>(createWorker: () => Worker, analyzeLocally: (input: Input) => Result): SqlAnalysisWorker<Input, Result> {
  interface Request {
    id: number;
    input: Input;
    fallback: () => Result;
    resolve: (result: Result | null) => void;
    cancelled: boolean;
  }

  let worker: Worker | null = null;
  let unavailable = typeof Worker === "undefined";
  let nextId = 0;
  let active: Request | null = null;
  let queued: Request | null = null;

  function fallback(request: Request) {
    if (request.cancelled) return;
    try {
      request.resolve(request.fallback());
    } catch {
      request.resolve(null);
    }
  }

  function finish(result: Result | null) {
    active?.resolve(result);
    active = null;
    const next = queued;
    queued = null;
    if (next) start(next);
  }

  function fail() {
    worker?.terminate();
    worker = null;
    unavailable = true;
    if (active && !queued) fallback(active);
    finish(null);
  }

  function start(request: Request) {
    if (unavailable) {
      fallback(request);
      return;
    }
    active = request;
    try {
      if (!worker) {
        const currentWorker = createWorker();
        worker = currentWorker;
        worker.onmessage = (event: MessageEvent<{ id: number; result?: Result; error?: string }>) => {
          if (worker !== currentWorker || event.data.id !== active?.id) return;
          if (event.data.error && !queued) fallback(active);
          finish(event.data.result ?? null);
        };
        worker.onerror = worker.onmessageerror = () => {
          if (worker === currentWorker) fail();
        };
      }
      worker.postMessage({ id: request.id, input: request.input });
    } catch {
      fail();
    }
  }

  function cancel() {
    if (active) {
      active.cancelled = true;
      active.resolve(null);
    }
    queued?.resolve(null);
    queued = null;
  }

  return {
    analyze(input, localFallback = () => analyzeLocally(input)) {
      cancel();
      return new Promise((resolve) => {
        const request = { id: ++nextId, input, fallback: localFallback, resolve, cancelled: false };
        if (active) queued = request;
        else start(request);
      });
    },
    cancel,
    dispose() {
      cancel();
      worker?.terminate();
      worker = null;
      active = null;
    },
  };
}
