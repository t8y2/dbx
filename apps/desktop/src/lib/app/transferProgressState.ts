export interface TransferTerminalState {
  done: boolean;
  cancelled: boolean;
  error: boolean;
}

export interface TransferStatusLike {
  status: "running" | "tableDone" | "done" | "error" | "cancelled";
}

export interface TransferDialogRunState extends TransferTerminalState {
  transferring: boolean;
}

export function nextTransferTerminalState(state: TransferTerminalState, progress: TransferStatusLike): TransferTerminalState {
  if (progress.status === "error") return { ...state, error: true };
  if (progress.status === "done") return { ...state, done: true, error: state.error };
  if (progress.status === "cancelled") return { ...state, cancelled: true };
  return state;
}

export function isTransferRunActive(state: TransferDialogRunState): boolean {
  return state.transferring && !state.done && !state.cancelled && !state.error;
}

export function shouldResetTransferDialogOnOpen(state: TransferDialogRunState): boolean {
  return state.transferring && !isTransferRunActive(state);
}

export function shouldKeepTransferDraftOnOpen(preserveDraft: boolean, state: TransferDialogRunState): boolean {
  return preserveDraft || shouldResetTransferDialogOnOpen(state);
}
