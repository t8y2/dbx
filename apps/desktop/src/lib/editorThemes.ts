import type { Extension } from "@codemirror/state";
import type { EditorTheme, CustomThemeColors } from "@/stores/settingsStore";
import type { AppThemeAppearance } from "@/lib/appTheme";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type CodeMirrorStyleSpec = Parameters<typeof import("@codemirror/view").EditorView.theme>[0];
type LucideIconNode = Array<[string, Record<string, string>]>;

export const EDITOR_FONT_SIZE_CSS_VAR = "--dbx-editor-font-size";
export const EDITOR_FONT_FAMILY_CSS_VAR = "--dbx-editor-font-family";
const EDITOR_SELECTION_BACKGROUND_CSS_VAR = "--dbx-editor-selection-background";

const SUPPORTS_COLOR_MIX = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("color", "color-mix(in oklch, black 50%, white)");
const SUPPORTS_OKLCH = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("color", "oklch(0.62 0.19 255)");

// ==================== 自定义主题配置 ====================
// 在这里修改你喜欢的颜色！

const customThemeColors = {
  lineNumber: "#6c7086", // 行号颜色
  lineNumberActive: "#cdd6f4", // 当前行号颜色
  selection: "#313244", // 选中文本背景
  cursor: "#f5e0dc", // 光标颜色

  // 语法高亮颜色
  keyword: "#cba6f7", // 关键字 (SELECT, FROM, WHERE 等)
  string: "#a6e3a1", // 字符串
  number: "#fab387", // 数字
  comment: "#6c7086", // 注释
  type: "#89b4fa", // 类型 (INTEGER, TEXT 等)
  variable: "#f38ba8", // 变量
  function: "#89dceb", // 函数
  operator: "#89b4fa", // 运算符
  punctuation: "#9399b2", // 标点符号
  property: "#f9e2af", // 属性/字段名
  tag: "#cba6f7", // XML/HTML 标签
  attribute: "#fab387", // 属性名
  className: "#f9e2af", // 类名

  // UI 元素
  gutterBackground: "#181825", // 侧边栏背景
  activeLine: "#313244", // 当前行高亮
  matchingBracket: "#45475a", // 匹配括号背景

  // 特殊
  builtin: "#89dceb", // 内置函数
  meta: "#cdd6f4", // 元信息
  invalid: "#f38ba8", // 无效字符
};

