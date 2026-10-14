// @vitest-environment happy-dom
import { createApp, nextTick } from "vue";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import WorkspaceWindowStartup from "../WorkspaceWindowStartup.vue";
import { reportWorkspaceStartupError, WORKSPACE_STARTUP_READY_EVENT } from "@/lib/tabs/workspaceTabTransfer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen: mocks.listen }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/StartupGate.vue", () => ({ __esModule: true, default: { template: "<div data-workspace-app>workspace</div>" } }));

describe("workspace startup preview", () => {
  let host: HTMLDivElement;
  let cleanup: (() => void) | undefined;
  async function flushPromises() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await nextTick();
  }
  function mount() {
    host = document.createElement("div");
    const app = createApp(WorkspaceWindowStartup);
    app.mount(host);
    cleanup = () => app.unmount();
  }
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    window.history.replaceState(null, "", "/?dbxWorkspace=one&dbxWorkspaceTransfer=one");
    mocks.listen.mockResolvedValue(() => {});
    mocks.invoke.mockResolvedValue({ title: "SQL draft", status: "pending" });
  });
  afterEach(() => {
    cleanup?.();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });
  it("shows the title while keeping the application hidden until committed", async () => {
    mount();
    await flushPromises();
    expect(host.querySelector("[data-workspace-startup]")?.textContent).toContain("SQL draft");
    expect(host.querySelector<HTMLElement>("[inert]")?.style.display).toBe("none");
    mocks.invoke.mockResolvedValue({ status: "committed" });
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(host.querySelector("[data-workspace-startup]")).toBeNull();
    expect(host.querySelector("[inert]")).toBeNull();
  });
  it("offers retry and close after cancellation without closing automatically", async () => {
    mocks.invoke.mockResolvedValue({ title: "SQL", status: "cancelled" });
    mount();
    await flushPromises();
    expect(host.textContent).toContain("tabs.workspaceTransferCancelled");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "common.retry")!;
    retry.click();
    await flushPromises();
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", { operation: "retry", id: "one" });
    host.querySelector<HTMLButtonElement>('button[aria-label="common.close"]')!.click();
    expect(mocks.invoke).toHaveBeenCalledWith("close_workspace_startup");
  });
  it("displays the initialization error and cancels the handoff", async () => {
    mount();
    await flushPromises();
    mocks.invoke.mockResolvedValue({ status: "cancelled" });
    reportWorkspaceStartupError(new Error("disk unavailable"));
    await flushPromises();
    expect(host.textContent).toContain("disk unavailable");
    expect(mocks.invoke).toHaveBeenCalledWith("workspace_tab_transfer", { operation: "reject", id: "one" });
  });

  it("allows closing while the initial application is still loading", async () => {
    mount();
    await flushPromises();
    host.querySelector<HTMLButtonElement>('button[aria-label="common.close"]')!.click();
    expect(mocks.invoke).toHaveBeenCalledWith("close_workspace_startup");
  });

  it("keeps an already committed handoff when failure reporting races the commit", async () => {
    mount();
    await flushPromises();
    mocks.invoke.mockResolvedValue({ status: "committed" });
    reportWorkspaceStartupError(new Error("late startup error"));
    await flushPromises();
    expect(host.querySelector("[data-workspace-startup]")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("close_workspace_startup");
  });

  it("shows the committed workspace if the source acknowledges before inspection returns", async () => {
    let rejectInspection!: (error: Error) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectInspection = reject;
    }));
    mount();
    await flushPromises();

    window.dispatchEvent(new Event(WORKSPACE_STARTUP_READY_EVENT));
    await flushPromises();
    rejectInspection(new Error("Tab transfer expired or unavailable"));
    await flushPromises();

    expect(host.querySelector("[data-workspace-startup]")).toBeNull();
  });
});
