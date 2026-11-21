import { describe, expect, it } from "vitest";
import { getCcSwitchPluginStatus, isCcSwitchPluginAvailable, isMagpieImportAvailable, MAGPIE_IMPORT_MINIMUM_PLUGIN_VERSION } from "@/lib/ai/ccSwitch";
import type { InstalledPlugin } from "@/types/database";

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const { manifest, ...otherOverrides } = overrides;
  return {
    manifest: {
      id: "cc-switch",
      name: "AI Config Importer",
      drivers: [],
      capabilities: [{ id: "ai-config-import", label: "AI configuration import" }],
      ...manifest,
    },
    compatibility: { compatible: true },
    ...otherOverrides,
  };
}

describe("isCcSwitchPluginAvailable", () => {
  it("requires the CC-SWITCH id, compatibility, and import capability", () => {
    expect(isCcSwitchPluginAvailable([plugin()])).toBe(true);
    expect(isCcSwitchPluginAvailable([plugin({ manifest: { id: "other-plugin" } })])).toBe(false);
    expect(isCcSwitchPluginAvailable([plugin({ compatibility: { compatible: false } })])).toBe(false);
    expect(isCcSwitchPluginAvailable([plugin({ manifest: { capabilities: [] } })])).toBe(false);
  });

  it("distinguishes missing, incompatible, and available plugins", () => {
    expect(getCcSwitchPluginStatus([])).toBe("not-installed");
    expect(getCcSwitchPluginStatus([plugin({ compatibility: { compatible: false } })])).toBe("incompatible");
    expect(getCcSwitchPluginStatus([plugin({ manifest: { id: "cc-switch", capabilities: [] } })])).toBe("incompatible");
    expect(getCcSwitchPluginStatus([plugin()])).toBe("available");
  });
});

describe("isMagpieImportAvailable", () => {
  it("requires the plugin version that reads Magpie active model preferences", () => {
    expect(isMagpieImportAvailable([plugin({ manifest: { version: "0.2.1" } })])).toBe(false);
    expect(isMagpieImportAvailable([plugin({ manifest: { version: MAGPIE_IMPORT_MINIMUM_PLUGIN_VERSION } })])).toBe(true);
  });
});
