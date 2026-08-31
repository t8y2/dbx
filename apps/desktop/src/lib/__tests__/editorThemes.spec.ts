import { describe, expect, it } from "vitest";
import { buildEditorFontThemeRules, buildSqlCompletionThemeRules, editorDiagnosticColors, editorThemeAppearanceFor, resolveCustomThemeBackgrounds, resolveEditorTheme } from "@/lib/editor/editorThemes";
import { DEFAULT_APP_CUSTOM_UI_COLORS, wcagContrastRatio, type AppThemePalette } from "@/lib/app/appTheme";
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

  it("routes the custom UI palette to verified dark/light editor themes by appearance", () => {
    expect(resolveEditorTheme("app", "dark", "custom")).toBe("one-dark");
    expect(resolveEditorTheme("app", "light", "custom")).toBe("vscode-light");
    expect(resolveEditorTheme("one-dark", "light", "custom")).toBe("one-dark");
  });

  it("derives the follow-app editor appearance from the custom background at light/dark extremes", () => {
    const darkBg = { ...DEFAULT_APP_CUSTOM_UI_COLORS, background: "#000000" };
    const lightBg = { ...DEFAULT_APP_CUSTOM_UI_COLORS, background: "#ffffff" };
    expect(editorThemeAppearanceFor("light", "custom", darkBg)).toBe("dark");
    expect(editorThemeAppearanceFor("dark", "custom", lightBg)).toBe("light");
    // Setting off or fixed palettes keep the previous mode-based behavior unchanged.
    expect(editorThemeAppearanceFor("dark", "pearl")).toBe("dark");
    expect(editorThemeAppearanceFor("light", "cobalt")).toBe("light");
    expect(editorThemeAppearanceFor("light", "custom", undefined)).toBe("light");
  });

  it("keeps every major semantic token readable on the editor themes the custom palette routes to", () => {
    // Token colors are the shipped values of the curated themes (one-dark from
    // @codemirror/theme-one-dark, vscode-light from @uiw/codemirror-theme-vscode).
    // The floors are WCAG AA large-text (3.0) for dimmed comments and a 4.0
    // readable floor for body tokens; one-dark's variable sits at ~4.4 by design.
    const curated: Array<{ bg: string; fg: string; comment: string; tokens: Record<string, string> }> = [
      {
        bg: "#282c34",
        fg: "#abb2bf",
        comment: "#7d8799",
        tokens: {
          keyword: "#c678dd",
          string: "#98c379",
          number: "#d19a66",
          function: "#61afef",
          type: "#e5c07b",
          variable: "#e06c75",
          operator: "#56b6c2",
        },
      },
      {
        bg: "#ffffff",
        fg: "#383a42",
        comment: "#008000",
        tokens: {
          keyword: "#383a42",
          string: "#a31515",
          number: "#383a42",
          function: "#383a42",
          type: "#383a42",
          variable: "#383a42",
          operator: "#383a42",
        },
      },
    ];

    for (const theme of curated) {
      for (const [name, color] of Object.entries(theme.tokens)) {
        expect(wcagContrastRatio(color, theme.bg), `${name} (${color}) on ${theme.bg}`).toBeGreaterThanOrEqual(4.0);
      }
      expect(wcagContrastRatio(theme.comment, theme.bg), `comment on ${theme.bg}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it("uses light diagnostic markers on dark editors and dark markers on light editors", () => {
    const dark = editorDiagnosticColors("dark");
    const light = editorDiagnosticColors("light");
    expect(wcagContrastRatio(dark.error, "#282c34")).toBeGreaterThanOrEqual(3.0);
    expect(wcagContrastRatio(dark.warning, "#282c34")).toBeGreaterThanOrEqual(3.0);
    expect(wcagContrastRatio(light.error, "#ffffff")).toBeGreaterThanOrEqual(3.0);
    expect(wcagContrastRatio(light.warning, "#ffffff")).toBeGreaterThanOrEqual(3.0);
  });

  it("keeps selected text readable against the curated themes' selection backgrounds", () => {
    // Selection backgrounds are part of the same verified themes; selected text
    // (the theme foreground) must stay legible inside the selection highlight.
    expect(wcagContrastRatio("#abb2bf", "#3E4451")).toBeGreaterThanOrEqual(3.0); // one-dark selection
    expect(wcagContrastRatio("#383a42", "#add6ff")).toBeGreaterThanOrEqual(3.0); // vscode-light selection
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

describe("editor gutters", () => {
  it("anchors line numbers to the first visual row of wrapped lines", () => {
    const rules = buildEditorFontThemeRules();

    expect(rules[".cm-lineNumbers .cm-gutterElement"]).toMatchObject({
      alignItems: "center",
      display: "flex",
      justifyContent: "flex-end",
    });
    expect(rules[".cm-lineNumbers .cm-gutterElement.cm-db-wrapped-line-number"]).toMatchObject({ alignItems: "flex-start" });
  });
});
