import { describe, expect, it } from "vitest";
import { effortPreferenceUpdateForCapability, runtimeEffortFromPreference } from "@/lib/ai/aiEffortPreference";
import { normalizeAiConfig } from "@/stores/settingsStore";
import type { AiEffortCapability } from "@/types/ai";

const enumCapability: AiEffortCapability = {
  kind: "enum",
  options: [
    { id: "low", label: "Low", selection: { kind: "enum", value: "low" } },
    { id: "high", label: "High", selection: { kind: "enum", value: "high" } },
  ],
  default: { kind: "enum", value: "low" },
  source: "localCli",
};

describe("runtimeEffortFromPreference", () => {
  it("leaves runtime effort absent so legacy effort settings remain available", () => {
    const config = normalizeAiConfig({
      provider: "codex-cli",
      enableThinking: false,
      reasoningLevel: "high",
      runtimeEffort: runtimeEffortFromPreference(null),
    });

    expect(config.runtimeEffort).toBeUndefined();
    expect(config.enableThinking).toBe(false);
    expect(config.reasoningLevel).toBe("high");
    expect(JSON.parse(JSON.stringify(config))).not.toHaveProperty("runtimeEffort");
  });

  it("preserves an explicitly selected provider default", () => {
    expect(runtimeEffortFromPreference({ kind: "providerDefault" })).toEqual({ kind: "providerDefault" });
  });
});

describe("effortPreferenceUpdateForCapability", () => {
  it("does not create a preference while capability data loads", () => {
    expect(effortPreferenceUpdateForCapability(enumCapability, null)).toBeUndefined();
  });

  it("preserves existing correction behavior for an unsupported explicit preference", () => {
    expect(effortPreferenceUpdateForCapability(enumCapability, { kind: "enum", value: "future" })).toEqual({ kind: "enum", value: "low" });
  });
});
