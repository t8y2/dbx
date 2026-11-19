// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("splitpanes", () => ({
  Splitpanes: { template: "<div><slot /></div>" },
  Pane: { template: "<div><slot /></div>" },
}));
vi.mock("splitpanes/dist/splitpanes.css", () => ({}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: { template: "<div><slot /></div>" },
  TabsList: { template: "<div><slot /></div>" },
  TabsTrigger: { template: "<div><slot /></div>" },
  TabsContent: { template: "<div><slot /></div>" },
}));

// The panel's own children are stubbed: this spec drives the panel's refresh wiring,
// not the editors and tables (they have their own coverage).
vi.mock("@/components/debug/DebugToolbar.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/PlDebugSourceEditor.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/VariablesPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/StackTracePanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/BreakpointsPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebuggeeSqlPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugTracePanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugLogPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugOutputPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/PlDebugOutcomePanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/plDebugLaunch", () => ({ launchPlDebug: vi.fn(), resolvePlDebugProbe: vi.fn() }));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

vi.mock("@/lib/backend/pl-debug-tauri", () => ({
  plDebugAbort: vi.fn(),
  plDebugClose: vi.fn(),
  plDebugDeleteBreakpoints: vi.fn(),
  plDebugExecute: vi.fn(),
  plDebugGetLog: vi.fn(),
  plDebugGetStack: vi.fn(),
  plDebugGetVariables: vi.fn(),
  plDebugListBreakpoints: vi.fn(),
  plDebugProbe: vi.fn(),
  plDebugResume: vi.fn(),
  plDebugResumeIgnoreBreakpoints: vi.fn(),
  plDebugSetBreakpoints: vi.fn(),
  plDebugSetExceptionBreakpoint: vi.fn(),
  plDebugSetValue: vi.fn(),
  plDebugStart: vi.fn(),
  plDebugStepIn: vi.fn(),
  plDebugStepOut: vi.fn(),
  plDebugStepOver: vi.fn(),
}));

import PlDebugPanel from "@/components/debug/PlDebugPanel.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";
import type { PlDebugReceipt, PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

const mountedApps: App[] = [];
let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
const reads: string[] = [];
const receipts = new Map<string, PlDebugReceipt>();

/** Enough microtask turns for the watcher callbacks and their awaited reads to settle. */
async function flush(times = 20) {
  for (let index = 0; index < times; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountPanel(waitForReads = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(PlDebugPanel);
  mountedApps.push(app);
  app.mount(root);
  await flush();
  if (waitForReads) {
    await vi.waitFor(() => expect(reads.at(-1)).toBe("log"));
    await flush(60);
  }
  return root;
}

async function liveSession() {
  const store = usePlDebugStore();
  vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d1", line: "1", program: "P_DEMO", reason: 6, terminated: false });
  await store.start("c1", "APP", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}

const variablesRead = () => reads.filter((kind) => kind === "variables").length;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  vi.clearAllMocks();
  reads.length = 0;
  receipts.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(options.body));
      let result: unknown;
      if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
      else if (path === "start" || path === "operate") {
        const control = body.action === "step_over" ? api.plDebugStepOver : body.action === "run_to_end" ? api.plDebugResumeIgnoreBreakpoints : api.plDebugResume;
        const native = path === "start" ? await api.plDebugStart("c1", "APP", body.target) : await control("d1");
        snapshot =
          path === "start"
            ? {
                serverEpoch: "epoch",
                sessionId: "d1",
                connectionId: body.connectionId,
                database: body.database,
                clientSessionId: body.clientSessionId,
                startOperationId: body.operationId,
                generation: 1,
                revision: 2,
                state: "paused",
                executionOutcome: "pending",
                releaseState: "open",
                transactionOutcome: "pending",
                runtimeExited: false,
                closing: false,
                activeOperationId: null,
                executionStopped: false,
                startState: "succeeded",
                stopRevision: 1,
                target: body.target,
                line: native.line,
              }
            : { ...snapshot, revision: snapshot.revision + 1, stopRevision: Number(snapshot.stopRevision) + 1, state: native.terminated ? "ended" : "paused", executionStopped: native.terminated === true, executionOutcome: native.terminated ? "succeeded" : "pending", line: native.line };
        result = { serverEpoch: "epoch", sessionId: "d1", operationId: body.operationId, generation: 1, revision: snapshot.revision, state: "succeeded", dispatched: true, result: snapshot, error: null } satisfies PlDebugReceipt;
        receipts.set(body.operationId, result as PlDebugReceipt);
      } else if (path === "operation") result = receipts.get(body.operationId);
      else if (path === "status") result = snapshot;
      else if (path === "read") {
        reads.push(body.kind);
        const response = body.kind === "variables" ? await api.plDebugGetVariables("d1") : body.kind === "stack" ? await api.plDebugGetStack("d1") : body.kind === "breakpoints" ? { breakpoints: await api.plDebugListBreakpoints("d1") } : await api.plDebugGetLog("d1");
        result = { ...response, stopRevision: snapshot.stopRevision, ...(body.kind === "stack" ? { frames: [] } : {}) };
      } else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
  // The real reads answer with the session's current stop position, so the mocks echo
  // it back instead of pinning a line that would overwrite the stop under test.
  vi.mocked(api.plDebugGetVariables).mockImplementation(async () => ({
    variables: [{ name: "P_A", state: "value", value: "5", type: "NUMBER" }],
    line: String(usePlDebugStore().currentLine ?? 1),
    program: "P_DEMO",
  }));
  vi.mocked(api.plDebugGetStack).mockImplementation(async () => ({ backtrace: "", line: String(usePlDebugStore().currentLine ?? 1), program: "P_DEMO" }));
  vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "" });
  vi.mocked(api.plDebugListBreakpoints).mockResolvedValue([]);
});

