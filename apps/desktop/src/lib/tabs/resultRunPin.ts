/**
 * Whether clicking a result-run tab should pin that run. Pinning on click keeps
 * the result from being replaced by the next query (#9975), but users who always
 * want the latest result can disable it (#12381).
 */
export function shouldPinResultRunOnClick(run: { pinned?: boolean } | null | undefined, pinOnClick: boolean): boolean {
  return !!run && !run.pinned && pinOnClick !== false;
}
