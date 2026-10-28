export type SnapshotCompletionStatus = "failed" | "cancelled" | "unknown";

export interface ExportReadControl {
  signal: AbortSignal;
}

export class SnapshotCompletionError extends Error {
  constructor(
    readonly status: SnapshotCompletionStatus,
    message: string,
  ) {
    super(message);
    this.name = "SnapshotCompletionError";
  }
}

export function unwrapSnapshotCompletion<T>(outcome: unknown): T {
  if (!outcome || typeof outcome !== "object" || !("status" in outcome)) throw new Error("Invalid snapshot completion response");
  if (outcome.status === "succeeded" && "value" in outcome) return outcome.value as T;
  if ((outcome.status === "failed" || outcome.status === "cancelled" || outcome.status === "unknown") && "message" in outcome && typeof outcome.message === "string") throw new SnapshotCompletionError(outcome.status, outcome.message);
  throw new Error("Invalid snapshot completion response");
}
