import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";

export type ObjectBrowserRowAction = "table-info" | "open-table" | "open-source" | "none";

/**
 * Determine the action for a single click on an object browser row.
 * - TABLE → table-info (show table properties panel)
 * - VIEW/MATERIALIZED_VIEW/PROCEDURE/FUNCTION/TRIGGER/SEQUENCE/PACKAGE/PACKAGE_BODY/TYPE/TYPE_BODY → open-source
 * - otherwise → none
 */
export function singleClickRowAction(row: ObjectBrowserRow | null | undefined): ObjectBrowserRowAction {
  if (!row) return "none";
  if (row.type === "TABLE") return "table-info";
  if (canOpenSource(row)) return "open-source";
  return "none";
}

/**
 * Determine the action for a double click on an object browser row.
 * - TABLE → open-table (open table data tab)
 * - VIEW/MATERIALIZED_VIEW/PROCEDURE/FUNCTION/TRIGGER/SEQUENCE/PACKAGE/PACKAGE_BODY/TYPE/TYPE_BODY → open-source
 * - otherwise → none
 */
export function doubleClickRowAction(row: ObjectBrowserRow | null | undefined): ObjectBrowserRowAction {
  if (!row) return "none";
  if (row.type === "TABLE") return "open-table";
  if (canOpenSource(row)) return "open-source";
  return "none";
}

/**
 * Resolve a row click event into a single or double action based on click detail
 * and the sidebar activation setting.
 *
 * In both single-click and double-click activation modes, a single click
 * triggers the side-panel action (table-info / open-source). When a distinct
 * double-click action exists (e.g. TABLE single→table-info, double→open-table),
 * the caller defers the single-click via shouldDeferSingleClick so the second
 * click can cancel it.
 */
export function resolveRowClickAction(row: ObjectBrowserRow | null | undefined, detail: number, activation: "single" | "double"): { action: ObjectBrowserRowAction; isDouble: boolean } {
  if (activation === "double") {
    if (detail === 2) return { action: doubleClickRowAction(row), isDouble: true };
    return { action: singleClickRowAction(row), isDouble: false };
  }
  // single-click activation
  if (detail > 1) return { action: doubleClickRowAction(row), isDouble: true };
  return { action: singleClickRowAction(row), isDouble: false };
}

/**
 * Whether a single-click action should be deferred to distinguish it from a
 * possible upcoming double-click. Applies when the row's single-click and
 * double-click actions differ (e.g. TABLE: single → table-info, double →
 * open-table). For rows whose single and double actions are identical
 * (e.g. VIEW → open-source both), no deferral is needed.
 */
export function shouldDeferSingleClick(row: ObjectBrowserRow | null | undefined, action: ObjectBrowserRowAction): boolean {
  if (action === "none") return false;
  const single = singleClickRowAction(row);
  const double = doubleClickRowAction(row);
  return single !== double && action === single;
}

/**
 * Objects with source metadata but no supported object-browser mutation API.
 * Their menu intentionally exposes only source viewing and copying.
 */
export function isSourceOnlyObjectBrowserRow(row: ObjectBrowserRow): boolean {
  return row.type === "TRIGGER" || row.type === "SEQUENCE" || row.type === "PACKAGE" || row.type === "PACKAGE_BODY" || row.type === "TYPE" || row.type === "TYPE_BODY";
}

function canOpenSource(row: ObjectBrowserRow): boolean {
  return row.type === "VIEW" || row.type === "MATERIALIZED_VIEW" || row.type === "PROCEDURE" || row.type === "FUNCTION" || row.type === "TRIGGER" || row.type === "SEQUENCE" || row.type === "PACKAGE" || row.type === "PACKAGE_BODY" || row.type === "TYPE" || row.type === "TYPE_BODY";
}
