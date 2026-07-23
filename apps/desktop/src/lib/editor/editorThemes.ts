import type { Extension } from "@codemirror/state";
import type { EditorTheme, CustomThemeColors } from "@/stores/settingsStore";
import type { AppThemeAppearance, AppThemePalette } from "@/lib/app/appTheme";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

type CodeMirrorStyleSpec = Parameters<typeof import("@codemirror/view").EditorView.theme>[0];
type LucideIconNode = Array<[string, Record<string, string>]>;

export const EDITOR_FONT_SIZE_CSS_VAR = "--dbx-editor-font-size";
export const EDITOR_FONT_FAMILY_CSS_VAR = "--dbx-editor-font-family";
export const SQL_TABLE_COLOR_CSS_VAR = "--dbx-sql-table-color";
const EDITOR_SELECTION_BACKGROUND_CSS_VAR = "--dbx-editor-selection-background";

export function createRunStatementButtonDom(ariaLabel = "Execute statement"): HTMLButtonElement {
  const marker = document.createElement("button");
  marker.className = "cm-run-statement-marker cm-run-statement-marker--active";
  marker.setAttribute("type", "button");
  marker.setAttribute("aria-label", ariaLabel);
  marker.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>';
  return marker;
}

export function sqlSemanticHighlightTheme(EditorView: typeof import("@codemirror/view").EditorView): Extension {
  return EditorView.theme({
    ".cm-sql-table-name, .cm-sql-table-name *": {
      color: `var(${SQL_TABLE_COLOR_CSS_VAR}) !important`,
    },
  });
}

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

  const c = { ...defaultColors, ...customThemeColors, ...colors };

  // 映射用户自定义属性名到 CodeMirror 内部属性名
  if (colors) {
    if (colors.field) {
      c.variable = colors.field;
      c.property = colors.field;
    }
  }
  const tableColor = colors?.table || c.property;

  const theme = EditorView.theme(
    {
      "&": {
        backgroundColor: c.background,
        color: c.foreground,
        [EDITOR_SELECTION_BACKGROUND_CSS_VAR]: c.selection,
        [SQL_TABLE_COLOR_CSS_VAR]: tableColor,
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

type IdeEditorThemeColors = {
  dark: boolean;
  background: string;
  foreground: string;
  selection: string;
  selectionMatch: string;
  cursor: string;
  gutterBackground: string;
  gutterForeground: string;
  gutterActiveForeground: string;
  activeLine: string;
  matchingBracket: string;
  gutterBorder: string;
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  variable: string;
  function: string;
  operator: string;
  punctuation: string;
  property: string;
  table: string;
  builtin: string;
  meta: string;
  invalid: string;
  tag: string;
  attribute: string;
  className: string;
  keywordBold?: boolean;
  stringBold?: boolean;
  numberBold?: boolean;
};

const IDE_EDITOR_THEMES = {
  ideaLight: {
    dark: false,
    background: "#ffffff",
    foreground: "#080808",
    selection: "#a6d2ff",
    selectionMatch: "#93d9d9",
    cursor: "#000000",
    gutterBackground: "#f2f2f2",
    gutterForeground: "#adadad",
    gutterActiveForeground: "#767a8a",
    activeLine: "#fcfaed",
    matchingBracket: "#93d9d9",
    gutterBorder: "#d4d4d4",
    keyword: "#0033b3",
    string: "#067d17",
    number: "#1750eb",
    comment: "#8c8c8c",
    type: "#0033b3",
    variable: "#174ad4",
    function: "#00627a",
    operator: "#080808",
    punctuation: "#080808",
    property: "#871094",
    table: "#871094",
    builtin: "#0033b3",
    meta: "#9e880d",
    invalid: "#f50000",
    tag: "#0033b3",
    attribute: "#871094",
    className: "#174be6",
    keywordBold: true,
    stringBold: true,
    numberBold: true,
  },
  ideaDark: {
    dark: true,
    background: "#2b2b2b",
    foreground: "#a9b7c6",
    selection: "#214283",
    selectionMatch: "#3b514d",
    cursor: "#bbbbbb",
    gutterBackground: "#313335",
    gutterForeground: "#606366",
    gutterActiveForeground: "#a4a3a3",
    activeLine: "#323232",
    matchingBracket: "#3b514d",
    gutterBorder: "#4d4d4d",
    keyword: "#cc7832",
    string: "#6a8759",
    number: "#6897bb",
    comment: "#808080",
    type: "#a9b7c6",
    variable: "#a9b7c6",
    function: "#ffc66d",
    operator: "#cc7832",
    punctuation: "#a9b7c6",
    property: "#9876aa",
    table: "#9876aa",
    builtin: "#cc7832",
    meta: "#bbb529",
    invalid: "#ff0000",
    tag: "#e8bf6a",
    attribute: "#bababa",
    className: "#a9b7c6",
  },
  jetbrainsLight: {
    dark: false,
    background: "#ffffff",
    foreground: "#080808",
    selection: "#a6d2ff",
    selectionMatch: "#c9ecec",
    cursor: "#000000",
    gutterBackground: "#ffffff",
    gutterForeground: "#aeb3c2",
    gutterActiveForeground: "#767a8a",
    activeLine: "#f5f8fe",
    matchingBracket: "#93d9d9",
    gutterBorder: "#ebecf0",
    keyword: "#0033b3",
    string: "#067d17",
    number: "#1750eb",
    comment: "#8c8c8c",
    type: "#0033b3",
    variable: "#174ad4",
    function: "#00627a",
    operator: "#080808",
    punctuation: "#080808",
    property: "#871094",
    table: "#871094",
    builtin: "#0033b3",
    meta: "#9e880d",
    invalid: "#f50000",
    tag: "#0033b3",
    attribute: "#871094",
    className: "#174be6",
    keywordBold: true,
    stringBold: true,
    numberBold: true,
  },
  jetbrainsDark: {
    dark: true,
    background: "#1e1f22",
    foreground: "#bcbec4",
    selection: "#2e436e",
    selectionMatch: "#114957",
    cursor: "#ced0d6",
    gutterBackground: "#1e1f22",
    gutterForeground: "#4b5059",
    gutterActiveForeground: "#a1a3ab",
    activeLine: "#26282e",
    matchingBracket: "#43454a",
    gutterBorder: "#313438",
    keyword: "#cf8e6d",
    string: "#6aab73",
    number: "#2aacb8",
    comment: "#7a7e85",
    type: "#cf8e6d",
    variable: "#bcbec4",
    function: "#56a8f5",
    operator: "#bcbec4",
    punctuation: "#bcbec4",
    property: "#c77dbb",
    table: "#c77dbb",
    builtin: "#cf8e6d",
    meta: "#b3ae60",
    invalid: "#f75464",
    tag: "#2fbaa3",
    attribute: "#b3ae60",
    className: "#56a8f5",
  },
  cursorLight: {
    dark: false,
    background: "#fcfcfc",
    foreground: "#141414eb",
    selection: "#1414141e",
    selectionMatch: "#14141411",
    cursor: "#141414eb",
    gutterBackground: "#fcfcfc",
    gutterForeground: "#1414147a",
    gutterActiveForeground: "#141414ad",
    activeLine: "#ededed",
    matchingBracket: "#1414141e",
    gutterBorder: "#14141413",
    keyword: "#b3003f",
    string: "#9e94d5",
    number: "#b8448b",
    comment: "#141414ad",
    type: "#206595",
    variable: "#206595",
    function: "#db704b",
    operator: "#b3003f",
    punctuation: "#141414eb",
    property: "#1f8a65",
    table: "#1f8a65",
    builtin: "#206595",
    meta: "#1f8a65",
    invalid: "#cf2d56",
    tag: "#206595",
    attribute: "#6049b3",
    className: "#206595",
  },
  cursorDark: {
    dark: true,
    background: "#181818",
    foreground: "#e4e4e4eb",
    selection: "#40404099",
    selectionMatch: "#404040cc",
    cursor: "#e4e4e4eb",
    gutterBackground: "#181818",
    gutterForeground: "#e4e4e442",
    gutterActiveForeground: "#e4e4e4eb",
    activeLine: "#262626",
    matchingBracket: "#e4e4e41e",
    gutterBorder: "#e4e4e413",
    keyword: "#82d2ce",
    string: "#e394dc",
    number: "#ebc88d",
    comment: "#e4e4e45e",
    type: "#efb080",
    variable: "#87c3ff",
    function: "#efb080",
    operator: "#d6d6dd",
    punctuation: "#d6d6dd",
    property: "#82d2ce",
    table: "#aaa0fa",
    builtin: "#a8cc7c",
    meta: "#a8cc7c",
    invalid: "#e34671",
    tag: "#82d2ce",
    attribute: "#aaa0fa",
    className: "#efb080",
  },
  claudeLight: {
    dark: false,
    background: "#fffdf8",
    foreground: "#302820",
    selection: "#ead8c6",
    selectionMatch: "#e7d8c8",
    cursor: "#b86b3c",
    gutterBackground: "#f8f1e9",
    gutterForeground: "#9a7f66",
    gutterActiveForeground: "#5f4b3a",
    activeLine: "#f4e9de",
    matchingBracket: "#e2c9b1",
    gutterBorder: "#ddcdbb",
    keyword: "#9a4f2e",
    string: "#4f7d5d",
    number: "#2d6f91",
    comment: "#8c745f",
    type: "#7a5aa8",
    variable: "#3e5f75",
    function: "#b86b3c",
    operator: "#6b5544",
    punctuation: "#6b5544",
    property: "#9a4f2e",
    table: "#7a5aa8",
    builtin: "#4f7d5d",
    meta: "#8f6b2e",
    invalid: "#c3493d",
    tag: "#7a5aa8",
    attribute: "#b86b3c",
    className: "#7a5aa8",
  },
  claudeDark: {
    dark: true,
    background: "#211f1c",
    foreground: "#d8d0c4",
    selection: "#44382f",
    selectionMatch: "#564539",
    cursor: "#d28a5f",
    gutterBackground: "#1b1917",
    gutterForeground: "#8f7f70",
    gutterActiveForeground: "#d8d0c4",
    activeLine: "#2a2723",
    matchingBracket: "#564539",
    gutterBorder: "#7f6c5b59",
    keyword: "#d28a5f",
    string: "#74b195",
    number: "#65a1c6",
    comment: "#a39686",
    type: "#a08fcd",
    variable: "#d8d0c4",
    function: "#d69a6b",
    operator: "#e0d0c0",
    punctuation: "#c9b9a7",
    property: "#d28a5f",
    table: "#a08fcd",
    builtin: "#74b195",
    meta: "#d4ae63",
    invalid: "#e2675f",
    tag: "#a08fcd",
    attribute: "#d69a6b",
    className: "#a08fcd",
  },
} satisfies Record<string, IdeEditorThemeColors>;

function createIdeEditorTheme(EditorView: typeof import("@codemirror/view").EditorView, c: IdeEditorThemeColors): Extension {
  const theme = EditorView.theme(
    {
      "&": {
        backgroundColor: c.background,
        color: c.foreground,
        [EDITOR_SELECTION_BACKGROUND_CSS_VAR]: c.selection,
        [SQL_TABLE_COLOR_CSS_VAR]: c.table,
      },
      ".cm-scroller": {
        backgroundColor: c.background,
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
      ".cm-selectionMatch": {
        backgroundColor: c.selectionMatch,
      },
      ".cm-activeLine": {
        backgroundColor: c.activeLine,
      },
      ".cm-gutters": {
        backgroundColor: c.gutterBackground,
        borderRight: `1px solid ${c.gutterBorder}`,
        color: c.gutterForeground,
      },
      ".cm-activeLineGutter": {
        backgroundColor: c.activeLine,
        color: c.gutterActiveForeground,
      },
      ".cm-matchingBracket": {
        backgroundColor: c.matchingBracket,
        outline: "none",
      },
    },
    { dark: c.dark },
  );

  const highlightStyle = HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.modifier, tags.bool, tags.null], color: c.keyword, ...(c.keywordBold ? { fontWeight: "bold" } : {}) },
    { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape, tags.inserted], color: c.string, ...(c.stringBold ? { fontWeight: "bold" } : {}) },
    { tag: [tags.number, tags.integer, tags.float], color: c.number, ...(c.numberBold ? { fontWeight: "bold" } : {}) },
    { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.quote], color: c.comment, fontStyle: "italic" },
    { tag: [tags.typeName, tags.typeOperator, tags.unit], color: c.type },
    { tag: [tags.name, tags.variableName, tags.definition(tags.variableName)], color: c.variable },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.function(tags.name), tags.macroName], color: c.function },
    { tag: [tags.standard(tags.variableName), tags.special(tags.name)], color: c.builtin },
    { tag: [tags.propertyName, tags.labelName, tags.annotation], color: c.property },
    { tag: [tags.operator, tags.compareOperator, tags.logicOperator, tags.arithmeticOperator, tags.derefOperator], color: c.operator },
    { tag: [tags.punctuation, tags.separator, tags.paren, tags.brace, tags.bracket, tags.angleBracket], color: c.punctuation },
    { tag: tags.tagName, color: c.tag },
    { tag: tags.attributeName, color: c.attribute },
    { tag: tags.attributeValue, color: c.string },
    { tag: [tags.className, tags.namespace], color: c.className },
    { tag: [tags.meta, tags.processingInstruction], color: c.meta },
    { tag: tags.invalid, color: c.invalid },
    { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: c.keyword, fontWeight: "bold" },
    { tag: tags.strong, color: c.foreground, fontWeight: "bold" },
    { tag: tags.emphasis, color: c.foreground, fontStyle: "italic" },
    { tag: [tags.link, tags.url], color: c.type, textDecoration: "underline" },
    { tag: tags.literal, color: c.string },
    { tag: tags.deleted, color: c.invalid },
    { tag: tags.changed, color: c.property },
    { tag: tags.self, color: c.keyword },
    { tag: tags.list, color: c.foreground },
    { tag: tags.monospace, color: c.foreground },
    { tag: tags.strikethrough, color: c.invalid, textDecoration: "line-through" },
    { tag: tags.contentSeparator, color: c.operator },
  ]);

  return [theme, syntaxHighlighting(highlightStyle)];
}

