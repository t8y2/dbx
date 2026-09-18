import { describe, expect, it } from "vitest";
import { isCcSwitchPluginAvailable } from "@/lib/ai/ccSwitch";
import type { InstalledPlugin } from "@/types/database";

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    manifest: {
      id: "cc-switch",
      name: "CC-SWITCH Config Import",
      drivers: [],
      capabilities: [{ id: "ai-config-import", label: "AI configuration import" }],
      ...overrides.manifest,
    },
    compatibility: { compatible: true },
    ...overrides,
  };
}

describe("isCcSwitchPluginAvailable", () => {
  it("requires the CC-SWITCH id, compatibility, and import capability", () => {
    expect(isCcSwitchPluginAvailable([plugin()])).toBe(true);
    expect(isCcSwitchPluginAvailable([plugin({ manifest: { id: "other-plugin" } })])).toBe(false);
    expect(isCcSwitchPluginAvailable([plugin({ compatibility: { compatible: false } })])).toBe(false);
    expect(isCcSwitchPluginAvailable([plugin({ manifest: { capabilities: [] } })])).toBe(false);
  });
});
