// @vitest-environment happy-dom

import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));
import { usePlDebugStore } from "@/stores/plDebugStore";

let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
const calls: Array<{ path: string; action?: string }> = [];
const receipts = new Map<string, unknown>();

/** A session that runs to the end, so `hasSession` is false afterwards. */
async function finishedSession() {
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  await store.resume();
  return store;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  calls.length = 0;
  receipts.clear();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(options.body));
      calls.push({ path, action: body.action });
      let result: unknown;
      if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
      else if (path === "start") {
        snapshot = {
          serverEpoch: "epoch",
          sessionId: "d1",
          connectionId: body.connectionId,
          clientSessionId: body.clientSessionId,
          database: body.database,
          startOperationId: body.operationId,
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
          target: body.target,
        };
        result = { ...snapshot, operationId: body.operationId, state: "succeeded", dispatched: true, result: { ...snapshot }, error: null };
        receipts.set(body.operationId, result);
      } else if (path === "operate") {
        snapshot = { ...snapshot, revision: snapshot.revision + 1, state: "ended", executionOutcome: "succeeded", executionStopped: true, terminated: true, ...(body.action === "close" ? { releaseState: "released", runtimeExited: true, transactionOutcome: "rolled_back" } : {}) };
        result = { ...snapshot, operationId: body.operationId, state: "succeeded", dispatched: true, result: { ...snapshot }, error: null };
        receipts.set(body.operationId, result);
      } else if (path === "operation") result = receipts.get(body.operationId);
      else if (path === "status" || path === "heartbeat") result = snapshot;
      else if (path === "read") result = {};
      else throw new Error(`Unexpected boundary ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

// Reported from use (2026-10-13): after the program finished, clicking a line number did
// nothing at all — the store returned early without a word, and the toolbar's only way
// back ("Restart") was disabled because it required a live session too.
describe("a debug session that has finished", () => {
  it("refuses a gutter breakpoint out loud instead of doing nothing", async () => {
    const store = await finishedSession();

    await store.toggleBreakpoint(7);

    expect(calls.some((call) => call.action === "set_breakpoints")).toBe(false);
    const warn = store.history.filter((entry) => entry.level === "WARN").at(-1);
    expect(warn?.message).toContain("breakpoint line 7");
    expect(warn?.message).toContain("restart the debugger");
    expect(store.breakpoints).toEqual([]);
  });

  it("refuses an enable/disable out loud too", async () => {
    const store = await finishedSession();

    await store.setBreakpointEnabled(7, false);

    expect(store.history.filter((entry) => entry.level === "WARN").at(-1)?.message).toContain("no live debug session");
  });

  it("keeps the session handle and target so Restart can replay the launch", async () => {
    const store = await finishedSession();

    // The toolbar's Restart is gated on these, not on `hasSession` (a finished session
    // has none): a missing handle or target would leave the panel a dead end again.
    expect(store.hasSession).toBe(false);
    expect(store.terminated).toBe(true);
    expect(store.debugId).toBe("d1");
    expect(store.connectionId).toBe("c1");
    expect(store.database).toBe("ob");
    expect(store.target?.objectName).toBe("P_DEMO");
  });

  it("confirms release before resetting a finished workspace", async () => {
    const store = await finishedSession();

    await store.close();

    expect(calls.filter((call) => call.action === "close")).toHaveLength(1);
    expect(store.publicSnapshot?.releaseState).toBe("released");
    expect(store.publicSnapshot?.runtimeExited).toBe(true);
    expect(store.debugId).toBe("d1");
    store.reset();
    expect(store.debugId).toBeNull();
    expect(store.target).toBeNull();
    expect(store.history.some((entry) => entry.level === "WARN" && entry.message.includes("close failed"))).toBe(false);
  });
});
