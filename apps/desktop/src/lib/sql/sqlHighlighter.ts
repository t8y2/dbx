import type { AppThemeAppearance } from "@/lib/app/appTheme";

export type SqlHighlighter = (content: string, appearance?: AppThemeAppearance) => string;

interface ShikiSqlHighlighterOptions {
  appearance: () => AppThemeAppearance;
  themePreset?: ShikiSqlThemePreset;
}

type ShikiSqlThemePreset = "default" | "preview";

const SHIKI_THEMES = {
  default: {
    dark: "github-dark",
    light: "github-light",
  },
  preview: {
    dark: "dark-plus",
    light: "min-light",
  },
} as const;

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;
type ShikiCodeHighlighter = Pick<ShikiHighlighter, "codeToHtml">;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createShikiSqlHighlighter(options: ShikiSqlHighlighterOptions): Promise<SqlHighlighter> {
  try {
    const highlighter = await getShikiSqlHighlighter();
    return createSafeSqlHighlighter(highlighter, options);
  } catch (error) {
    console.warn("[DBX][sqlHighlighter] Failed to initialize SQL highlighter:", error);
    return escapeHtml;
  }
}

export function createSafeSqlHighlighter(highlighter: ShikiCodeHighlighter, options: ShikiSqlHighlighterOptions): SqlHighlighter {
  return (content, appearance = options.appearance()) => {
    try {
      const themes = SHIKI_THEMES[options.themePreset ?? "default"];
      return highlighter.codeToHtml(content, {
        lang: "sql",
        structure: "inline",
        theme: themes[appearance],
      });
    } catch (error) {
      console.warn("[DBX][sqlHighlighter] Failed to highlight SQL:", error);
      return escapeHtml(content);
    }
  };
}

export function escapeHtml(content: string): string {
  return content.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function getShikiSqlHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadShikiSqlHighlighter();
  return highlighterPromise;
}

async function loadShikiSqlHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, darkPlus, minLight, sql] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/themes/dark-plus.mjs"),
    import("shiki/themes/min-light.mjs"),
    import("shiki/langs/sql.mjs"),
  ]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [sql.default],
    themes: [githubDark.default, githubLight.default, darkPlus.default, minLight.default],
  });
}
