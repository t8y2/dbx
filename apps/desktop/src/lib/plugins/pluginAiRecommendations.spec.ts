import { describe, expect, it } from "vitest";
import { interpolatePluginAiRecommendation, isValidPluginAiRecommendationTemplate, resolvePluginAiRecommendationUpdate, resolvePluginAiRecommendations, selectPluginAiRecommendations } from "./pluginAiRecommendations";
import type { PluginAiRecommendation } from "@/types/pluginAiRecommendations";

const item = (overrides: Partial<PluginAiRecommendation> = {}): PluginAiRecommendation => ({
  id: "health",
  label: "Check {{resource.name}}",
  prompt: "Analyze {{resource.kind}}/{{resource.name}}",
  ...overrides,
});

describe("plugin AI recommendations", () => {
  it("rejects malformed placeholders", () => {
    expect(isValidPluginAiRecommendationTemplate("Inspect {{resource.name}}")).toBe(true);
    expect(isValidPluginAiRecommendationTemplate("Inspect {{resource..name}}")).toBe(false);
    expect(isValidPluginAiRecommendationTemplate("Inspect {{resource.name")).toBe(false);
    expect(isValidPluginAiRecommendationTemplate("Inspect resource.name}}")).toBe(false);
    expect(isValidPluginAiRecommendationTemplate('Render JSON {"name": "{{resource.name}}"}')).toBe(true);
    expect(isValidPluginAiRecommendationTemplate("Inspect {{resource.name}} and {{resource.kind}}")).toBe(true);
  });

  it("interpolates nested context paths in label and prompt", () => {
    expect(interpolatePluginAiRecommendation(item(), { resource: { kind: "deployment", name: "whoami" } })).toEqual({
      id: "health",
      label: "Check whoami",
      prompt: "Analyze deployment/whoami",
    });
  });

  it("filters a recommendation when a placeholder is unresolved", () => {
    expect(resolvePluginAiRecommendations([item()], { resource: { kind: "deployment" } })).toEqual([]);
    expect(resolvePluginAiRecommendations([item({ label: "Static", prompt: "No placeholders" })], {})).toHaveLength(1);
  });

  it("does not traverse inherited or forbidden context properties", () => {
    const context = Object.create({ resource: { name: "inherited" } }) as Record<string, unknown>;
    expect(resolvePluginAiRecommendations([item()], context)).toEqual([]);
    expect(resolvePluginAiRecommendations([item({ label: "{{constructor}}", prompt: "safe" })], {})).toEqual([]);
  });

  it("orders by order while keeping declaration order for ties and caps at five", () => {
    const items = Array.from({ length: 7 }, (_, index) => item({ id: `item-${index}`, label: `Item ${index}`, prompt: `Prompt ${index}`, order: index === 6 ? -1 : 1 }));
    expect(resolvePluginAiRecommendations(items, {}).map(({ id }) => id)).toEqual(["item-6", "item-0", "item-1", "item-2", "item-3"]);
  });

  it("does not mutate input recommendations", () => {
    const defaults = [item({ label: "{{resource.name}}", prompt: "Ask {{resource.name}}" })];
    const output = resolvePluginAiRecommendations(defaults, { resource: { name: "db" } });
    expect(output[0]).not.toBe(defaults[0]);
    expect(defaults[0].label).toBe("{{resource.name}}");
  });

  it("uses runtime recommendations as an override, including an explicit empty list", () => {
    const defaults = [item({ id: "default", label: "Default", prompt: "Default" })];
    expect(selectPluginAiRecommendations(defaults, undefined)).toBe(defaults);
    expect(selectPluginAiRecommendations(defaults, [])).toEqual([]);
    expect(resolvePluginAiRecommendationUpdate(defaults, { context: {}, items: [] })).toEqual([]);
  });

  it("uses runtime context and falls back to the supplied context when no update exists", () => {
    const defaults = [item()];
    expect(resolvePluginAiRecommendationUpdate(defaults, undefined, { resource: { kind: "table", name: "users" } })[0]?.prompt).toBe("Analyze table/users");
    expect(resolvePluginAiRecommendationUpdate(defaults, { context: { resource: { kind: "pod", name: "api" } }, items: [item()] })[0]?.prompt).toBe("Analyze pod/api");
  });
});
