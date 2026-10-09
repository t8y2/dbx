import { describe, expect, it, vi } from "vitest";
import { useHistoryRetentionSetting } from "../useHistoryRetentionSetting";

vi.mock("@/lib/backend/api", () => ({
  loadHistoryRetentionLimit: vi.fn(),
  saveHistoryRetentionLimit: vi.fn(),
}));

describe("injected MCP history retention endpoints", () => {
  it("loads, saves unlimited, and resets through the independent endpoints", async () => {
    const loadMcp = vi.fn().mockResolvedValue(5000);
    const saveMcp = vi.fn().mockResolvedValue(undefined);
    const setting = useHistoryRetentionSetting(loadMcp, saveMcp);
    await setting.load();
    expect(loadMcp).toHaveBeenCalledOnce();
    expect(setting.draft.value).toBe(5000);
    expect(setting.changed.value).toBe(false);
    setting.draft.value = 0;
    await setting.save();
    expect(saveMcp).toHaveBeenLastCalledWith(0);
    expect(setting.changed.value).toBe(false);
    setting.reset();
    expect(setting.draft.value).toBe(1000);
    expect(setting.changed.value).toBe(true);
    await setting.save();
    expect(saveMcp).toHaveBeenLastCalledWith(1000);
  });

  it("does not overwrite the server setting after a failed load", async () => {
    const saveMcp = vi.fn();
    const setting = useHistoryRetentionSetting(vi.fn().mockRejectedValue(new Error("offline")), saveMcp);
    await setting.load();
    expect(setting.loadError.value).toBe("offline");
    setting.draft.value = 200;
    await setting.save();
    expect(saveMcp).not.toHaveBeenCalled();
    expect(setting.loaded.value).toBe(false);
  });

  it("keeps failed saves dirty so they can be retried", async () => {
    const saveMcp = vi.fn().mockRejectedValueOnce(new Error("write failed")).mockResolvedValue(undefined);
    const setting = useHistoryRetentionSetting(vi.fn().mockResolvedValue(1000), saveMcp);
    await setting.load();
    setting.draft.value = 200;
    await expect(setting.save()).rejects.toThrow("write failed");
    expect(setting.saving.value).toBe(false);
    expect(setting.changed.value).toBe(true);
    await setting.save();
    expect(setting.changed.value).toBe(false);
  });
});
