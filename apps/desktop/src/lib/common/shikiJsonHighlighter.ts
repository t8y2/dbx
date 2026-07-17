import type { AppThemeAppearance } from "@/lib/app/appTheme";

export type JsonHighlighter = (content: string, appearance?: AppThemeAppearance) => string;

interface ShikiJsonHighlighterOptions {
  appearance: () => AppThemeAppearance;
}

const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createShikiJsonHighlighter(options: ShikiJsonHighlighterOptions): Promise<JsonHighlighter> {
  const highlighter = await getShikiJsonHighlighter();
  return (content, appearance = options.appearance()) =>
    highlighter.codeToHtml(content, {
      lang: "json",
      structure: "inline",
      theme: SHIKI_THEMES[appearance],
    });
}

function getShikiJsonHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadShikiJsonHighlighter();
  return highlighterPromise;
}

async function loadShikiJsonHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, json] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes/github-dark.mjs"), import("shiki/themes/github-light.mjs"), import("shiki/langs/json.mjs")]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [json.default],
    themes: [githubDark.default, githubLight.default],
  });
}