/** 创建自定义 CodeMirror 主题 */
function createCustomTheme(EditorView: typeof import("@codemirror/view").EditorView, colors?: CustomThemeColors, isDark: boolean = true): Extension {
  // 根据系统主题设置默认背景色和前景色
  const defaultColors = isDark ? { background: "#1e1e2e", foreground: "#cdd6f4" } : { background: "#fafafa", foreground: "#242424" };

  const c = { ...defaultColors, ...customThemeColors, ...(colors || {}) };

  // 映射用户自定义属性名到 CodeMirror 内部属性名
  if (colors) {
    if (colors.field) {
      c.variable = colors.field;
      c.property = colors.field;
    }
    if (colors.table) {
      // 表名通常被识别为 propertyName，如果单独设置了表名颜色则覆盖
      c.property = colors.table;
    }
  }

  const theme = EditorView.theme(
    {
      "&": {
        backgroundColor: c.background,
        color: c.foreground,
        [EDITOR_SELECTION_BACKGROUND_CSS_VAR]: c.selection,
      },
      ".cm-content": {
        caretColor: c.cursor,
      },
      ".cm-cursor": {
        borderLeftColor: c.cursor,
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: c.selection,
      },
      ".cm-activeLine": {
        backgroundColor: c.activeLine,
      },
      ".cm-gutters": {
        backgroundColor: c.gutterBackground,
        color: c.lineNumber,
        borderRight: "1px solid #313244",
      },
      ".cm-activeLineGutter": {
        backgroundColor: c.activeLine,
        color: c.lineNumberActive,
      },
      ".cm-matchingBracket": {
        backgroundColor: c.matchingBracket,
        outline: "none",
      },
    },
    { dark: isDark },
  );

  const highlightStyle = HighlightStyle.define([
    { tag: tags.keyword, color: c.keyword },
    { tag: tags.controlKeyword, color: c.keyword },
    { tag: tags.definitionKeyword, color: c.keyword },
    { tag: tags.moduleKeyword, color: c.keyword },
    { tag: tags.operatorKeyword, color: c.keyword },
    { tag: tags.string, color: c.string },
    { tag: tags.special(tags.string), color: c.string },
    { tag: tags.number, color: c.number },
    { tag: tags.integer, color: c.number },
    { tag: tags.float, color: c.number },
    { tag: tags.comment, color: c.comment, fontStyle: "italic" },
    { tag: tags.lineComment, color: c.comment, fontStyle: "italic" },
    { tag: tags.blockComment, color: c.comment, fontStyle: "italic" },
    { tag: tags.typeName, color: c.type },
    { tag: tags.typeOperator, color: c.type },
    { tag: tags.name, color: c.variable }, // ← 添加：普通标识符（字段名、表名等）
    { tag: tags.variableName, color: c.variable },
    { tag: tags.definition(tags.variableName), color: c.variable },
    { tag: tags.function(tags.variableName), color: c.function },
    { tag: tags.function(tags.propertyName), color: c.function },
    { tag: tags.standard(tags.variableName), color: c.builtin },
    { tag: tags.propertyName, color: c.property },
    { tag: tags.operator, color: c.operator },
    { tag: tags.compareOperator, color: c.operator },
    { tag: tags.logicOperator, color: c.operator },
    { tag: tags.arithmeticOperator, color: c.operator },
    { tag: tags.punctuation, color: c.punctuation },
    { tag: tags.paren, color: c.punctuation },
    { tag: tags.brace, color: c.punctuation },
    { tag: tags.bracket, color: c.punctuation },
    { tag: tags.tagName, color: c.tag },
    { tag: tags.attributeName, color: c.attribute },
    { tag: tags.attributeValue, color: c.string },
    { tag: tags.className, color: c.className },
    { tag: tags.bool, color: c.keyword },
    { tag: tags.null, color: c.keyword },
    { tag: tags.meta, color: c.meta },
    { tag: tags.invalid, color: c.invalid },
    { tag: tags.heading, color: c.keyword, fontWeight: "bold" },
    { tag: tags.heading1, color: c.keyword, fontWeight: "bold" },
    { tag: tags.heading2, color: c.keyword, fontWeight: "bold" },
    { tag: tags.heading3, color: c.keyword, fontWeight: "bold" },
    { tag: tags.strong, color: c.foreground, fontWeight: "bold" },
    { tag: tags.emphasis, color: c.foreground, fontStyle: "italic" },
    { tag: tags.link, color: c.type, textDecoration: "underline" },
    { tag: tags.url, color: c.type, textDecoration: "underline" },
    { tag: tags.labelName, color: c.property },
    { tag: tags.namespace, color: c.className },
    { tag: tags.macroName, color: c.function },
    { tag: tags.literal, color: c.string },
    { tag: tags.special(tags.string), color: c.string },
    { tag: tags.regexp, color: c.string },
    { tag: tags.escape, color: c.string },
    { tag: tags.processingInstruction, color: c.keyword },
    { tag: tags.inserted, color: c.string },
    { tag: tags.deleted, color: c.invalid },
    { tag: tags.changed, color: c.property },
    { tag: tags.self, color: c.keyword },
    { tag: tags.derefOperator, color: c.operator },
    { tag: tags.unit, color: c.type },
    { tag: tags.angleBracket, color: c.punctuation },
    { tag: tags.annotation, color: c.property },
    { tag: tags.modifier, color: c.keyword },
    { tag: tags.list, color: c.foreground },
    { tag: tags.quote, color: c.string, fontStyle: "italic" },
    { tag: tags.monospace, color: c.foreground },
    { tag: tags.strikethrough, color: c.invalid, textDecoration: "line-through" },
    { tag: tags.contentSeparator, color: c.operator },
    { tag: tags.special(tags.name), color: c.builtin },
  ]);

  return [theme, syntaxHighlighting(highlightStyle)];
}

