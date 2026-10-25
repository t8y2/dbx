import { watch } from "vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { QueryTab } from "@/types/database";

/** Window event asking the main window to detach a freshly opened table tab. */
export const DETACH_TAB_REQUEST_EVENT = "dbx:detach-tab-request";

export interface DetachTabRequestDetail {
  tabId: string;
}

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
  const settled = () => {
    const tab = getTab();
    return !!tab && !tab.isExecuting && !tab.isCancelling && tab.result !== undefined;
  };
  if (settled()) {
    dispatch({ tabId: getTab()!.id });
    return;
  }
  const stop = watch(
    settled,
    (done, onCleanup) => {
      // A load that errors or a tab that closes before settling must not
      // leave the watcher alive forever.
      const tab = getTab();
      if (!tab) {
        stop();
        return;
      }
      if (!done) return;
      stop();
      dispatch({ tabId: tab.id });
    },
    { flush: "post" },
  );
}
