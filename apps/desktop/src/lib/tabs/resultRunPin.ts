/**
 * Whether clicking a result-run tab should toggle that run's pin. Pinning on
 * click keeps the result from being replaced by the next query (#9975), users
 * who always want the latest result can disable it (#12381), and clicking a
 * pinned run unpins it so removing a pin no longer needs the context menu
 * (#13306). Disabling the option keeps clicks selection-only; explicit pins
 * from the context menu still work.
 */
export function shouldPinResultRunOnClick(run: { pinned?: boolean } | null | undefined, pinOnClick: boolean): boolean {
  return !!run && pinOnClick !== false;
}