// ======================================================

const TABLE_ICON: LucideIconNode = [
  ["path", { d: "M12 3v18" }],
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M3 9h18" }],
  ["path", { d: "M3 15h18" }],
];

const COLUMNS_ICON: LucideIconNode = [
  ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
  ["path", { d: "M12 3v18" }],
];

const KEYWORD_ICON: LucideIconNode = [
  ["path", { d: "m16 18 6-6-6-6" }],
  ["path", { d: "m8 6-6 6 6 6" }],
];

const SNIPPET_ICON: LucideIconNode = [
  ["path", { d: "M8 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h1" }],
  ["path", { d: "M16 3h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-1" }],
];

const FUNCTION_ICON: LucideIconNode = [
  ["path", { d: "m15 10 5 5-5 5" }],
  ["path", { d: "M4 4v7a4 4 0 0 0 4 4h12" }],
];

const SCHEMA_ICON: LucideIconNode = [["path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z" }]];

function encodeSvgIcon(iconNode: LucideIconNode): string {
  const body = iconNode
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([key, value]) => `${key}="${value}"`)
          .join(" ")} />`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function lucideCompletionIconMask(iconNode: LucideIconNode) {
  const mask = encodeSvgIcon(iconNode);
  return {
    "--dbx-completion-icon-mask": mask,
  };
}

function colorMixValue(fallback: string, preferred: string): string {
  return SUPPORTS_COLOR_MIX ? preferred : fallback;
}

function oklchValue(fallback: string, preferred: string): string {
  return SUPPORTS_OKLCH ? preferred : fallback;
}

export function cellDetailActiveLineColor(): string {
  return colorMixValue("var(--accent)", "color-mix(in oklch, var(--foreground) 4%, transparent)");
}

/** Load a CodeMirror theme extension by theme name. */
export function resolveEditorTheme(theme: EditorTheme, appAppearance: AppThemeAppearance): Exclude<EditorTheme, "app"> {
  if (theme === "app") return appAppearance === "dark" ? "one-dark" : "vscode-light";
  return theme;
}

/** Load a CodeMirror theme extension by theme name. */
export async function loadEditorTheme(theme: EditorTheme, appAppearance: AppThemeAppearance = "dark", customColors?: CustomThemeColors): Promise<Extension> {
  const resolvedTheme = resolveEditorTheme(theme, appAppearance);
  switch (resolvedTheme) {
    case "one-dark":
      return (await import("@codemirror/theme-one-dark")).oneDark;
    case "vscode-dark":
      return (await import("@uiw/codemirror-theme-vscode")).vscodeDark;
    case "vscode-light":
      return (await import("@uiw/codemirror-theme-vscode")).vscodeLight;
    case "nord":
      return (await import("@uiw/codemirror-theme-nord")).nord;
    case "okaidia":
      return (await import("@uiw/codemirror-theme-okaidia")).okaidia;
    case "material":
      return (await import("@uiw/codemirror-theme-material")).materialDark;
    case "duotone-light":
      return (await import("@uiw/codemirror-theme-duotone")).duotoneLight;
    case "duotone-dark":
      return (await import("@uiw/codemirror-theme-duotone")).duotoneDark;
    case "xcode":
      return (await import("@uiw/codemirror-theme-xcode")).xcodeLight;
    case "custom":
      return createCustomTheme((await import("@codemirror/view")).EditorView, customColors, appAppearance === "dark");
    default:
      return (await import("@codemirror/theme-one-dark")).oneDark;
  }
}

export function buildEditorFontThemeRules(opts?: { fixedHeight?: boolean; scrollable?: boolean }, defaults?: { size?: number; family?: string }): CodeMirrorStyleSpec {
  return {
    "&": {
      ...(opts?.fixedHeight ? { height: "100%" } : {}),
      fontSize: `var(${EDITOR_FONT_SIZE_CSS_VAR}, ${defaults?.size ?? 13}px)`,
    },
    ...(opts?.scrollable ? { ".cm-scroller": { overflow: "auto" } } : {}),
    ".cm-content": {
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, ${defaults?.family ?? "monospace"})`,
      lineHeight: "1.6",
      padding: "0",
    },
    ".cm-line": {
      padding: "0 2px !important",
    },
    ".cm-selectionLayer .cm-selectionBackground": {
      display: "none",
    },
    ".cm-cursor": {
      height: "1.6em !important",
      transform: "translateY(-0.3em)",
    },
    ".cm-trimmedSelection": {
      backgroundColor: `var(${EDITOR_SELECTION_BACKGROUND_CSS_VAR}, rgb(148 163 184 / 38%))`,
      borderRadius: "0",
    },
    ".cm-trimmedSelection-topLeft": {
      borderTopLeftRadius: "3px",
    },
    ".cm-trimmedSelection-topRight": {
      borderTopRightRadius: "3px",
    },
    ".cm-trimmedSelection-bottomLeft": {
      borderBottomLeftRadius: "3px",
    },
    ".cm-trimmedSelection-bottomRight": {
      borderBottomRightRadius: "3px",
    },
    ".cm-gutters": {
      borderRight: "0 !important",
      fontSize: `var(${EDITOR_FONT_SIZE_CSS_VAR}, ${defaults?.size ?? 13}px)`,
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, ${defaults?.family ?? "monospace"})`,
      position: "relative",
      userSelect: "none",
    },
    ".cm-gutters:after": {
      background: "rgba(148, 163, 184, 0.38)",
      bottom: "0",
      content: "''",
      pointerEvents: "none",
      position: "absolute",
      right: "0",
      top: "0",
      width: "1px",
      zIndex: "10",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      cursor: "pointer",
      paddingRight: "16px",
      userSelect: "none",
    },
  };
}

/** Build a CodeMirror theme extension for font size + font family. */
export function editorFontTheme(EditorView: typeof import("@codemirror/view").EditorView, size: number, family: string, opts?: { fixedHeight?: boolean; scrollable?: boolean }): Extension {
  return EditorView.theme(buildEditorFontThemeRules(opts, { size, family }));
}

export function buildSqlCompletionThemeRules(): CodeMirrorStyleSpec {
  return {
    ".cm-tooltip.cm-tooltip-autocomplete": {
      background: "var(--popover)",
      backgroundClip: "padding-box",
      border: colorMixValue("1px solid var(--border)", "1px solid color-mix(in oklch, var(--border) 82%, var(--foreground) 18%)"),
      borderRadius: "8px",
      boxShadow: "0 8px 18px rgb(0 0 0 / 0.14)",
      color: "var(--popover-foreground)",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      maxWidth: "min(760px, calc(100vw - 24px))",
      minWidth: "min(280px, calc(100vw - 24px))",
      overflowX: "auto",
      overflowY: "hidden",
      padding: "4px 0",
      scrollbarColor: colorMixValue("var(--muted-foreground) transparent", "color-mix(in oklch, var(--muted-foreground) 44%, transparent) transparent"),
      scrollbarWidth: "thin",
      zIndex: "9999",
    },
    ".cm-tooltip.cm-tooltip-autocomplete *": {
      boxSizing: "border-box",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      maxHeight: "min(280px, calc(100vh - 32px))",
      minWidth: "min(280px, calc(100vw - 24px))",
      width: "max-content",
      overflowX: "hidden",
      overflowY: "auto",
      padding: "0 4px 0 !important",
      scrollbarColor: colorMixValue("var(--muted-foreground) transparent", "color-mix(in oklch, var(--muted-foreground) 44%, transparent) transparent"),
      scrollbarWidth: "thin",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      alignItems: "center",
      borderRadius: "6px",
      color: "var(--popover-foreground)",
      display: "flex",
      fontSize: `clamp(12px, var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px), 14px)`,
      fontWeight: "520",
      height: "28px",
      letterSpacing: "0",
      lineHeight: "28px",
      overflow: "hidden",
      padding: "0 10px !important",
      transition: "background-color 90ms ease, color 90ms ease",
      whiteSpace: "nowrap",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: `${colorMixValue("var(--accent)", "color-mix(in oklch, var(--primary) 14%, var(--popover))")} !important`,
      color: "var(--popover-foreground) !important",
      outline: colorMixValue("1px solid var(--border)", "1px solid color-mix(in oklch, var(--primary) 22%, transparent)"),
    },
    ".cm-completionIcon": {
      alignItems: "center",
      display: "inline-flex",
      flex: "0 0 15px",
      height: "15px",
      justifyContent: "center",
      marginRight: "0.65em",
      opacity: "1",
      position: "relative",
      overflow: "hidden",
      width: "15px",
    },
    ".cm-completionIcon:before": {
      backgroundColor: "currentColor",
      content: "''",
      display: "block",
      height: "14px",
      position: "absolute",
      WebkitMaskImage: "var(--dbx-completion-icon-mask)",
      WebkitMaskPosition: "center",
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskSize: "14px 14px",
      maskImage: "var(--dbx-completion-icon-mask)",
      maskPosition: "center",
      maskRepeat: "no-repeat",
      maskSize: "14px 14px",
      width: "14px",
    },
    ".cm-completionIcon:after": {
      content: "'none'",
      display: "none",
    },
    ".cm-completionIcon-table": {
      color: colorMixValue("var(--primary)", "color-mix(in oklch, var(--primary) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(TABLE_ICON),
    },
    ".cm-completionIcon-column": {
      color: colorMixValue("var(--blue-500, #3b82f6)", "color-mix(in oklch, var(--blue-500, #3b82f6) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(COLUMNS_ICON),
    },
    ".cm-completionIcon-keyword": {
      color: colorMixValue("var(--orange-500, #f97316)", "color-mix(in oklch, var(--orange-500, #f97316) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(KEYWORD_ICON),
    },
    ".cm-completionIcon-snippet": {
      color: colorMixValue("var(--violet-500, #8b5cf6)", "color-mix(in oklch, var(--violet-500, #8b5cf6) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(SNIPPET_ICON),
    },
    ".cm-completionIcon-function": {
      color: colorMixValue("var(--emerald-500, #10b981)", "color-mix(in oklch, var(--emerald-500, #10b981) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(FUNCTION_ICON),
    },
    ".cm-completionIcon-schema": {
      color: colorMixValue("var(--amber-500, #f59e0b)", "color-mix(in oklch, var(--amber-500, #f59e0b) 92%, var(--popover-foreground))"),
      ...lucideCompletionIconMask(SCHEMA_ICON),
    },
    ".cm-completionLabel": {
      color: "inherit",
      flex: "0 0 auto",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      fontSize: `clamp(12px, var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px), 14px)`,
      fontWeight: "520",
      letterSpacing: "0",
      whiteSpace: "nowrap",
    },
    ".cm-completionMatchedText": {
      color: oklchValue("rgb(29 132 245)", "oklch(0.62 0.19 255)"),
      fontWeight: "700",
      textDecoration: "none",
    },
    ".cm-completionDetail": {
      color: colorMixValue("var(--muted-foreground)", "color-mix(in oklch, var(--popover-foreground) 68%, var(--popover))"),
      fontSize: `clamp(11px, calc(var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px) - 1px), 13px)`,
      fontWeight: "500",
      fontStyle: "normal",
      flex: "0 0 auto",
      marginLeft: "10px",
      opacity: "1",
      whiteSpace: "nowrap",
    },
  };
}

export function sqlCompletionTheme(EditorView: typeof import("@codemirror/view").EditorView): Extension {
  return EditorView.theme(buildSqlCompletionThemeRules());
}