afterEach(async () => {
  for (const app of mountedApps.splice(0)) app.unmount();
  await flush(60);
  disposePinia(pinia);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// Reported from use (2026-10-13): "the variables panel stays empty" — the debug tab
// mounts after `start` already parked the program, so nothing ever read the frame.
describe("PlDebugPanel refresh wiring", () => {
  it("reads the frame as soon as it opens on a parked session", async () => {
    const store = await liveSession();
    expect(store.variables).toHaveLength(0);

    await mountPanel();
    await vi.waitFor(() => expect(store.variables).toHaveLength(1));
    expect(variablesRead()).toBe(1);
    expect(store.variables.map((entry) => `${entry.name}=${entry.value}`)).toEqual(["P_A=5"]);
  });

  it("does not re-arm itself from the frame reads it just made", async () => {
    await liveSession();
    await mountPanel();
    expect(variablesRead()).toBe(1);

    // A watcher that followed its own `status` writes would fire on every turn here.
    await flush(60);

    expect(variablesRead()).toBe(1);
  });

  it("refreshes exactly once per stop", async () => {
    const store = await liveSession();
    await mountPanel();
    vi.mocked(api.plDebugStepOver).mockResolvedValue({ line: "2", reason: 9, terminated: false });

    await store.stepOver();
    await vi.waitFor(() => expect(variablesRead()).toBe(2));

    expect(variablesRead()).toBe(2);
    expect(store.currentLine).toBe(2);
  });

  it("refreshes after a resume that stops at a breakpoint once the call is no longer in flight", async () => {
    // The stop lands while `busy` is still true; the refresh must wait for the call's
    // `finally` to release it (every earlier status write is a skip).
    const store = await liveSession();
    await mountPanel();
    vi.mocked(api.plDebugResume).mockResolvedValue({ line: "12", reason: 3, terminated: false });

    await store.resume();
    await flush(60);

    expect(variablesRead()).toBe(2);
    expect(store.currentLine).toBe(12);
  });

  it("reads the DBMS output instead of the frame once the program finished", async () => {
    const store = await liveSession();
    await mountPanel();
    vi.mocked(api.plDebugResumeIgnoreBreakpoints).mockResolvedValue({ line: "12", reason: 25, terminated: true });
    vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "done total=6" });

    await store.resumeIgnoreBreakpoints();
    await flush(60);

    expect(store.output).toBe("done total=6");
    expect(variablesRead()).toBe(1);
  });

  it("serializes variable and stack refreshes on the same native controller", async () => {
    await liveSession();
    let release!: (value: any) => void;
    vi.mocked(api.plDebugGetVariables).mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    await mountPanel(false);
    expect(reads).toEqual(["variables"]);
    release({ variables: [] });
    await vi.waitFor(() => expect(reads).toEqual(["variables", "stack", "breakpoints", "log"]));
    await flush(60);
  });

  it("retains the variable read failure while still loading the stack and output", async () => {
    const store = await liveSession();
    vi.mocked(api.plDebugGetVariables).mockRejectedValueOnce(new Error("native variable read failed"));
    await mountPanel();
    expect(reads).toEqual(["variables", "stack", "breakpoints", "log"]);
    expect(store.variablesState).toBe("error");
    expect(store.variableError).toContain("native variable read failed");
  });

  it("does not continue the refresh chain after the panel unmounts", async () => {
    await liveSession();
    let release!: (value: any) => void;
    vi.mocked(api.plDebugGetVariables).mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done;
        }),
    );
    await mountPanel(false);
    mountedApps.pop()!.unmount();
    release({ variables: [] });
    await flush(100);
    expect(reads).toEqual(["variables"]);
  });
});
