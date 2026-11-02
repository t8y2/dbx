import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugReceipt, PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return { ...actual, saveOpenTabsState: vi.fn(async () => undefined), closeClientConnectionSession: vi.fn(async () => undefined) };
});

import { useQueryStore } from "../queryStore";
import { usePlDebugStore } from "../plDebugStore";
import * as api from "@/lib/backend/api";
import { restoreOpenTabsPayload, serializeOpenTabs } from "@/lib/app/openTabsPersistence";

vi.setConfig({ testTimeout: 30_000 });
let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
let holdClose: boolean;
let loseClose: boolean;
let releaseClose: (() => void) | undefined;
const requests: Array<{ path: string; body: Record<string, any> }> = [];
const receipts = new Map<string, PlDebugReceipt>();
const options = { connectionId: "conn", database: "APP", schema: "APP", title: "P" };

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  pinia = createPinia();
  setActivePinia(pinia);
  holdClose = false;
  loseClose = false;
  releaseClose = undefined;
  requests.length = 0;
  receipts.clear();
  vi.mocked(api.closeClientConnectionSession).mockClear();
  snapshot = {
    serverEpoch: "epoch",
    sessionId: "original",
    connectionId: "conn",
    clientSessionId: "client",
    database: "APP",
    startOperationId: "start",
    generation: 1,
    revision: 2,
    stopRevision: 1,
    state: "paused",
    startState: "succeeded",
    executionOutcome: "pending",
    executionStopped: false,
    transactionOutcome: "pending",
    releaseState: "open",
    runtimeExited: false,
    closing: false,
    activeOperationId: null,
    target: { schema: "APP", objectType: "PROCEDURE", objectName: "P" },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      let result: unknown;
      if (path === "status") result = snapshot;
      else if (path === "operation") result = receipts.get(body.operationId);
      else if (path === "operate") {
        if (holdClose)
          await new Promise<void>((done) => {
            releaseClose = done;
          });
        snapshot = { ...snapshot, revision: snapshot.revision + 1, state: "ended", executionStopped: true, executionOutcome: "cancelled", releaseState: "released", runtimeExited: true };
        result = { serverEpoch: "epoch", sessionId: "original", operationId: body.operationId, generation: 1, revision: snapshot.revision, state: "succeeded", dispatched: true, result: snapshot, error: null } satisfies PlDebugReceipt;
        receipts.set(body.operationId, result as PlDebugReceipt);
        if (loseClose) throw new TypeError("close response lost");
      } else throw new Error(`Unexpected boundary ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

function bindOriginal() {
  const debug = usePlDebugStore();
  debug.sessionRef = { serverEpoch: "epoch", sessionId: "original", connectionId: "conn", clientSessionId: "client" };
  debug.publicSnapshot = snapshot;
  debug.debugId = "original";
  debug.connectionId = "conn";
  debug.database = "APP";
  debug.target = { schema: "APP", objectType: "PROCEDURE", objectName: "P", packageName: null, source: null };
  return debug;
}

describe("one PL/SQL workspace in the existing query store", () => {
  it("focuses the single workspace and does not duplicate its execution identity", () => {
    const store = useQueryStore();
    bindOriginal();
    const id = store.openPlDebugTab(options);
    expect(store.openPlDebugTab({ ...options, connectionId: "other", database: "OTHER", title: "Another target" })).toBe(id);
    store.duplicateTab(id);
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0]).toMatchObject({ mode: "pl-debug", connectionId: "conn", database: "APP", title: "P" });
    expect(store.activeTabId).toBe(id);
    expect(requests).toEqual([]);
  });

  it("waits for confirmed original release and shares one in-flight tab close", async () => {
    const store = useQueryStore();
    bindOriginal();
    const id = store.openPlDebugTab(options);
    holdClose = true;
    store.closeTab(id);
    store.closeTab(id, { force: true });
    await vi.waitFor(() => expect(requests.filter((request) => request.path === "operate")).toHaveLength(1));
    expect(store.tabs.some((tab) => tab.id === id)).toBe(true);
    releaseClose!();
    await vi.waitFor(() => expect(store.tabs).toHaveLength(0));
    expect(api.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("keeps the tab and original close ID after a lost reply, then queries without another close", async () => {
    const store = useQueryStore();
    const debug = bindOriginal();
    const id = store.openPlDebugTab(options);
    loseClose = true;
    store.closeTab(id, { force: true });
    await vi.waitFor(() => expect(debug.error).toContain("close response lost"));
    expect(store.tabs.some((tab) => tab.id === id)).toBe(true);
    expect(debug.pendingClose).not.toBeNull();
    loseClose = false;
    store.closeTab(id);
    await vi.waitFor(() => expect(store.tabs).toHaveLength(0));
    expect(requests.filter((request) => request.path === "operate")).toHaveLength(1);
    expect(debug.pendingClose).toBeNull();
  });

  it("waits for the debugger in close-all before dropping tabs", async () => {
    const store = useQueryStore();
    bindOriginal();
    const id = store.openPlDebugTab(options);
    store.createTab("conn", "APP", "Query", "query");
    holdClose = true;
    store.closeAllTabs();
    await vi.waitFor(() => expect(releaseClose).toBeTypeOf("function"));
    expect(store.tabs).toHaveLength(2);
    releaseClose!();
    await vi.waitFor(() => expect(store.tabs).toHaveLength(0));
    expect(vi.mocked(api.closeClientConnectionSession).mock.calls.every((call) => call[2] !== id)).toBe(true);
  });

  it("protects forced connection-tab cleanup with the same release gate", async () => {
    const store = useQueryStore();
    bindOriginal();
    store.openPlDebugTab(options);
    holdClose = true;
    store.closeConnectionTabs("conn", { force: true });
    await vi.waitFor(() => expect(releaseClose).toBeTypeOf("function"));
    expect(store.tabs).toHaveLength(1);
    releaseClose!();
    await vi.waitFor(() => expect(store.tabs).toHaveLength(0));
    expect(api.closeClientConnectionSession).not.toHaveBeenCalled();
  });

  it("restores only one debugger surface and never persists an execution reference in tabs", () => {
    const store = useQueryStore();
    bindOriginal();
    store.openPlDebugTab(options);
    const saved = serializeOpenTabs(store.tabs);
    expect(saved[0]).not.toHaveProperty("sessionRef");
    expect(saved[0]).not.toHaveProperty("clientSessionId");
    const restored = restoreOpenTabsPayload({ tabs: [saved[0], { ...saved[0], id: "duplicate" }], activeTabId: "duplicate" });
    expect(restored.tabs).toHaveLength(1);
    expect(requests).toEqual([]);
  });

  it("reopens closed-tab history as the same workspace without starting another program", () => {
    const store = useQueryStore();
    const debug = bindOriginal();
    debug.publicSnapshot = { ...snapshot, releaseState: "released", runtimeExited: true, executionStopped: true, executionOutcome: "cancelled" };
    const id = store.openPlDebugTab(options);
    store.closeTab(id);
    expect(store.tabs).toHaveLength(0);
    store.reopenClosedTab();
    const restoredId = store.tabs[0].id;
    expect(store.openPlDebugTab(options)).toBe(restoredId);
    expect(store.tabs).toHaveLength(1);
    expect(requests).toEqual([]);
  });
});
