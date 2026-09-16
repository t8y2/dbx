import type { SnapshotWarning } from "./types";

export interface WarningNotice {
  severity: "info" | "warning";
  title: string;
  detail: string;
}

/**
 * A `useI18n().t`-shaped function, passed in rather than imported directly.
 *
 * `useI18n()` throws without a provided Vue instance — exactly the standalone
 * HTML export case (Part 3c), which bootstraps no Vue app around this module.
 * Taking the translator as a parameter keeps this file a pure module the
 * export can call with an English identity function, and is why `src/docs/`
 * must never import vue-i18n directly.
 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * Turn a snapshot warning into something a reader can act on.
 *
 * This is where "degrade visibly, never silently" becomes literal: if a table
 * could not be read, or an engine cannot report relationships, the reader has
 * to learn that from the page rather than infer it from an absence.
 */
export function describeWarning(warning: SnapshotWarning, translate: Translate): WarningNotice {
  switch (warning.kind) {
    case "tableSkipped":
      return {
        severity: "warning",
        title: translate("docs.warnings.tableSkipped.title"),
        detail: translate("docs.warnings.tableSkipped.detail", { table: warning.table, reason: warning.reason }),
      };
    case "noForeignKeyMetadata":
      return {
        severity: "info",
        title: translate("docs.warnings.noForeignKeyMetadata.title"),
        detail: translate("docs.warnings.noForeignKeyMetadata.detail", { engine: warning.engine }),
      };
    case "commentsUnsupported":
      return {
        severity: "info",
        title: translate("docs.warnings.commentsUnsupported.title"),
        detail: translate("docs.warnings.commentsUnsupported.detail", { engine: warning.engine }),
      };
    case "orphanedNotes":
      return {
        severity: "warning",
        title: translate("docs.warnings.orphanedNotes.title"),
        detail: translate("docs.warnings.orphanedNotes.detail", { count: warning.count }),
      };
    case "dbmlOmitted":
      return {
        severity: "info",
        title: translate("docs.warnings.dbmlOmitted.title"),
        detail: translate("docs.warnings.dbmlOmitted.detail", { item: warning.item, table: warning.table, reason: warning.reason }),
      };
  }
}
