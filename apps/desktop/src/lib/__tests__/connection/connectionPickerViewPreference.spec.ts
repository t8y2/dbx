import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_PICKER_VIEW_STORAGE_KEY, loadConnectionPickerView, normalizeConnectionPickerView, saveConnectionPickerView } from "@/lib/connection/connectionPickerViewPreference";

const storage = new Map<string, string>();

describe("connection picker view preference", () => {
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("defaults missing and invalid values to icon view", () => {
    expect(loadConnectionPickerView()).toBe("icon");
    expect(normalizeConnectionPickerView("unknown")).toBe("icon");
  });

  it("persists and restores list view", () => {
    saveConnectionPickerView("list");

    expect(storage.get(CONNECTION_PICKER_VIEW_STORAGE_KEY)).toBe("list");
    expect(loadConnectionPickerView()).toBe("list");
  });

  it("persists and restores icon view", () => {
    saveConnectionPickerView("icon");

    expect(loadConnectionPickerView()).toBe("icon");
  });
});
