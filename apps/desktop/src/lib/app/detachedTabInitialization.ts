import { emit } from "@tauri-apps/api/event";
import type { DetachedTabHandoff, DetachedOutputView } from "@/lib/app/detachedTabHandoff";

interface DetachedTabInitialization {
  queryStore: {
    adoptDetachedTab(handoff: DetachedTabHandoff): Promise<string>;
    hydrateSavedSqlTabs(): Promise<void>;
  };
  setActiveOutputView(view: DetachedOutputView): void;
  refreshConnections(): Promise<void>;
}

export async function initializeDetachedTab(handoff: DetachedTabHandoff, initialization: DetachedTabInitialization): Promise<void> {
  await initialization.queryStore.adoptDetachedTab(handoff);
  await initialization.queryStore.hydrateSavedSqlTabs();
  if (handoff.runtime.activeOutputView) initialization.setActiveOutputView(handoff.runtime.activeOutputView);
  // Release the source tab before unrelated connection metadata can delay the
  // handoff. The child starts autosaving after adoption, which can replace the
  // durable handoff revision while a slow connection snapshot is still pending.
  await emit("dbx:detached-tab-ready", { tabId: handoff.tabId, revision: handoff.revision });
  void initialization.refreshConnections().catch((error) => {
    console.warn("[DBX] detached connection state refresh failed:", error);
  });
}
