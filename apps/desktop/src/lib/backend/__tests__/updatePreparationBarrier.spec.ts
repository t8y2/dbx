import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("update preparation command barrier", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("lets the macOS/Linux restart reach Tauri while the barrier is held", async () => {
    const { relaunchApp } = await import("@/lib/backend/tauri");
    const { acquireUpdateBarrier } = await import("@/lib/app/updatePreparation");
    // prepare() succeeded and deliberately keeps every window frozen until exit.
    const release = acquireUpdateBarrier();
    try {
      await expect(relaunchApp()).resolves.toBeUndefined();
      expect(mocks.invoke).toHaveBeenCalledWith("relaunch_app", undefined);
    } finally {
      release();
    }
  });

  it("still rejects non-durable commands while the barrier is held", async () => {
    const { loadOpenTabsState } = await import("@/lib/backend/tauri");
    const { acquireUpdateBarrier } = await import("@/lib/app/updatePreparation");
    const release = acquireUpdateBarrier();
    try {
      await expect(loadOpenTabsState()).rejects.toThrow("Update preparation is in progress. Please wait.");
      expect(mocks.invoke).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});
