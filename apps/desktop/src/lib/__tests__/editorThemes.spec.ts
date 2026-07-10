import { describe, expect, it } from "vitest";
import { resolveEditorTheme } from "@/lib/editor/editorThemes";
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
