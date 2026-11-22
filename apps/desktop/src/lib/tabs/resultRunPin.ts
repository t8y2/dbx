/**
 * Whether clicking a result-run tab should toggle that run's pin. Pinning on
 * click keeps the result from being replaced by the next query (#9975), users
 * who always want the latest result can disable it (#12381), and clicking the
 * pinned run that is already shown unpins it so removing a pin no longer needs
 * the context menu (#13306). Switching to a pinned run from another result tab
 * only selects it, so moving between results never drops a pin (#14599).
 * Disabling the option keeps clicks selection-only; explicit pins from the
 * context menu still work.
 */
export function shouldPinResultRunOnClick(run: { pinned?: boolean } | null | undefined, pinOnClick: boolean, wasActive = false): boolean {
  if (!run || pinOnClick === false) return false;
  return !run.pinned || wasActive;
}