async function loadIdeEditorTheme(colors: IdeEditorThemeColors): Promise<Extension> {
  return createIdeEditorTheme((await import("@codemirror/view")).EditorView, colors);
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

/** Resolve the concrete CodeMirror theme used by the "Follow app theme" setting. */
export function resolveEditorTheme(theme: EditorTheme, appAppearance: AppThemeAppearance, appPalette: AppThemePalette = "pearl"): Exclude<EditorTheme, "app"> {
  if (theme === "app") {
    switch (appPalette) {
      case "vscode":
        return appAppearance === "dark" ? "vscode-dark" : "vscode-light";
      case "idea":
        return appAppearance === "dark" ? "idea-dark" : "idea-light";
      case "xcode":
        return appAppearance === "dark" ? "xcode-dark" : "xcode";
      case "jetbrains":
        return appAppearance === "dark" ? "jetbrains-dark" : "jetbrains-light";
      case "cursor":
        return appAppearance === "dark" ? "cursor-dark" : "cursor-light";
      case "claude":
        return appAppearance === "dark" ? "claude-dark" : "claude-light";
      default:
        return appAppearance === "dark" ? "one-dark" : "vscode-light";
    }
  }
  return theme;
}

/** Load a CodeMirror theme extension by theme name. */
export async function loadEditorTheme(theme: EditorTheme, appAppearance: AppThemeAppearance = "dark", customColors?: CustomThemeColors, appPalette: AppThemePalette = "pearl"): Promise<Extension> {
  const resolvedTheme = resolveEditorTheme(theme, appAppearance, appPalette);
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
    case "xcode-dark":
      return (await import("@uiw/codemirror-theme-xcode")).xcodeDark;
    case "idea-light":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.ideaLight);
    case "idea-dark":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.ideaDark);
    case "jetbrains-light":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.jetbrainsLight);
    case "jetbrains-dark":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.jetbrainsDark);
    case "cursor-light":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.cursorLight);
    case "cursor-dark":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.cursorDark);
    case "claude-light":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.claudeLight);
    case "claude-dark":
      return loadIdeEditorTheme(IDE_EDITOR_THEMES.claudeDark);
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
    ...(opts?.scrollable ? { ".cm-scroller": { overflowX: "auto", overflowY: "auto" } } : {}),
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
    ".cm-run-statement-gutter": {
      minWidth: "34px",
    },
    ".cm-run-statement-gutter .cm-gutterElement": {
      alignItems: "center",
      boxSizing: "border-box",
      display: "flex",
      justifyContent: "center",
      minWidth: "34px",
      padding: "0 5px",
    },
    ".cm-run-statement-marker": {
      alignItems: "center",
      background: "transparent",
      border: "1px solid transparent",
      borderRadius: "var(--dbx-radius-fixed-6)",
      boxSizing: "border-box",
      color: "transparent",
      display: "inline-flex",
      flexShrink: "0",
      height: `min(24px, calc(var(${EDITOR_FONT_SIZE_CSS_VAR}, ${defaults?.size ?? 13}px) * 1.6))`,
      justifyContent: "center",
      margin: "0",
      outline: "none",
      padding: "0",
      position: "relative",
      transition: "color 0.15s, background-color 0.15s",
      userSelect: "none",
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      width: `min(24px, calc(var(${EDITOR_FONT_SIZE_CSS_VAR}, ${defaults?.size ?? 13}px) * 1.6))`,
    },
    ".cm-run-statement-marker--active": {
      background: "rgb(16 185 129 / 0.1)",
      color: "rgb(4 120 87)",
      cursor: "pointer",
    },
    ".cm-run-statement-marker--active:hover": {
      background: "rgb(16 185 129 / 0.2)",
      color: "rgb(6 95 70)",
    },
    "&.cm-editor .cm-run-statement-marker > svg": {
      display: "block",
      flexShrink: "0",
      height: "min(14px, 70%)",
      pointerEvents: "none",
      width: "min(14px, 70%)",
    },
    ".cm-statement-execution-badge": {
      alignItems: "center",
      borderRadius: "9999px",
      bottom: "-1px",
      boxShadow: "0 0 0 1px rgb(255 255 255 / 0.9)",
      color: "white",
      display: "inline-flex",
      height: "min(9px, 45%)",
      justifyContent: "center",
      pointerEvents: "none",
      position: "absolute",
      right: "-1px",
      width: "min(9px, 45%)",
    },
    ".cm-statement-execution-badge--success": {
      background: "rgb(5 150 105)",
    },
    ".cm-statement-execution-badge--error": {
      background: "rgb(220 38 38)",
    },
    ".cm-statement-execution-badge svg": {
      display: "block",
      height: "75%",
      width: "75%",
    },
    "&.cm-editor.cm-focused .cm-run-statement-marker:focus-visible": {
      outline: "1px solid var(--ring)",
      outlineOffset: "1px",
    },
    "&.cm-editor .cm-run-statement-marker--executed": {
      background: "rgb(16 185 129 / 0.18)",
      color: "rgb(6 95 70)",
    },
    "&.cm-editor .cm-settings-preview-run-highlight": {
      background: "rgb(16 185 129 / 0.12)",
    },
    ".dark &.cm-editor .cm-run-statement-marker--active": {
      color: "rgb(110 231 183)",
    },
    ".dark &.cm-editor .cm-run-statement-marker--active:hover, .dark &.cm-editor .cm-run-statement-marker--executed": {
      color: "rgb(167 243 208)",
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
      borderRadius: "var(--dbx-radius-lg)",
      boxShadow: "0 8px 18px rgb(0 0 0 / 0.14)",
      color: "var(--popover-foreground)",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      maxWidth: "min(760px, calc(100vw - 24px))",
      minWidth: "min(280px, calc(100vw - 24px))",
      overflowX: "hidden",
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
      maxWidth: "inherit",
      overflowX: "hidden",
      overflowY: "auto",
      padding: "0 4px 0 !important",
      scrollbarColor: colorMixValue("var(--muted-foreground) transparent", "color-mix(in oklch, var(--muted-foreground) 44%, transparent) transparent"),
      scrollbarWidth: "thin",
      width: "max-content",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      alignItems: "center",
      borderRadius: "var(--dbx-radius-fixed-6)",
      color: "var(--popover-foreground)",
      display: "flex",
      fontSize: `clamp(12px, var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px), 14px)`,
      fontWeight: "520",
      height: "28px",
      letterSpacing: "0",
      lineHeight: "28px",
      overflow: "hidden",
      padding: "0 10px !important",
      textOverflow: "clip",
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
      flex: "0 1 auto",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      fontSize: `clamp(12px, var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px), 14px)`,
      fontWeight: "520",
      letterSpacing: "0",
      minWidth: "8ch",
      overflow: "hidden",
      textOverflow: "ellipsis",
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
      flex: "1 1 auto",
      marginLeft: "10px",
      minWidth: "0",
      opacity: "1",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    ".cm-tooltip.cm-completionInfo": {
      maxWidth: "min(420px, calc(100vw - 24px))",
      overflowWrap: "anywhere",
      zIndex: "10000",
    },
  };
}

export function sqlCompletionTheme(EditorView: typeof import("@codemirror/view").EditorView): Extension {
  return EditorView.theme(buildSqlCompletionThemeRules());
}
