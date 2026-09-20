// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { COMPONENT_PLUGINS_UPDATED_EVENT, COMPONENT_UPDATES_CHANGED_EVENT, notifyComponentPluginsUpdated, notifyComponentUpdatesChanged } from "@/lib/updates/componentUpdateEvents";

describe("component update events", () => {
  it("notifies plugin surfaces after component-level plugin updates", () => {
    const listener = vi.fn();
    window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, listener);

    notifyComponentPluginsUpdated();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, listener);
  });

  it("notifies the app when a management surface changes component state", () => {
    const listener = vi.fn();
    window.addEventListener(COMPONENT_UPDATES_CHANGED_EVENT, listener);

    notifyComponentUpdatesChanged();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(COMPONENT_UPDATES_CHANGED_EVENT, listener);
  });

  it("is inert when the store runs outside a browser environment", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(() => notifyComponentPluginsUpdated()).not.toThrow();
      expect(() => notifyComponentUpdatesChanged()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
