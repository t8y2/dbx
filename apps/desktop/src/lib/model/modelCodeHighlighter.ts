import type { AppThemeAppearance } from "@/lib/app/appTheme";
import type { ModelFormatId } from "./modelRendererRegistry";
import { supportsRegExpLookbehind } from "@/lib/ui/legacyWebView";

type ModelCodeHighlighter = (content: string, format: ModelFormatId, appearance?: AppThemeAppearance) => string;
type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

const themes = { dark: "github-dark", light: "github-light" } as const;
const languages = {
  typescript: "typescript",
  zod: "typescript",
  yup: "typescript",
  joi: "typescript",
  pydantic: "python",
  "python-dataclass": "python",
  "go-struct": "go",
  "rust-struct": "rust",
  kotlin: "kotlin",
  swift: "swift",
  dart: "dart",
  java: "java",
  csharp: "csharp",
  php: "php",
  ruby: "ruby",
} satisfies Record<ModelFormatId, string>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;

export async function createModelCodeHighlighter(options: { appearance: () => AppThemeAppearance }): Promise<ModelCodeHighlighter> {
  const highlighter = await getHighlighter();
  return (content, format, appearance = options.appearance()) => {
    const html = highlighter.codeToHtml(content.replace(/\t/g, "    "), {
      lang: languages[format],
      structure: "classic",
      theme: themes[appearance],
    });
    const match = /<code[^>]*>([\s\S]*)<\/code>/.exec(html);
    return (match ? match[1] : html).replace(/<\/span>\n/g, "</span>");
  };
}

function getHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadHighlighter();
  return highlighterPromise;
}

async function loadHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, oniguruma, githubDark, githubLight, dart, go, csharp, java, javascript, json, kotlin, php, python, ruby, rust, swift, typescript] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    supportsRegExpLookbehind() ? Promise.resolve(null) : Promise.all([import("shiki/engine/oniguruma"), import("shiki/wasm")]),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/langs/dart.mjs"),
    import("shiki/langs/go.mjs"),
    import("shiki/langs/csharp.mjs"),
    import("shiki/langs/java.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/kotlin.mjs"),
    import("shiki/langs/php.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/ruby.mjs"),
    import("shiki/langs/rust.mjs"),
    import("shiki/langs/swift.mjs"),
    import("shiki/langs/typescript.mjs"),
  ]);

  return createHighlighterCore({
    engine: oniguruma ? await oniguruma[0].createOnigurumaEngine(oniguruma[1]) : createJavaScriptRegexEngine(),
    langs: [dart.default, go.default, csharp.default, java.default, javascript.default, json.default, kotlin.default, php.default, python.default, ruby.default, rust.default, swift.default, typescript.default],
    themes: [githubDark.default, githubLight.default],
  });
}
