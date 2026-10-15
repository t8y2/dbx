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
import { launchPlDebug } from "@/components/debug/plDebugLaunch";
import * as api from "@/lib/backend/pl-debug-tauri";

const mountedApps: App[] = [];

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
  vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d1", line: "1", program: "P_DEMO", terminated: false });
  vi.mocked(api.plDebugResume).mockResolvedValue({ line: "12", reason: 25, terminated: true });
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  await store.resume();
  return store;
}

function restartButton(root: HTMLElement): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((candidate) => candidate.getAttribute("title") === "plDebug.toolbar.restart");
  if (!found) throw new Error("no restart button");
  return found as HTMLButtonElement;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
  vi.mocked(api.plDebugGetStack).mockResolvedValue({ backtrace: "" });
  vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "" });
  vi.mocked(api.plDebugListBreakpoints).mockResolvedValue([]);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

// Reported from use (2026-10-13): "no restart button, and after it finishes it is
// still stuck" — the restart closed the old session and the launch dialog never
// opened, because the target it re-submitted carried no database type.
describe("PlDebugPanel restart", () => {
  it("re-launches with the connection's database type and only then drops the old session", async () => {
    const store = await finishedRoutineSession();
    vi.mocked(launchPlDebug).mockResolvedValue(true);
    const root = await mountPanel();

    restartButton(root).click();
    await flush();

    expect(launchPlDebug).toHaveBeenCalledWith({
      connectionId: "c1",
      database: "ob",
      databaseType: "oracle",
      schema: "S",
      objectType: "PROCEDURE",
      objectName: "P_DEMO",
      packageName: undefined,
    });
    expect(api.plDebugClose).toHaveBeenCalledWith("d1");
    expect(store.target).toBeNull();
  });

  it("keeps the finished session when the launch gate refuses", async () => {
    const store = await finishedRoutineSession();
    vi.mocked(launchPlDebug).mockResolvedValue(false);
    const root = await mountPanel();

    restartButton(root).click();
    await flush();

    expect(api.plDebugClose).not.toHaveBeenCalled();
    expect(store.target?.objectName).toBe("P_DEMO");
    expect(store.debugId).toBe("d1");
  });
});
