/**
 * Feedback decision for an AI-initiated SQL action (#11962).
 *
 * The AI panel's execute / temp-run / apply buttons hand the whole interaction
 * to an editor tab resolved from the conversation's bound connection, and that
 * tab is deliberately created without activation (#9902: an AI action never
 * moves the workspace). When the tab is not on screen the click used to produce
 * *no* visible change at all — the database error was written only into that
 * background tab's result. This module decides what the panel must say instead.
 *
 * Pure and dependency-free on purpose: the decision table is unit-tested
 * without mounting `App.vue`.
 */

import type { SqlExecutionOutcome } from "@/lib/sql/sqlExecutionOutcome";

/** One AI-initiated action's outcome: a real execution, or the panel's own append. */
export type AiSqlActionOutcome = SqlExecutionOutcome | { status: "applied"; tabId: string };

export interface AiSqlActionFeedbackContext {
  /** Whether the target tab is currently rendered as some editor group's active tab. */
  targetOnScreen: boolean;
  /** Display title of the target tab, for the "executed in …" copy. */
  tabTitle?: string;
}

export type AiSqlActionFeedback = { level: "none" } | { level: "info" | "error"; messageKey: string; params: Record<string, string>; revealTabId?: string };

const NONE: AiSqlActionFeedback = { level: "none" };

/**
 * Decides the panel-side feedback for one AI SQL action.
 *
 * - The user already saw UI (danger/production/parameter/unlock dialogs, the
 *   blocked-Redis toast, the "select a database" toast) → `none`. Repeating it
 *   as a second toast would be noise, and the panel's own block status still
 *   settles so nothing is left spinning.
 * - Target tab on screen → `none`: the tab itself shows the result and error,
 *   and #9902 promises the workspace is never disturbed by an AI action.
 * - Target tab off screen → the error path is always visible, and the success
 *   path is announced with a `[查看]` reveal action; never an automatic switch.
 */
export function aiSqlActionFeedback(outcome: AiSqlActionOutcome, context: AiSqlActionFeedbackContext): AiSqlActionFeedback {
  if (outcome.status === "not-started") {
    switch (outcome.reason) {
      case "cancelled":
      case "parameters":
      case "blocked":
        // A dialog/toast the user is already looking at, or a prompt they will
        // still answer — the AI action has not been abandoned, so say nothing.
        return NONE;
      case "missing-database":
        // `promptActiveDatabaseSelection` in App.vue already toasts
        // `editor.selectDatabaseRequired` for this exact request.
        return NONE;
      case "empty-sql":
        return reveal({ level: "error", messageKey: "ai.sqlActionEmptySql", params: {} }, outcome.tabId);
      case "busy":
        return reveal({ level: "error", messageKey: "ai.sqlActionBusy", params: {} }, outcome.tabId);
      case "no-tab":
      case "no-connection":
        // No target tab at all (unbound conversation, deleted connection, or a
        // tab that vanished): report the reason, and there is nothing to reveal.
        return { level: "error", messageKey: "ai.sqlActionNoConnection", params: {} };
    }
  }

  if (outcome.status === "deferred") {
    // The dialog is on screen and the execution has not run yet, so there is
    // nothing to announce: the caller keeps waiting and settles from the resumed
    // execution (`onDeferredExecutionSettled`) instead.
    return NONE;
  }

  if (context.targetOnScreen) return NONE;

  const title = context.tabTitle?.trim() || outcome.tabId;
  if (outcome.status === "applied") {
    return { level: "info", messageKey: "ai.sqlActionAppliedIn", params: { title }, revealTabId: outcome.tabId };
  }
  if (outcome.ok) {
    // The *In keys name the tab the SQL ran in: the user is looking at the panel,
    // not at the editor, so the toast has to say where the result landed.
    return { level: "info", messageKey: "ai.sqlActionSucceededIn", params: { title }, revealTabId: outcome.tabId };
  }
  return {
    level: "error",
    messageKey: "ai.sqlActionFailed",
    params: { title, message: outcome.errorMessage?.trim() || "" },
    revealTabId: outcome.tabId,
  };
}

function reveal(feedback: { level: "info" | "error"; messageKey: string; params: Record<string, string> }, tabId: string | undefined): AiSqlActionFeedback {
  return tabId ? { ...feedback, revealTabId: tabId } : feedback;
}

/**
 * Settlement report the host pushes back into the AI panel (#11962), so the SQL
 * block that started the action shows its own outcome without the user having to
 * find the target tab. Messages are already-translated text.
 */
export interface AiSqlActionReport {
  requestId: number;
  /**
   * `dismissed` means the user answered a dialog (or the request was cancelled)
   * and the panel must simply stop showing "running" — no error, no summary.
   * `applied` is the append-to-editor action, which has no execution summary.
   */
  status: "succeeded" | "applied" | "failed" | "unavailable" | "dismissed";
  /** Result rows returned, when the execution produced any. */
  rows?: number;
  /** Rows the statement affected, when the backend reported any. */
  affectedRows?: number;
  /** Database error text (`failed`) or why nothing ran (`unavailable`). */
  message?: string;
}
