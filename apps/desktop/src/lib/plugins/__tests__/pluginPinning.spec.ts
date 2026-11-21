import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FrontendPluginDefinition } from "@/lib/plugins/frontendPlugin";
import { loadPinnedPluginIds, savePinnedPluginIds, sortPluginsPinnedFirst } from "@/lib/plugins/pluginPinning";

function definition(id: string): FrontendPluginDefinition {
  return { plugin: { manifest: { id } } } as unknown as FrontendPluginDefinition;
}

describe("sortPluginsPinnedFirst", () => {
  const defs = [definition("a"), definition("b"), definition("c"), definition("d")];

  it("moves pinned plugins to the front while keeping relative order", () => {
    expect(sortPluginsPinnedFirst(defs, ["c", "a"]).map((d) => d.plugin.manifest.id)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns the original order when nothing is pinned", () => {
    expect(sortPluginsPinnedFirst(defs, [])).toEqual(defs);
  });

  it("ignores pinned ids that no longer match an installed plugin", () => {
    expect(sortPluginsPinnedFirst(defs, ["gone", "d"]).map((d) => d.plugin.manifest.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("returns the input array identity when no pin applies", () => {
    expect(sortPluginsPinnedFirst(defs, ["gone"])).toBe(defs);
  });
});

describe("pinned plugin storage", () => {
  const backing = new Map<string, string>();
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips ids through localStorage", () => {
    savePinnedPluginIds(["io.example.a", "io.example.b"]);
    expect(loadPinnedPluginIds()).toEqual(["io.example.a", "io.example.b"]);
    savePinnedPluginIds([]);
    expect(loadPinnedPluginIds()).toEqual([]);
  });

  it("tolerates corrupted stored values", () => {
    localStorage.setItem("dbx-plugin-pinned-ids", "{not json");
    expect(loadPinnedPluginIds()).toEqual([]);
    localStorage.setItem("dbx-plugin-pinned-ids", JSON.stringify([1, "ok", null]));
    expect(loadPinnedPluginIds()).toEqual(["ok"]);
    localStorage.removeItem("dbx-plugin-pinned-ids");
  });
});
