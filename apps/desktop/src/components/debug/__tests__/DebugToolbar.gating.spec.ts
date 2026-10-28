// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: vi.fn() }));

import DebugToolbar from "@/components/debug/DebugToolbar.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

const mountedApps: App[] = [];
let pinia: ReturnType<typeof createPinia>;

async function mountToolbar() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(DebugToolbar);
  mountedApps.push(app);
  app.mount(root);
  for (let index = 0; index < 10; index += 1) {
    await nextTick();
    await Promise.resolve();
  }
  return root;
}

function button(root: HTMLElement, title: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((candidate) => candidate.getAttribute("title") === title);
  if (!found) throw new Error(`no button titled ${title}`);
  return found as HTMLButtonElement;
}

async function startSession(terminated: boolean) {
  const store = usePlDebugStore();
  store.sessionRef = { serverEpoch: "epoch", sessionId: "d1", connectionId: "c1", clientSessionId: store.clientSessionId };
  store.publicSnapshot = {
    ...store.sessionRef,
    generation: 1,
    revision: 2,
    state: terminated ? "ended" : "paused",
    executionStopped: terminated,
    executionOutcome: terminated ? "succeeded" : "pending",
    releaseState: terminated ? "released" : "open",
    runtimeExited: terminated,
    activeOperationId: null,
  } as PlDebugSnapshot;
  store.debugId = "d1";
  store.connectionId = "c1";
  store.database = "APP";
  store.target = { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO", packageName: null, source: null };
  store.terminated = terminated;
  return store;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  disposePinia(pinia);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// Reported from use (2026-10-13): once the program finished, every toolbar button was
// grey — including "Restart debugging", the one that gets you going again.
describe("DebugToolbar gating", () => {
  it("allows explicit cleanup while business work is busy and blocks duplicate close submission", async () => {
    const store = await startSession(false);
    store.busy = true;
    const root = await mountToolbar();
    expect(button(root, "plDebug.toolbar.resume").disabled).toBe(true);
    expect(button(root, "plDebug.toolbar.close").disabled).toBe(false);
    store.closeBusy = true;
    await nextTick();
    expect(button(root, "plDebug.toolbar.close").disabled).toBe(true);
  });
  it.each(["unknown", "running"] as const)("labels a %s public snapshot without relying on a local request", async (state) => {
    const store = await startSession(false);
    store.publicSnapshot = { ...store.publicSnapshot!, state };
    const root = await mountToolbar();
    expect(root.textContent).toContain(`plDebug.state.${state}`);
    expect(root.textContent).not.toContain("plDebug.state.paused");
    expect(button(root, "plDebug.toolbar.resume").disabled).toBe(true);
  });

  it("explains a version-limited exception switch while keeping normal controls available", async () => {
    const store = await startSession(false);
    store.status = { capabilities: { exceptions: { status: "unsupported", canAttempt: false, message: "Exception flags are unavailable in this version" } } };
    const root = await mountToolbar();
    const toggle = root.querySelector<HTMLButtonElement>("#pl-debug-exception-breakpoint")!;
    expect(toggle.disabled).toBe(true);
    expect(root.querySelector("#pl-debug-exception-breakpoint-reason")?.textContent).toContain("unavailable in this version");
    expect(toggle.getAttribute("aria-describedby")).toBe("pl-debug-exception-breakpoint-reason");
    expect(button(root, "plDebug.toolbar.resume").disabled).toBe(false);
    store.exceptionBreakpoint = true;
    await nextTick();
    expect(toggle.disabled).toBe(false);
  });

  it("does not infer unsupported exception flags from an older agent with no capability field", async () => {
    await startSession(false);
    const root = await mountToolbar();
    expect(root.querySelector<HTMLButtonElement>("#pl-debug-exception-breakpoint")!.disabled).toBe(false);
  });

  it("requires the live execution to stop and release before restart", async () => {
    await startSession(false);
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(true);
    expect(button(root, "plDebug.toolbar.resume").disabled).toBe(false);
  });

  it("keeps Restart debugging clickable after the program finished", async () => {
    await startSession(true);
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(false);
    // The stepping buttons are correctly dead: there is nothing left to step.
    expect(button(root, "plDebug.toolbar.resume").disabled).toBe(true);
    expect(button(root, "plDebug.toolbar.stepOver").disabled).toBe(true);
  });

  it("keeps Close clickable after the program finished", async () => {
    // Closing is how the user leaves a finished session; requiring a live session made
    // the panel a dead end.
    await startSession(true);
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.close").disabled).toBe(false);
  });

  it("shows a labelled Restart debugging button once the session finished", async () => {
    // The icon-only button was reported as "there is no restart button" (2026-10-13): a
    // finished session disables every other control, so the way back must be readable.
    await startSession(true);
    const root = await mountToolbar();

    const restart = button(root, "plDebug.toolbar.restart");
    expect(restart.textContent?.trim()).toBe("plDebug.toolbar.restart");
  });

  it("keeps the restart control icon-only while the session is live", async () => {
    await startSession(false);
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").textContent?.trim()).toBe("");
  });

  it("says the session finished next to the state label", async () => {
    await startSession(true);
    const root = await mountToolbar();

    expect(root.textContent).toContain("plDebug.toolbar.finishedHint");
  });

  it("disables Restart debugging while a call is in flight", async () => {
    const store = await startSession(false);
    const root = await mountToolbar();
    store.busy = true;
    await nextTick();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(true);
  });

  it("keeps Restart debugging clickable for a finished anonymous block", async () => {
    const store = await startSession(true);
    store.target = { schema: null, objectName: null, packageName: null, objectType: "ANONYMOUS", source: "begin dbms_output.put_line('x'); end;" };
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(false);
    expect(button(root, "plDebug.toolbar.restart").textContent?.trim()).toBe("plDebug.toolbar.restart");
  });

  it.each(["open", "releasing", "unknown"] as const)("does not enable restart for %s resources", async (releaseState) => {
    const store = await startSession(true);
    store.publicSnapshot = { ...store.publicSnapshot!, releaseState };
    const root = await mountToolbar();
    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(true);
  });

  it("does not enable restart for an unknown execution or lost identity", async () => {
    const store = await startSession(true);
    store.publicSnapshot = { ...store.publicSnapshot!, executionOutcome: "unknown" };
    const root = await mountToolbar();
    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(true);
    store.publicSnapshot = { ...store.publicSnapshot!, executionOutcome: "succeeded" };
    store.recoveryRequired = true;
    await nextTick();
    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(true);
  });
});
