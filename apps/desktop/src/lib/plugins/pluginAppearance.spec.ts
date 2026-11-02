import { describe, expect, it } from "vitest";
import { buildPluginAppearance, buildPluginEditorAppearance, FALLBACK_APPEARANCE_COLORS, readAppearanceTokens } from "./pluginAppearance";

describe("buildPluginAppearance", () => {
  it("uses the pearl (white) fallback tokens for light and the .dark tokens for dark", () => {
    const light = buildPluginAppearance(false, {}, { fontFamily: "Fira Code", fontSize: 13 });
    expect(light.colorScheme).toBe("light");
    expect(light.colors).toEqual(FALLBACK_APPEARANCE_COLORS.light);
    expect(FALLBACK_APPEARANCE_COLORS.light.background).toBe("rgb(255 255 255)");

    const dark = buildPluginAppearance(true, {}, { fontFamily: "Fira Code", fontSize: 13 });
    expect(dark.colorScheme).toBe("dark");
    expect(dark.colors).toEqual(FALLBACK_APPEARANCE_COLORS.dark);
  });

  it("prefers live design tokens over the fallback palette", () => {
    const appearance = buildPluginAppearance(false, { background: "rgb(250 251 253)", foreground: "rgb(40 44 52)" }, { fontFamily: "Fira Code", fontSize: 14 }, "SF Pro");
    expect(appearance.colors.background).toBe("rgb(250 251 253)");
    expect(appearance.colors.foreground).toBe("rgb(40 44 52)");
    expect(appearance.colors.muted).toBe(FALLBACK_APPEARANCE_COLORS.light.muted);
    expect(appearance.terminal).toEqual({ fontFamily: "Fira Code", fontSize: 14 });
    expect(appearance.ui).toEqual({ fontFamily: "SF Pro" });
  });

  it("omits the ui font when the host has none", () => {
    const appearance = buildPluginAppearance(true, {}, { fontFamily: "Fira Code", fontSize: 13 });
    expect(appearance.ui).toBeUndefined();
  });

  it("returns no tokens outside a browser context", () => {
    // jsdom 环境下 getComputedStyle 存在，但令牌读取不应抛错。
    expect(() => readAppearanceTokens()).not.toThrow();
  });
});

describe("buildPluginEditorAppearance", () => {
  it("carries the editor font family, size and SQL syntax theme", () => {
    expect(buildPluginEditorAppearance({ fontFamily: "Fira Code", fontSize: 13, theme: "one-dark" })).toEqual({
      fontFamily: "Fira Code",
      fontSize: 13,
      theme: "one-dark",
    });
  });

  it("returns undefined unless every field is usable (no partial snapshots)", () => {
    expect(buildPluginEditorAppearance({})).toBeUndefined();
    expect(buildPluginEditorAppearance({ fontFamily: "Fira Code" })).toBeUndefined();
    expect(buildPluginEditorAppearance({ fontFamily: "Fira Code", fontSize: 13 })).toBeUndefined();
    expect(buildPluginEditorAppearance({ fontFamily: "Fira Code", fontSize: 0, theme: "one-dark" })).toBeUndefined();
    expect(buildPluginEditorAppearance({ fontFamily: "Fira Code", fontSize: Number.NaN, theme: "one-dark" })).toBeUndefined();
    expect(buildPluginEditorAppearance({ fontFamily: "  ", fontSize: 13, theme: "one-dark" })).toBeUndefined();
  });
});
