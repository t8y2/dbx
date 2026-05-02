export interface TransferTerminalState {
  done: boolean;
  cancelled: boolean;
  error: boolean;
}

export interface TransferStatusLike {
  status: "running" | "tableDone" | "done" | "error" | "cancelled";
}

export function nextTransferTerminalState(
  state: TransferTerminalState,
  progress: TransferStatusLike,
): TransferTerminalState {
  if (progress.status === "done") return { ...state, done: true };
  if (progress.status === "cancelled") return { ...state, cancelled: true };
  if (progress.status === "error") return { ...state, error: true };
  return state;
}
