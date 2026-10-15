// @vitest-environment happy-dom

import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
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

import DebugToolbar from "@/components/debug/DebugToolbar.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";

const mountedApps: App[] = [];

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
  vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d1", terminated: false, line: "4", program: "P_DEMO" });
  vi.mocked(api.plDebugResume).mockResolvedValue({ line: "12", reason: 25, terminated });
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  if (terminated) await store.resume();
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

// Reported from use (2026-10-13): once the program finished, every toolbar button was
// grey — including "Restart debugging", the one that gets you going again.
describe("DebugToolbar gating", () => {
  it("keeps Restart debugging clickable while the session is live", async () => {
    await startSession(false);
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(false);
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
    // An anonymous block has no routine name and no dialog, but its source is on the
    // target and is resubmitted by the panel — so the button must not be gated away.
    const store = usePlDebugStore();
    vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d2", terminated: false, line: "1", program: null });
    vi.mocked(api.plDebugResume).mockResolvedValue({ line: "1", reason: 25, terminated: true });
    await store.start("c1", "ob", { objectType: "ANONYMOUS", source: "begin dbms_output.put_line('x'); end;" });
    await store.resume();
    const root = await mountToolbar();

    expect(button(root, "plDebug.toolbar.restart").disabled).toBe(false);
    expect(button(root, "plDebug.toolbar.restart").textContent?.trim()).toBe("plDebug.toolbar.restart");
  });
});
