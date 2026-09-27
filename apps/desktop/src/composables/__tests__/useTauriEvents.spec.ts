import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();
let listenerRegistrationBarrier: Promise<void> | null = null;
const listen = vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
  await listenerRegistrationBarrier;
  listeners.set(event, handler);
  return unlisten;
});

vi.mock("@tauri-apps/api/event", () => ({
  listen,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ connections: [], initFromDisk: vi.fn(), getConfig: vi.fn(), ensureConnected: vi.fn() }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ createTab: vi.fn(), showExecutedQueryResults: vi.fn() }),
}));

import { useTauriEvents } from "@/composables/useTauriEvents";

describe("useTauriEvents", () => {
  beforeEach(() => {
    listeners.clear();
    listen.mockClear();
    unlisten.mockClear();
    listenerRegistrationBarrier = null;
  });

  it("resolves setup only after every native listener is registered", async () => {
    let releaseRegistration!: () => void;
    listenerRegistrationBarrier = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const events = useTauriEvents({
      openTableTarget: vi.fn(),
      openSqlFilePath: vi.fn(),
      openDbFilePath: vi.fn(),
      openConnectionDeepLink: vi.fn(),
      openAiConfigDeepLink: vi.fn(),
      openPluginInstallDeepLink: vi.fn(),
      closeActiveSurface: vi.fn(),
      refreshPluginWorkbenches: vi.fn(),
    });

    let setupResolved = false;
    const setup = events.setupTauriListeners().then(() => {
      setupResolved = true;
    });
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    expect(setupResolved).toBe(false);
    expect(listeners.size).toBe(0);

    releaseRegistration();
    await setup;

    expect(setupResolved).toBe(true);
    expect(listeners.has("dbx-open-connection-links")).toBe(true);
  });

  it("routes the native macOS close-tab menu event to the active surface", async () => {
    const closeActiveSurface = vi.fn();
    const events = useTauriEvents({
      openTableTarget: vi.fn(),
      openSqlFilePath: vi.fn(),
      openDbFilePath: vi.fn(),
      openConnectionDeepLink: vi.fn(),
      closeActiveSurface,
      refreshPluginWorkbenches: vi.fn(),
    });

    await events.setupTauriListeners();
    listeners.get("dbx-close-active-tab")!({ payload: undefined });

    expect(closeActiveSurface).toHaveBeenCalledOnce();
    events.cleanupTauriListeners();
    expect(unlisten).toHaveBeenCalled();
  });

  it("forwards replaced plugin runtimes to the workbench refresh hook", async () => {
    const refreshPluginWorkbenches = vi.fn();
    const events = useTauriEvents({
      openTableTarget: vi.fn(),
      openSqlFilePath: vi.fn(),
      openDbFilePath: vi.fn(),
      openConnectionDeepLink: vi.fn(),
      closeActiveSurface: vi.fn(),
      refreshPluginWorkbenches,
    });

    await events.setupTauriListeners();
    listeners.get("plugin-runtime-replaced")!({ payload: { pluginId: "io.example.plugin", version: "0.2.0" } });

    expect(refreshPluginWorkbenches).toHaveBeenCalledExactlyOnceWith("io.example.plugin");
    events.cleanupTauriListeners();
  });
});
