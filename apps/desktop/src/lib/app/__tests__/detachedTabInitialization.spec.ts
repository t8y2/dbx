// @vitest-environment happy-dom
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DetachedTabHandoff } from "@/lib/app/detachedTabHandoff";
import { initializeDetachedTab } from "@/lib/app/detachedTabInitialization";

const backend = vi.hoisted(() => ({
  handoff: undefined as DetachedTabHandoff | undefined,
  emit: vi.fn(),
  saveHandoff: vi.fn(async (_tabId: string, handoff: DetachedTabHandoff) => {
    backend.handoff = JSON.parse(JSON.stringify(handoff));
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: backend.emit }));
vi.mock("@/lib/backend/api", () => ({
  loadEditorSettings: vi.fn(async () => null),
  saveEditorSettings: vi.fn(async () => {}),
  loadSavedSqlEditorPositions: vi.fn(async () => []),
  loadSavedSqlLibrary: vi.fn(async () => ({ folders: [], files: [] })),
  saveTabs: vi.fn(async () => {}),
  saveOpenTabsState: vi.fn(async () => {}),
  loadOpenTabsState: vi.fn(async () => null),
  saveDetachedTabHandoff: backend.saveHandoff,
}));

const instances: Pinia[] = [];
function freshPinia() {
  const pinia = createPinia();
  instances.push(pinia);
  setActivePinia(pinia);
}

beforeEach(() => {
  vi.resetModules();
  backend.handoff = undefined;
  backend.emit.mockReset();
  backend.saveHandoff.mockClear();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("__TAURI_INTERNALS__", {});
});

afterEach(() => {
  for (const pinia of instances.splice(0)) disposePinia(pinia);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("completes the second handoff before a slow connection refresh lets child autosave change its revision", async () => {
  freshPinia();
  const { useQueryStore } = await import("@/stores/queryStore");
  vi.useFakeTimers();
  const main = useQueryStore();
  const tabId = main.createTab("mysql", "demo", "Query", "query", undefined, "SELECT 1;");
  await main.prepareDetachedTab(tabId);
  const handoff = await main.prepareDetachedTab(tabId, { activeOutputView: "result" });
  expect(handoff.revision).toBe(2);
  await main.flushPendingPersist();
  backend.handoff = handoff;

  // A separate webview has its own query store, window context and revision counter.
  vi.resetModules();
  window.history.replaceState({}, "", `/?dbxDetachedTab=${encodeURIComponent(tabId)}`);
  freshPinia();
  const { useQueryStore: useDetachedQueryStore } = await import("@/stores/queryStore");
  const child = useDetachedQueryStore();
  backend.emit.mockImplementation(async (event, data) => {
    expect(event).toBe("dbx:detached-tab-ready");
    // Match the main window's durable-handoff revision check before removing
    // its source tab. An autosave that ran first would make this check fail.
    if (backend.handoff?.tabId === data.tabId && backend.handoff.revision === data.revision) {
      main.removeTabAfterDetachedReady(data.tabId);
    }
  });
  let finishRefresh!: () => void;
  const pendingRefresh = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const refreshConnections = vi.fn(() => pendingRefresh);
  const setActiveOutputView = vi.fn();
  let initialized = false;
  const initialization = initializeDetachedTab(handoff, { queryStore: child, refreshConnections, setActiveOutputView }).then(() => {
    initialized = true;
  });
  await vi.waitFor(() => expect(refreshConnections).toHaveBeenCalledOnce());

  // The real persistence watcher fires after 300 ms while metadata is still
  // pending. It writes the child's first revision, different from the source's.
  await vi.advanceTimersByTimeAsync(350);
  expect(backend.saveHandoff).toHaveBeenCalled();
  expect(backend.handoff?.revision).toBe(1);
  expect(backend.handoff?.sourceWindowLabel).toBe(`detached-tab-${tabId}`);
  expect(main.tabs.some((tab) => tab.id === tabId)).toBe(false);
  expect(initialized).toBe(true);
  expect(child.tabs.find((tab) => tab.id === tabId)?.sql).toBe("SELECT 1;");
  expect(setActiveOutputView).toHaveBeenCalledExactlyOnceWith("result");
  expect(backend.emit).toHaveBeenCalledOnce();

  finishRefresh();
  await initialization;
}, 60_000);

it("keeps a completed handoff usable when the background connection refresh fails", async () => {
  freshPinia();
  const { useQueryStore } = await import("@/stores/queryStore");
  vi.useFakeTimers();
  const main = useQueryStore();
  const tabId = main.createTab("mysql", "demo", "Query", "query", undefined, "SELECT 1;");
  const handoff = await main.prepareDetachedTab(tabId);
  await main.flushPendingPersist();
  freshPinia();
  const child = useQueryStore();
  backend.emit.mockImplementation(async () => {
    main.removeTabAfterDetachedReady(tabId);
  });
  const error = new Error("Connection metadata unavailable");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await initializeDetachedTab(handoff, {
    queryStore: child,
    setActiveOutputView: vi.fn(),
    refreshConnections: vi.fn(async () => {
      throw error;
    }),
  });

  expect(main.tabs).toHaveLength(0);
  expect(child.tabs.find((tab) => tab.id === tabId)?.sql).toBe("SELECT 1;");
  expect(warn).toHaveBeenCalledWith("[DBX] detached connection state refresh failed:", error);
}, 30_000);
