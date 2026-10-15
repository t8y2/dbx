// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
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
  useConnectionStore: () => ({ getConfig: () => ({ db_type: "oracle" }) }),
}));

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

const mountedApps: App[] = [];

/** Enough microtask turns for the watcher callbacks and their awaited reads to settle. */
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

async function liveSession() {
  const store = usePlDebugStore();
  vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d1", line: "1", program: "P_DEMO", reason: 6, terminated: false });
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

const variablesRead = () => vi.mocked(api.plDebugGetVariables).mock.calls.length;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // The real reads answer with the session's current stop position, so the mocks echo
  // it back instead of pinning a line that would overwrite the stop under test.
  vi.mocked(api.plDebugGetVariables).mockImplementation(async () => ({
    variables: [{ name: "P_A", value: "5", type: "NUMBER" }],
    line: String(usePlDebugStore().currentLine ?? 1),
    program: "P_DEMO",
  }));
  vi.mocked(api.plDebugGetStack).mockImplementation(async () => ({ backtrace: "", line: String(usePlDebugStore().currentLine ?? 1), program: "P_DEMO" }));
  vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "" });
  vi.mocked(api.plDebugListBreakpoints).mockResolvedValue([]);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

// Reported from use (2026-10-13): "the variables panel stays empty" — the debug tab
// mounts after `start` already parked the program, so nothing ever read the frame.
describe("PlDebugPanel refresh wiring", () => {
  it("reads the frame as soon as it opens on a parked session", async () => {
    const store = await liveSession();
    expect(store.variables).toHaveLength(0);

    await mountPanel();

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
    await flush(60);

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
});
