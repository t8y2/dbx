type TransferProgressTerminalState = {
  terminal?: boolean;
  status: "running" | "tableDone" | "done" | "error" | "cancelled";
};

export function isTerminalTransferProgress(progress: TransferProgressTerminalState): boolean {
  return progress.terminal === true || progress.status === "done" || progress.status === "cancelled";
}
