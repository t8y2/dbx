export interface AgentOfflineExportFlowOptions<TResult> {
  driverKeys: string[];
  chooseDestination: () => Promise<string | null>;
  exportPackage: (destination: string, driverKeys: string[]) => Promise<TResult>;
}

export interface AgentOfflineExportFlowResult<TResult> {
  destination: string;
  result: TResult;
}

export interface AgentOfflineExportActionOptions<TResult> extends AgentOfflineExportFlowOptions<TResult> {
  setBusy: (busy: boolean) => void;
  onSuccess: (exported: AgentOfflineExportFlowResult<TResult>) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

export type AgentOfflineExportActionResult = "empty" | "cancelled" | "exported" | "failed";

/**
 * Keep destination selection and package creation in one testable workflow.
 * The caller owns the busy state so it can cover the native save dialog too.
 */
export async function runAgentOfflineExportFlow<TResult>({ driverKeys, chooseDestination, exportPackage }: AgentOfflineExportFlowOptions<TResult>): Promise<AgentOfflineExportFlowResult<TResult> | null> {
  if (driverKeys.length === 0) return null;

  const destination = await chooseDestination();
  if (!destination) return null;

  return {
    destination,
    result: await exportPackage(destination, [...driverKeys]),
  };
}

/**
 * Own the complete UI action lifecycle, including the native save dialog.
 * This keeps busy-state release and success/error side effects testable as one
 * contract instead of splitting them between the component and export helper.
 */
export async function runAgentOfflineExportAction<TResult>({ driverKeys, chooseDestination, exportPackage, setBusy, onSuccess, onError }: AgentOfflineExportActionOptions<TResult>): Promise<AgentOfflineExportActionResult> {
  if (driverKeys.length === 0) return "empty";

  setBusy(true);
  try {
    const exported = await runAgentOfflineExportFlow({ driverKeys, chooseDestination, exportPackage });
    if (!exported) return "cancelled";

    await onSuccess(exported);
    return "exported";
  } catch (error) {
    await onError(error);
    return "failed";
  } finally {
    setBusy(false);
  }
}
