import { describe, expect, it, vi } from "vitest";
import { restoreGlobalNavigationEntry } from "../globalNavigationExecutor";

describe("global navigation executor", () => {
  it("dispatches query and special-page entries to their handlers", async () => {
    const handlers = {
      restoreQuery: vi.fn(async () => true),
      activateSettings: vi.fn(),
      activateDriverStore: vi.fn(),
      activatePluginCenter: vi.fn(),
    };
    await restoreGlobalNavigationEntry({ id: "q", surface: "query", tabId: "tab-1" }, handlers);
    await restoreGlobalNavigationEntry({ id: "s", surface: "settings" }, handlers);
    expect(handlers.restoreQuery).toHaveBeenCalledWith({ id: "q", surface: "query", tabId: "tab-1" });
    expect(handlers.activateSettings).toHaveBeenCalledOnce();
  });

  it("reports a closed query tab as unrestorable", async () => {
    const restored = await restoreGlobalNavigationEntry({ id: "q", surface: "query", tabId: "closed" }, { restoreQuery: async () => false, activateSettings: () => {}, activateDriverStore: () => {}, activatePluginCenter: () => {} });
    expect(restored).toBe(false);
  });
});
