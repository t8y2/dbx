import { describe, expect, it } from "vitest";
import { buildSqlCompletionThemeRules, resolveCustomThemeBackgrounds, resolveEditorTheme } from "@/lib/editor/editorThemes";
import type { AppThemePalette } from "@/lib/app/appTheme";
import type { EditorTheme } from "@/stores/settingsStore";

describe("resolveEditorTheme", () => {
  it("maps only the follow-app editor theme to application IDE palettes", () => {
    expect(resolveEditorTheme("app", "light", "xcode")).toBe("xcode");
    expect(resolveEditorTheme("app", "dark", "xcode")).toBe("xcode-dark");
    expect(resolveEditorTheme("app", "light", "cursor")).toBe("cursor-light");
    expect(resolveEditorTheme("app", "dark", "cursor")).toBe("cursor-dark");
  });

  it("keeps explicit editor themes unchanged across application palettes", () => {
    const explicitThemes: Array<Exclude<EditorTheme, "app">> = [
      "one-dark",
      "vscode-dark",
      "vscode-light",
      "nord",
      "okaidia",
      "material",
      "duotone-light",
      "duotone-dark",
      "xcode",
      "xcode-dark",
      "idea-light",
      "idea-dark",
      "jetbrains-light",
      "jetbrains-dark",
      "cursor-light",
      "cursor-dark",
      "claude-light",
      "claude-dark",
      "custom",
    ];
    const appPalettes: AppThemePalette[] = ["pearl", "vscode", "idea", "xcode", "jetbrains", "cursor", "claude"];

    for (const theme of explicitThemes) {
      for (const palette of appPalettes) {
        expect(resolveEditorTheme(theme, "dark", palette)).toBe(theme);
        expect(resolveEditorTheme(theme, "light", palette)).toBe(theme);
      }
    }
  });
});

describe("custom editor theme backgrounds", () => {
  it("uses an explicit dark background for the editor and gutter", () => {
    expect(resolveCustomThemeBackgrounds({ background: "#10131a" }, true)).toEqual({
      background: "#10131a",
      gutterBackground: "#10131a",
    });
  });

  it("uses an explicit light background for the editor and gutter", () => {
    expect(resolveCustomThemeBackgrounds({ background: "#f5f3ee" }, false)).toEqual({
      background: "#f5f3ee",
      gutterBackground: "#f5f3ee",
    });
  });

  it("keeps the existing custom defaults when background is omitted", () => {
    expect(resolveCustomThemeBackgrounds(undefined, true)).toEqual({
      background: "#1e1e2e",
      gutterBackground: "#181825",
    });
    expect(resolveCustomThemeBackgrounds(undefined, false)).toEqual({
      background: "#fafafa",
      gutterBackground: "#181825",
    });
  });
});

describe("SQL completion theme", () => {
  it("uses the configurable medium radius for the popup container", () => {
    const rules = buildSqlCompletionThemeRules();

    expect(rules[".cm-tooltip.cm-tooltip-autocomplete"]).toMatchObject({ borderRadius: "var(--dbx-radius-md)" });
    expect(rules[".cm-tooltip.cm-tooltip-autocomplete > ul > li"]).toMatchObject({ borderRadius: "var(--dbx-radius-sm)" });
  });

  it("keeps completion labels ahead of long detail text", () => {
    const rules = buildSqlCompletionThemeRules();

    expect(rules[".cm-completionLabel"]).toMatchObject({ flex: "0 1 auto" });
    expect(rules[".cm-completionDetail"]).toMatchObject({ flex: "1 1 0", minWidth: "0", textOverflow: "ellipsis" });
  });
});
