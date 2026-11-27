import { describe, expect, it } from "vitest";
import { comparePluginConnectionOrder, type PluginConnectionOrderKey } from "@/lib/ai/pluginConnectionOrder";

const connection = (id: string, name: string, pluginId = "io.dbx.ssh"): PluginConnectionOrderKey => ({ id, name, plugin_id: pluginId });

describe("comparePluginConnectionOrder", () => {
  it("orders by plugin id, then name, then id like the backend", () => {
    expect(comparePluginConnectionOrder(connection("1", "a", "a.plugin"), connection("2", "a", "b.plugin"))).toBe(-1);
    expect(comparePluginConnectionOrder(connection("1", "alpha"), connection("2", "beta"))).toBe(-1);
    expect(comparePluginConnectionOrder(connection("1", "same"), connection("2", "same"))).toBe(-1);
    expect(comparePluginConnectionOrder(connection("1", "same"), connection("1", "same"))).toBe(0);
  });

  it("compares Unicode by code point, not by UTF-16 code unit", () => {
    // Full-width Ａ (U+FF21) sorts before 😀 (U+1F600) in code-point/UTF-8 order,
    // while JavaScript's `<` puts the emoji's surrogate pair first.
    const fullWidth = "Ａ";
    const emoji = "😀";
    expect(fullWidth < emoji).toBe(false);
    expect(comparePluginConnectionOrder(connection("1", fullWidth), connection("2", emoji))).toBe(-1);
  });

  it("treats a prefix as smaller", () => {
    expect(comparePluginConnectionOrder(connection("1", "c1"), connection("2", "c10"))).toBe(-1);
  });

  it("keeps a mixed ASCII/full-width/emoji list in the backend's order", () => {
    const names = ["c10", "Ａ", "😀", "c2"];
    const sorted = [...names].sort((left, right) => comparePluginConnectionOrder(connection("x", left), connection("y", right)));
    // 'c' (U+0063) < Ａ (U+FF21) < 😀 (U+1F600), and "c10" < "c2".
    expect(sorted).toEqual(["c10", "c2", "Ａ", "😀"]);
  });
});
