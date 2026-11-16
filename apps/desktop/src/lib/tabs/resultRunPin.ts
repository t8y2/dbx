/**
 * Whether clicking a result-run tab should toggle that run's pin. Switching
 * to another result tab only selects it and never changes pin state, so
 * moving between results neither pins an unpinned run nor drops a pin
 * (#14599, #15037). Only clicking the run that is already shown toggles its
 * pin: it pins an unpinned shown result so the next query keeps it instead
 * of replacing it (#9975), and unpins a pinned shown result so removing a
 * pin no longer needs the context menu (#13306). Users who always want the
 * latest result can disable it (#12381). Disabling the option keeps clicks
 * selection-only; explicit pins from the context menu still work.
 */
export function shouldPinResultRunOnClick(run: { pinned?: boolean } | null | undefined, pinOnClick: boolean, wasActive = false): boolean {
  if (!run || pinOnClick === false || !wasActive) return false;
  return true;
}
