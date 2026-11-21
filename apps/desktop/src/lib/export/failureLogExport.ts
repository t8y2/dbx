/**
 * Shared helpers for the SQL file failure log (dbx#11619).
 *
 * Both the execution dialog and the background-task popover offer the same
 * actions over the same backend log, so the parts that do not depend on either
 * layout live here: the error code the Web transport raises when a selected
 * subset is too large to ship as text, the JS-side view of a failure row, and
 * the conversion to the stable keys the backend filters on.
 */

import type { SqlFileFailure } from "@/composables/useExportTracker";
import type { SqlFileFailureLogKey } from "@/lib/backend/api";

/** Raised when a selected subset exceeds the text cap and must be exported instead. */
export const FAILURE_LOG_TEXT_TOO_LARGE = "FAILURE_LOG_TEXT_TOO_LARGE";

/**
 * Per-app-run guard for the sensitive-data notice (dbx#11619).
 *
 * A failure log stores the complete failing statements and the raw database
 * errors, which can contain credentials or personal data — that is the point of
 * the feature, and DBX deliberately does not redact them. The user is therefore
 * warned the first time they export or copy, once per app run rather than on
 * every action, which would only train them to dismiss it.
 */
export const failureLogSensitiveNotice = { shown: false };

/** Returns true exactly once per app run, so the caller can warn a single time. */
export function takeFailureLogSensitiveNotice(): boolean {
  if (failureLogSensitiveNotice.shown) return false;
  failureLogSensitiveNotice.shown = true;
  return true;
}

/** Selection key of one failure row; `fileIndex` is absent for single-file runs. */
export function failureLogRowKey(failure: Pick<SqlFileFailure, "fileIndex" | "statementIndex">): string {
  return `${failure.fileIndex ?? -1}:${failure.statementIndex}`;
}

/** Backend key payload for a failure row. */
export function failureLogKeyPayload(failure: Pick<SqlFileFailure, "fileIndex" | "statementIndex">): SqlFileFailureLogKey {
  return { fileIndex: failure.fileIndex ?? 0, statementIndex: failure.statementIndex };
}

/**
 * Keys of the rows the user selected, in the order the list shows them, so the
 * exported subset keeps the log's original ordering.
 */
export function selectedFailureLogKeys(failures: SqlFileFailure[], selected: ReadonlySet<string>): SqlFileFailureLogKey[] {
  return failures.filter((failure) => selected.has(failureLogRowKey(failure))).map(failureLogKeyPayload);
}

/**
 * Whether the UI list is shorter than the log: the backend keeps every logged
 * failure, while the frontend retains only the newest few hundred.
 */
export function failureLogListCoverage(loggedFailures: number, visibleFailures: number): { truncated: boolean; hidden: number } {
  const hidden = Math.max(0, loggedFailures - visibleFailures);
  return { truncated: hidden > 0, hidden };
}
