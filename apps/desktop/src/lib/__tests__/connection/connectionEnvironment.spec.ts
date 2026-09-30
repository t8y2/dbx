import { describe, expect, it } from "vitest";
import { CONNECTION_ENVIRONMENTS, connectionEnvironmentPreset } from "@/lib/connection/connectionEnvironment";

describe("connectionEnvironmentPreset", () => {
  it("resolves every preset environment", () => {
    for (const preset of CONNECTION_ENVIRONMENTS) {
      expect(connectionEnvironmentPreset(preset.id)).toBe(preset);
      expect(preset.badgeKey).toMatch(/^connection\.environmentBadge/);
      expect(preset.labelKey).toMatch(/^connection\.environment/);
    }
  });

  it("returns undefined for unknown or missing environments", () => {
    expect(connectionEnvironmentPreset(undefined)).toBeUndefined();
    expect(connectionEnvironmentPreset("")).toBeUndefined();
    expect(connectionEnvironmentPreset("qa")).toBeUndefined();
  });
});
