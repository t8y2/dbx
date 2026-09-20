// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { COMPONENT_PLUGINS_UPDATED_EVENT, notifyComponentPluginsUpdated } from "@/lib/updates/componentUpdateEvents";

describe("component update events", () => {
  it("notifies plugin surfaces after component-level plugin updates", () => {
    const listener = vi.fn();
    window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, listener);

    notifyComponentPluginsUpdated();

    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, listener);
  });
});
