import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return unlisten;
  }),
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
    unlisten.mockClear();
  });

  it("routes the native macOS close-tab menu event to the active surface", async () => {
    const closeActiveSurface = vi.fn();
    const events = useTauriEvents({
      openTableTarget: vi.fn(),
      openSqlFilePath: vi.fn(),
      openDbFilePath: vi.fn(),
      openConnectionDeepLink: vi.fn(),
      closeActiveSurface,
    });

    events.setupTauriListeners();
    await vi.waitFor(() => expect(listeners.has("dbx-close-active-tab")).toBe(true));
    listeners.get("dbx-close-active-tab")!({ payload: undefined });

    expect(closeActiveSurface).toHaveBeenCalledOnce();
    events.cleanupTauriListeners();
    expect(unlisten).toHaveBeenCalled();
  });
});
