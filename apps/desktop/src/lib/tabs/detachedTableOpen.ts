import { watch } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { QueryTab } from "@/types/database";

/** Window event asking the main window to detach a freshly opened table tab. */
export const DETACH_TAB_REQUEST_EVENT = "dbx:detach-tab-request";

export interface DetachTabRequestDetail {
  tabId: string;
}

/** Terminal/intermediate states of the settle check the watcher observes. */
type DetachSettleState = "gone" | "settled" | "loading";

/**
 * Schedules a detach for a table opened from the sidebar while the
 * "open tables in a detached window" setting is on (#13308). The tab's result
 * must be cached before the existing detach path accepts it, so the request
 * fires once the first load settles (result present and nothing executing),
 * or immediately when the tab already settled.
 */
export function requestDetachedTableOpen(
  getTab: () => QueryTab | undefined,
  dispatch: (detail: DetachTabRequestDetail) => void = (detail) => {
    window.dispatchEvent(new CustomEvent<DetachTabRequestDetail>(DETACH_TAB_REQUEST_EVENT, { detail }));
  },
): void {
  // Detached windows are desktop-only; the settings dialog also renders on
  // web, so the dispatch itself must be gated, not just the window opener.
  if (!isTauriRuntime()) return;
  // Tri-state, not boolean: a getter-watcher only re-runs its callback when the
  // value changes, so "loading" and "gone" must differ, or a load that ends
  // without a result followed by the tab closing would never stop the watcher.
  const settleState = (): DetachSettleState => {
    const tab = getTab();
    if (!tab) return "gone";
    if (!tab.isExecuting && !tab.isCancelling && tab.result !== undefined) return "settled";
    return "loading";
  };
  if (settleState() === "settled") {
    dispatch({ tabId: getTab()!.id });
    return;
  }
  const stop = watch(
    settleState,
    (state) => {
      // A load that errors without a result or a tab that closes before
      // settling must not leave the watcher alive forever.
      if (state === "loading") return;
      stop();
      if (state === "settled") dispatch({ tabId: getTab()!.id });
    },
    { flush: "post" },
  );
}
