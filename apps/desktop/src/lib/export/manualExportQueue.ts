export type ManualExportMode = "immediate" | "queued";
export type ManualExportQueueState = "queued" | "running" | "cancelled" | "settled" | "unknown";

export interface ManualExportOperation {
  id: string;
  mode: ManualExportMode;
  run: () => Promise<"settled" | "unknown">;
  onStateChange: (state: ManualExportQueueState, error?: unknown) => void;
}

const pending: ManualExportOperation[] = [];
const active = new Set<string>();

function startNext() {
  if (active.size > 0) return;
  const operation = pending.shift();
  if (operation) start(operation);
}

function start(operation: ManualExportOperation) {
  active.add(operation.id);
  operation.onStateChange("running");
  void (async () => {
    let outcome: "settled" | "unknown";
    try {
      outcome = await operation.run();
    } catch (error) {
      operation.onStateChange("unknown", error);
      return;
    }
    operation.onStateChange(outcome);
    if (outcome === "settled") {
      active.delete(operation.id);
      startNext();
    }
  })();
}

/**
 * Acknowledge an operation whose outcome is unknown and hand its queue slot to
 * the next waiter. Never retries the released operation or touches the backend.
 */
export function releaseManualExport(id: string) {
  active.delete(id);
  startNext();
}

export function submitManualExport(operation: ManualExportOperation) {
  if (operation.mode === "immediate") {
    start(operation);
  } else {
    pending.push(operation);
    operation.onStateChange("queued");
    startNext();
  }

  return {
    cancelQueued() {
      const index = pending.indexOf(operation);
      if (index < 0) return false;
      pending.splice(index, 1);
      operation.onStateChange("cancelled");
      return true;
    },
  };
}
