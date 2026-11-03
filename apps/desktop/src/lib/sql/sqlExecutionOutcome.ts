/**
 * What one editor execution actually did (#11962).
 *
 * The editor path ignores this value — its feedback is the tab's own result pane
 * — but a caller that starts an execution on a tab the user is *not* looking at
 * (the AI panel does, see `lib/ai/aiSqlActionFeedback`) has nowhere else to learn
 * that the request ran, ran late, or never started. Reporting every early return
 * is the point: silence there is exactly the bug in #11962.
 */

/**
 * Why an execution request never reached the database.
 *
 * `cancelled` / `parameters` / `blocked` / `missing-database` are the reasons the
 * user has already been shown a dialog or toast, so a caller must not report them
 * a second time.
 */
export type SqlExecutionNotStartedReason = "no-tab" | "no-connection" | "empty-sql" | "missing-database" | "parameters" | "busy" | "cancelled" | "blocked";

/** Dialog an execution is parked on until the user answers it. */
export type SqlExecutionDeferredReason = "parameters" | "danger" | "redis-confirm";

export type SqlExecutionOutcome =
  /** The request reached the backend; `ok` is whether it succeeded. */
  | { status: "started"; ok: boolean; errorMessage?: string; tabId: string }
  /**
   * The request opened a dialog (parameter / danger / Redis confirmation) and only
   * continues if the user accepts it, so this is NOT terminal: a caller that needs
   * the final result must wait for the resumed execution
   * (`onDeferredExecutionSettled`) instead of settling here. Treating it as a
   * plain dismissal is what left a confirmed AI execution unreported.
   */
  | { status: "deferred"; reason: SqlExecutionDeferredReason; tabId: string }
  | { status: "not-started"; reason: SqlExecutionNotStartedReason; tabId?: string };
