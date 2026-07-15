export interface SidebarDataOpenRequest {
  isCurrent: () => boolean;
  registerCancel: (cancel: () => void | Promise<void>) => void;
}

type OpenDataRunner = (request: SidebarDataOpenRequest) => void | Promise<void>;

let generation = 0;
let activeGeneration = 0;
let activeCancel: (() => void | Promise<void>) | null = null;

function runCancellation(cancel: (() => void | Promise<void>) | null) {
  if (!cancel) return;
  void Promise.resolve(cancel()).catch(() => undefined);
}

function supersedeCurrentRequest(): number {
  generation += 1;
  runCancellation(activeCancel);
  activeCancel = null;
  activeGeneration = 0;
  return generation;
}

function executeRequest(requestGeneration: number, runner: OpenDataRunner) {
  if (requestGeneration !== generation) return;
  const request: SidebarDataOpenRequest = {
    isCurrent: () => requestGeneration === generation,
    registerCancel: (cancel) => {
      if (requestGeneration !== generation) {
        runCancellation(cancel);
        return;
      }
      activeGeneration = requestGeneration;
      activeCancel = cancel;
    },
  };
  let result: void | Promise<void>;
  try {
    result = runner(request);
  } catch {
    result = undefined;
  }
  void Promise.resolve(result)
    .catch(() => undefined)
    .finally(() => {
      if (activeGeneration !== requestGeneration) return;
      activeGeneration = 0;
      activeCancel = null;
    });
}

export function runSidebarDataOpenImmediately(runner: OpenDataRunner) {
  const requestGeneration = supersedeCurrentRequest();
  executeRequest(requestGeneration, runner);
}

export function cancelPendingSidebarDataOpen() {
  supersedeCurrentRequest();
}
