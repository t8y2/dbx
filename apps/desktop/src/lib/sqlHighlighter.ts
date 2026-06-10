import type { AppThemeAppearance } from "@/lib/appTheme";

export type SqlHighlighter = (content: string, appearance?: AppThemeAppearance) => string;

interface ShikiSqlHighlighterOptions {
  appearance: () => AppThemeAppearance;
}

const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createShikiSqlHighlighter(options: ShikiSqlHighlighterOptions): Promise<SqlHighlighter> {
  const highlighter = await getShikiSqlHighlighter();
  return (content, appearance = options.appearance()) =>
    highlighter.codeToHtml(content, {
      lang: "sql",
      structure: "inline",
      theme: SHIKI_THEMES[appearance],
    });
}

function getShikiSqlHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadShikiSqlHighlighter();
  return highlighterPromise;
}

async function loadShikiSqlHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, sql] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes/github-dark.mjs"), import("shiki/themes/github-light.mjs"), import("shiki/langs/sql.mjs")]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [sql.default],
    themes: [githubDark.default, githubLight.default],
  });
}
