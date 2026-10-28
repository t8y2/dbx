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

vi.mock("@/components/debug/PlDebugSourceEditor.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/VariablesPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/StackTracePanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/BreakpointsPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebuggeeSqlPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugTracePanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugLogPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/DebugOutputPanel.vue", () => ({ default: { template: "<div />" } }));
vi.mock("@/components/debug/PlDebugOutcomePanel.vue", () => ({ default: { template: "<div />" } }));

vi.mock("@/components/debug/plDebugLaunch", () => ({
  launchPlDebug: vi.fn(),
  resolvePlDebugProbe: vi.fn(),
}));

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
import { launchPlDebug } from "@/components/debug/plDebugLaunch";
import * as api from "@/lib/backend/pl-debug-tauri";
import type { PlDebugReceipt, PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

const mountedApps: App[] = [];
let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
let loseRestart: boolean;
const calls: Array<{ path: string; body: Record<string, any> }> = [];
const receipts = new Map<string, PlDebugReceipt>();

async function flush(times = 20) {
  for (let index = 0; index < times; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
}

async function mountPanel() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(PlDebugPanel);
  mountedApps.push(app);
  app.mount(root);
  await flush();
  return root;
}

async function finishedRoutineSession() {
  const store = usePlDebugStore();
  await store.start("c1", "APP", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  await store.close();
  return store;
}

function restartButton(root: HTMLElement): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((candidate) => candidate.getAttribute("title") === "plDebug.toolbar.restart");
  if (!found) throw new Error("no restart button");
  return found as HTMLButtonElement;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  calls.length = 0;
  receipts.clear();
  loseRestart = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(options.body));
      calls.push({ path, body });
      let result: unknown;
      if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
      else if (path === "start" || path === "operate") {
        const closing = body.action === "close";
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
              }
            : {
                ...snapshot,
                generation: snapshot.generation + (body.action === "restart" ? 1 : 0),
                revision: snapshot.revision + 1,
                state: closing ? "ended" : "paused",
                executionOutcome: closing ? "cancelled" : "pending",
                executionStopped: closing,
                releaseState: closing ? "released" : "open",
                runtimeExited: closing,
              };
        result = { serverEpoch: "epoch", sessionId: "d1", operationId: body.operationId, generation: snapshot.generation, revision: snapshot.revision, state: "succeeded", dispatched: true, result: snapshot, error: null } satisfies PlDebugReceipt;
        receipts.set(body.operationId, result as PlDebugReceipt);
        if (body.action === "restart" && loseRestart) throw new TypeError("restart response lost");
      } else if (path === "operation") result = receipts.get(body.operationId);
      else if (path === "status") result = snapshot;
      else if (path === "read") result = body.kind === "log" ? { output: "" } : { stopRevision: snapshot.stopRevision, variables: [], frames: [], breakpoints: [] };
      else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
  vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
  vi.mocked(api.plDebugGetStack).mockResolvedValue({ backtrace: "" });
  vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "" });
  vi.mocked(api.plDebugListBreakpoints).mockResolvedValue([]);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  disposePinia(pinia);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("PlDebugPanel restart", () => {
  it("uses the original restart action and retains the named target", async () => {
    const store = await finishedRoutineSession();
    const root = await mountPanel();

    restartButton(root).click();
    await vi.waitFor(() => expect(store.publicSnapshot?.generation).toBe(2));
    expect(launchPlDebug).not.toHaveBeenCalled();
    expect(api.plDebugClose).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["close", "restart"]);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(store.target?.objectName).toBe("P_DEMO");
    expect(store.debugId).toBe("d1");
  });

  it("keeps the original identity and exposes a lost restart response", async () => {
    const store = await finishedRoutineSession();
    loseRestart = true;
    const root = await mountPanel();

    restartButton(root).click();
    await vi.waitFor(() => expect(store.recoveryRequired).toBe(true));

    expect(api.plDebugClose).not.toHaveBeenCalled();
    expect(store.target?.objectName).toBe("P_DEMO");
    expect(store.debugId).toBe("d1");
    expect(Object.keys(store.pendingOperations)).toHaveLength(1);
    expect(root.textContent).toContain("restart response lost");
    expect(calls.filter((call) => call.path === "operate" && call.body.action === "restart")).toHaveLength(1);
  });
});
