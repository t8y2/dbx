export interface SidebarDataOpenRequest {
  isCurrent: () => boolean;
  signal: AbortSignal;
  registerCancel: (cancel: () => void | Promise<void>) => void;
}

export interface SidebarDataOpenOptions {
  connectionKey: string;
  supersede?: boolean;
}

type OpenDataRunner = (request: SidebarDataOpenRequest) => void | Promise<void>;

interface QueuedOpen {
  id: number;
  connectionKey: string;
  superseding: boolean;
  controller: AbortController;
  runner: OpenDataRunner;
  cancel: (() => void | Promise<void>) | null;
  started: boolean;
  finished: boolean;
}

const DEFAULT_CONNECTION_KEY = "__sidebar__";
const MAX_ACTIVE_PER_CONNECTION = 1;

let nextRequestId = 0;
let latestSupersedingRequestId = 0;
const queuedByConnection = new Map<string, QueuedOpen[]>();
const activeCountByConnection = new Map<string, number>();
const requests = new Map<number, QueuedOpen>();

function runCancellation(cancel: (() => void | Promise<void>) | null) {
  if (!cancel) return;
  void Promise.resolve(cancel()).catch(() => undefined);
}

function isCurrent(request: QueuedOpen): boolean {
  if (request.finished || request.controller.signal.aborted) return false;
  return !request.superseding || request.id === latestSupersedingRequestId;
}

function removeQueuedRequest(request: QueuedOpen) {
  const queue = queuedByConnection.get(request.connectionKey);
  if (!queue) return;
  const index = queue.indexOf(request);
  if (index >= 0) queue.splice(index, 1);
  if (queue.length === 0) queuedByConnection.delete(request.connectionKey);
}

function cancelRequest(request: QueuedOpen) {
  if (request.finished) return;
  request.controller.abort();
  runCancellation(request.cancel);
  request.cancel = null;
  if (!request.started) {
    request.finished = true;
    removeQueuedRequest(request);
    requests.delete(request.id);
  }
}

function supersedeCurrentRequest() {
  const current = requests.get(latestSupersedingRequestId);
  if (current) cancelRequest(current);
}

function finishRequest(request: QueuedOpen) {
  if (request.finished) return;
  request.finished = true;
  request.cancel = null;
  requests.delete(request.id);
  const activeCount = activeCountByConnection.get(request.connectionKey) ?? 0;
  if (activeCount <= 1) activeCountByConnection.delete(request.connectionKey);
  else activeCountByConnection.set(request.connectionKey, activeCount - 1);
  drainConnection(request.connectionKey);
}

function executeRequest(request: QueuedOpen) {
  if (!isCurrent(request)) {
    cancelRequest(request);
    return;
  }

  request.started = true;
  activeCountByConnection.set(request.connectionKey, (activeCountByConnection.get(request.connectionKey) ?? 0) + 1);
  const openRequest: SidebarDataOpenRequest = {
    isCurrent: () => isCurrent(request),
    signal: request.controller.signal,
    registerCancel: (cancel) => {
      if (!isCurrent(request)) {
        runCancellation(cancel);
        return;
      }
      request.cancel = cancel;
    },
  };

  let result: void | Promise<void>;
  try {
    result = request.runner(openRequest);
  } catch {
    result = undefined;
  }
  void Promise.resolve(result)
    .catch(() => undefined)
    .finally(() => finishRequest(request));
}

function drainConnection(connectionKey: string) {
  if ((activeCountByConnection.get(connectionKey) ?? 0) >= MAX_ACTIVE_PER_CONNECTION) return;
  const queue = queuedByConnection.get(connectionKey);
  const request = queue?.shift();
  if (!request) {
    queuedByConnection.delete(connectionKey);
    return;
  }
  if (queue?.length === 0) queuedByConnection.delete(connectionKey);
  executeRequest(request);
}

function enqueueRequest(options: SidebarDataOpenOptions, runner: OpenDataRunner) {
  const superseding = options.supersede !== false;
  if (superseding) supersedeCurrentRequest();

  const request: QueuedOpen = {
    id: ++nextRequestId,
    connectionKey: options.connectionKey || DEFAULT_CONNECTION_KEY,
    superseding,
    controller: new AbortController(),
    runner,
    cancel: null,
    started: false,
    finished: false,
  };
  if (superseding) latestSupersedingRequestId = request.id;
  requests.set(request.id, request);
  const queue = queuedByConnection.get(request.connectionKey) ?? [];
  queue.push(request);
  queuedByConnection.set(request.connectionKey, queue);
  drainConnection(request.connectionKey);
}

export function runSidebarDataOpenImmediately(runner: OpenDataRunner): void;
export function runSidebarDataOpenImmediately(options: SidebarDataOpenOptions, runner: OpenDataRunner): void;
export function runSidebarDataOpenImmediately(optionsOrRunner: SidebarDataOpenOptions | OpenDataRunner, maybeRunner?: OpenDataRunner) {
  if (typeof optionsOrRunner === "function") {
    enqueueRequest({ connectionKey: DEFAULT_CONNECTION_KEY }, optionsOrRunner);
    return;
  }
  if (maybeRunner) enqueueRequest(optionsOrRunner, maybeRunner);
}

export function cancelPendingSidebarDataOpen() {
  for (const request of [...requests.values()]) cancelRequest(request);
  latestSupersedingRequestId = 0;
}

export function sidebarDataOpenDiagnostics() {
  return {
    activeTasks: [...activeCountByConnection.values()].reduce((total, count) => total + count, 0),
    queuedTasks: [...queuedByConnection.values()].reduce((total, queue) => total + queue.length, 0),
    trackedRequests: requests.size,
  };
}
