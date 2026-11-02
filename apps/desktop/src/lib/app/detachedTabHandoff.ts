import type { QueryTab, TabOutputView } from "@/types/database";
import type { SavedOpenTab } from "@/lib/app/openTabsPersistence";

export type DetachedOutputView = TabOutputView;

export interface DetachedTabRuntimeState {
  editorViewport?: QueryTab["editorViewport"];
  editorSelection?: QueryTab["editorSelection"];
  txnSessionId?: string;
  txnAutoRolledBack?: boolean;
  txnPossiblyDirty?: boolean;
  /** Legacy key from before the #9018 rename. Handoffs persist to disk
   *  (DETACHED_TABS_STATE_KEY), so payloads written by older builds may still
   *  carry it; run restored runtimes through normalizeDetachedTabRuntime. */
  oracleTxnPossiblyDirty?: boolean;
  activeOutputView?: DetachedOutputView;
}

/** Migrates a restored handoff runtime: prefer the renamed key, fall back to
 *  the pre-#9018 key, and drop the legacy field so it never leaks onto a tab. */
export function normalizeDetachedTabRuntime(runtime: DetachedTabRuntimeState): DetachedTabRuntimeState {
  const { oracleTxnPossiblyDirty, ...rest } = runtime;
  if (rest.txnPossiblyDirty === undefined && oracleTxnPossiblyDirty !== undefined) {
    rest.txnPossiblyDirty = oracleTxnPossiblyDirty;
  }
  return rest;
}

export interface DetachedTabHandoff {
  schemaVersion: 1;
  tabId: string;
  sourceWindowLabel: string;
  revision: number;
  tab: SavedOpenTab;
  runtime: DetachedTabRuntimeState;
  resultCacheKey?: string;
  updatedAt: number;
}
