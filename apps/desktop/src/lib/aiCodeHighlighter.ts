import type { AppThemeAppearance } from "@/lib/appTheme";

export type AiCodeHighlighter = (content: string, lang: string, appearance?: AppThemeAppearance) => string;

interface AiShikiCodeHighlighterOptions {
  appearance: () => AppThemeAppearance;
}

const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

const SHIKI_LANGUAGES = ["bash", "css", "go", "html", "java", "javascript", "json", "markdown", "php", "python", "rust", "shellscript", "sql", "tsx", "typescript", "vue", "xml", "yaml"] as const;

const SHIKI_LANG_BY_AI_LABEL: Record<string, (typeof SHIKI_LANGUAGES)[number] | "text"> = {
  BASH: "bash",
  CLICKHOUSE: "sql",
  CSS: "css",
  GO: "go",
  HTML: "html",
  JAVA: "java",
  JAVASCRIPT: "javascript",
  JS: "javascript",
  JSON: "json",
  MARKDOWN: "markdown",
  MYSQL: "sql",
  PHP: "php",
  POSTGRESQL: "sql",
  PYTHON: "python",
  RUST: "rust",
  SHELL: "shellscript",
  SH: "shellscript",
  SQL: "sql",
  SQLITE: "sql",
  TS: "typescript",
  TSQL: "sql",
  TSX: "tsx",
  TYPESCRIPT: "typescript",
  VUE: "vue",
  XML: "xml",
  YAML: "yaml",
  YML: "yaml",
  ZSH: "shellscript",
};

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createAiShikiCodeHighlighter(options: AiShikiCodeHighlighterOptions): Promise<AiCodeHighlighter> {
  const highlighter = await getAiShikiHighlighter();
  return (content, lang, appearance = options.appearance()) =>
    highlighter.codeToHtml(content, {
      lang: resolveShikiLanguage(lang),
      structure: "inline",
      theme: SHIKI_THEMES[appearance],
    });
}

function getAiShikiHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadAiShikiHighlighter();
  return highlighterPromise;
}

async function loadAiShikiHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, bash, css, go, html, java, javascript, json, markdown, php, python, rust, shellscript, sql, tsx, typescript, vue, xml, yaml] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/langs/bash.mjs"),
    import("shiki/langs/css.mjs"),
    import("shiki/langs/go.mjs"),
    import("shiki/langs/html.mjs"),
    import("shiki/langs/java.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/markdown.mjs"),
    import("shiki/langs/php.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/rust.mjs"),
    import("shiki/langs/shellscript.mjs"),
    import("shiki/langs/sql.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/vue.mjs"),
    import("shiki/langs/xml.mjs"),
    import("shiki/langs/yaml.mjs"),
  ]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [bash.default, css.default, go.default, html.default, java.default, javascript.default, json.default, markdown.default, php.default, python.default, rust.default, shellscript.default, sql.default, tsx.default, typescript.default, vue.default, xml.default, yaml.default],
    themes: [githubDark.default, githubLight.default],
  });
}

function resolveShikiLanguage(lang: string): (typeof SHIKI_LANGUAGES)[number] | "text" {
  return SHIKI_LANG_BY_AI_LABEL[lang.toUpperCase()] ?? "text";
}
