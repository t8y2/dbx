import type { AppThemeAppearance } from "@/lib/appTheme";

export type RedisJsonHighlighter = (content: string, appearance?: AppThemeAppearance) => string;

interface RedisShikiJsonHighlighterOptions {
  appearance: () => AppThemeAppearance;
}

const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createRedisShikiJsonHighlighter(options: RedisShikiJsonHighlighterOptions): Promise<RedisJsonHighlighter> {
  const highlighter = await getRedisShikiHighlighter();
  return (content, appearance = options.appearance()) =>
    highlighter.codeToHtml(content, {
      lang: "json",
      structure: "inline",
      theme: SHIKI_THEMES[appearance],
    });
}

function getRedisShikiHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadRedisShikiHighlighter();
  return highlighterPromise;
}

async function loadRedisShikiHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, json] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes/github-dark.mjs"), import("shiki/themes/github-light.mjs"), import("shiki/langs/json.mjs")]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [json.default],
    themes: [githubDark.default, githubLight.default],
  });
}
