import type { QueryTab } from "@/types/database";
import type { SavedOpenTab } from "@/lib/app/openTabsPersistence";

export type DetachedOutputView = "result" | "summary" | "explain" | "chart" | "messages";

export interface DetachedTabRuntimeState {
  editorViewport?: QueryTab["editorViewport"];
  editorSelection?: QueryTab["editorSelection"];
  txnSessionId?: string;
  txnAutoRolledBack?: boolean;
  oracleTxnPossiblyDirty?: boolean;
  activeOutputView?: DetachedOutputView;
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
