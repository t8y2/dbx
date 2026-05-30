import type { Extension } from "@codemirror/state";
import type { EditorTheme } from "@/stores/settingsStore";
import type { AppThemeAppearance } from "@/lib/appTheme";

type CodeMirrorStyleSpec = Parameters<typeof import("@codemirror/view").EditorView.theme>[0];
type LucideIconNode = Array<[string, Record<string, string>]>;
type IdeaDarkSqlTokenKind =
  | "comment"
  | "function"
  | "identifier"
  | "keyword"
  | "number"
  | "operator"
  | "source"
  | "string"
  | "type"
  | "variable";

export interface IdeaDarkSqlTokenStyle {
  from: number;
  to: number;
  kind: IdeaDarkSqlTokenKind;
}

export const EDITOR_FONT_SIZE_CSS_VAR = "--dbx-editor-font-size";
export const EDITOR_FONT_FAMILY_CSS_VAR = "--dbx-editor-font-family";

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

const SCHEMA_ICON: LucideIconNode = [
  ["path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z" }],
];

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

const IDEA_DARK_EDITOR_COLORS = {
  background: "#1e1f22",
  foreground: "#bcbec4",
  mutedForeground: "#7a7e85",
  panel: "#252629",
  panelBorder: "#323438",
  activeLine: "#25272c",
  selection: "#2f4f7f",
  cursor: "#bcbec4",
  keyword: "#cf8e6d",
  name: "#d286bf",
  function: "#56a8f5",
  constant: "#c89f66",
  definition: "#bcbec4",
  type: "#c9a86a",
  operator: "#56a8a8",
  string: "#6aab73",
  comment: "#7a7e85",
  invalid: "#ff6b68",
};

const IDEA_DARK_SQL_TOKEN_CLASS: Record<IdeaDarkSqlTokenKind, string> = {
  comment: "cm-dbxi-sql-comment",
  function: "cm-dbxi-sql-function",
  identifier: "cm-dbxi-sql-identifier",
  keyword: "cm-dbxi-sql-keyword",
  number: "cm-dbxi-sql-number",
  operator: "cm-dbxi-sql-operator",
  source: "cm-dbxi-sql-source",
  string: "cm-dbxi-sql-string",
  type: "cm-dbxi-sql-type",
  variable: "cm-dbxi-sql-variable",
};

const ONE_DARK_TO_IDEA_DARK_COLORS: Record<string, string> = {
  "#c678dd": IDEA_DARK_EDITOR_COLORS.keyword,
  "#e06c75": IDEA_DARK_EDITOR_COLORS.name,
  "#61afef": IDEA_DARK_EDITOR_COLORS.function,
  "#d19a66": IDEA_DARK_EDITOR_COLORS.constant,
  "#abb2bf": IDEA_DARK_EDITOR_COLORS.definition,
  "#e5c07b": IDEA_DARK_EDITOR_COLORS.type,
  "#56b6c2": IDEA_DARK_EDITOR_COLORS.operator,
  "#7d8799": IDEA_DARK_EDITOR_COLORS.comment,
  "#98c379": IDEA_DARK_EDITOR_COLORS.string,
  "#ffffff": IDEA_DARK_EDITOR_COLORS.invalid,
};

const SQL_KEYWORDS = new Set([
  "add",
  "all",
  "alter",
  "and",
  "any",
  "as",
  "asc",
  "begin",
  "between",
  "by",
  "cascade",
  "case",
  "check",
  "collate",
  "column",
  "comment",
  "commit",
  "conflict",
  "constraint",
  "create",
  "cross",
  "current_date",
  "current_time",
  "current_timestamp",
  "database",
  "default",
  "delete",
  "desc",
  "describe",
  "distinct",
  "drop",
  "else",
  "end",
  "escape",
  "except",
  "exclude",
  "explain",
  "exists",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "full",
  "function",
  "grant",
  "group",
  "having",
  "in",
  "index",
  "inner",
  "insert",
  "intersect",
  "into",
  "is",
  "join",
  "key",
  "left",
  "like",
  "limit",
  "merge",
  "not",
  "null",
  "of",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "over",
  "partition",
  "primary",
  "procedure",
  "range",
  "recursive",
  "references",
  "replace",
  "restrict",
  "returning",
  "revoke",
  "right",
  "rollback",
  "row",
  "rows",
  "schema",
  "select",
  "set",
  "some",
  "table",
  "temporary",
  "then",
  "to",
  "trigger",
  "true",
  "truncate",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "view",
  "when",
  "where",
  "window",
  "with",
]);

const SQL_SOURCE_KEYWORDS = new Set(["delete", "describe", "from", "into", "join", "table", "update"]);

const SQL_FUNCTIONS = new Set([
  "abs",
  "acos",
  "avg",
  "cast",
  "ceil",
  "ceiling",
  "coalesce",
  "concat",
  "count",
  "date",
  "date_add",
  "date_format",
  "date_sub",
  "datediff",
  "day",
  "dayofmonth",
  "dayofweek",
  "dayofyear",
  "dense_rank",
  "extract",
  "floor",
  "greatest",
  "hour",
  "ifnull",
  "json_array",
  "json_build_object",
  "json_each",
  "json_extract",
  "json_object",
  "json_query",
  "json_value",
  "least",
  "length",
  "lower",
  "ltrim",
  "max",
  "min",
  "minute",
  "month",
  "now",
  "nullif",
  "rank",
  "regexp_replace",
  "replace",
  "row_number",
  "round",
  "rtrim",
  "second",
  "substring",
  "sum",
  "to_char",
  "to_date",
  "to_timestamp",
  "trim",
  "upper",
  "year",
]);

const SQL_TYPES = new Set([
  "array",
  "bigint",
  "bigserial",
  "binary",
  "bit",
  "blob",
  "bool",
  "boolean",
  "box",
  "bytea",
  "char",
  "character",
  "cidr",
  "circle",
  "clob",
  "date",
  "datetime",
  "datetime2",
  "decimal",
  "double",
  "enum",
  "float",
  "float4",
  "float8",
  "inet",
  "int",
  "int2",
  "int4",
  "int8",
  "integer",
  "interval",
  "json",
  "jsonb",
  "line",
  "longblob",
  "longtext",
  "macaddr",
  "mediumblob",
  "mediumint",
  "mediumtext",
  "money",
  "nchar",
  "ntext",
  "numeric",
  "nvarchar",
  "path",
  "point",
  "polygon",
  "real",
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallint",
  "smallserial",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "tinyblob",
  "tinyint",
  "tinytext",
  "tsquery",
  "tsvector",
  "uuid",
  "varbinary",
  "varchar",
  "varying",
  "xml",
  "year",
]);

interface SqlWordToken {
  from: number;
  to: number;
  type: "comment" | "number" | "operator" | "punctuation" | "string" | "variable" | "word";
  value: string;
}

function readSqlToken(text: string, from: number): SqlWordToken | undefined {
  const rest = text.slice(from);
  const stringMatch = rest.match(/^'(?:''|[^'])*'/);
  if (stringMatch) return { from, to: from + stringMatch[0].length, type: "string", value: stringMatch[0] };

  const lineCommentMatch = rest.match(/^--[^\n\r]*/);
  if (lineCommentMatch)
    return { from, to: from + lineCommentMatch[0].length, type: "comment", value: lineCommentMatch[0] };

  const blockCommentMatch = rest.match(/^\/\*[\s\S]*?\*\//);
  if (blockCommentMatch)
    return { from, to: from + blockCommentMatch[0].length, type: "comment", value: blockCommentMatch[0] };

  const variableMatch = rest.match(/^@[A-Za-z_][\w$]*/);
  if (variableMatch) return { from, to: from + variableMatch[0].length, type: "variable", value: variableMatch[0] };

  const quotedIdentifierMatch = rest.match(/^(?:"[^"]+"|`[^`]+`|\[[^\]]+\])/);
  if (quotedIdentifierMatch) {
    return { from, to: from + quotedIdentifierMatch[0].length, type: "word", value: quotedIdentifierMatch[0] };
  }

  const numberMatch = rest.match(/^\b\d+(?:\.\d+)?\b/);
  if (numberMatch) return { from, to: from + numberMatch[0].length, type: "number", value: numberMatch[0] };

  const wordMatch = rest.match(/^[A-Za-z_][\w$]*/);
  if (wordMatch) return { from, to: from + wordMatch[0].length, type: "word", value: wordMatch[0] };

  const operatorMatch = rest.match(/^(?:<>|!=|<=|>=|:=|::|[-+*/%<>=|&^~!]+)/);
  if (operatorMatch) return { from, to: from + operatorMatch[0].length, type: "operator", value: operatorMatch[0] };

  const punctuationMatch = rest.match(/^[()[\]{},.;.]/);
  if (punctuationMatch) {
    return { from, to: from + punctuationMatch[0].length, type: "punctuation", value: punctuationMatch[0] };
  }

  return undefined;
}

function nextSqlToken(tokens: SqlWordToken[], index: number): SqlWordToken | undefined {
  return tokens.slice(index + 1).find((token) => token.type !== "comment");
}

export function classifyIdeaDarkSqlTokens(text: string): IdeaDarkSqlTokenStyle[] {
  const tokens: SqlWordToken[] = [];
  for (let index = 0; index < text.length; ) {
    if (/\s/.test(text[index])) {
      index++;
      continue;
    }

    const token = readSqlToken(text, index);
    if (!token) {
      index++;
      continue;
    }

    tokens.push(token);
    index = token.to;
  }

  const styles: IdeaDarkSqlTokenStyle[] = [];
  let expectSource = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "comment" || token.type === "string" || token.type === "number" || token.type === "variable") {
      styles.push({ from: token.from, to: token.to, kind: token.type });
      continue;
    }

    if (token.type === "operator") {
      styles.push({ from: token.from, to: token.to, kind: "operator" });
      continue;
    }

    if (token.type !== "word") continue;

    const value = token.value.replace(/^["`\[]|["`\]]$/g, "");
    const lowerValue = value.toLowerCase();
    const nextToken = nextSqlToken(tokens, index);
    const isFunctionCall = nextToken?.type === "punctuation" && nextToken.value === "(";

    if (expectSource) {
      styles.push({ from: token.from, to: token.to, kind: "source" });
      expectSource = nextToken?.value === ".";
      continue;
    }

    if (SQL_TYPES.has(lowerValue) && !(isFunctionCall && SQL_FUNCTIONS.has(lowerValue))) {
      styles.push({ from: token.from, to: token.to, kind: "type" });
      continue;
    }

    if (
      (SQL_FUNCTIONS.has(lowerValue) || (isFunctionCall && !SQL_KEYWORDS.has(lowerValue))) &&
      lowerValue !== "select"
    ) {
      styles.push({ from: token.from, to: token.to, kind: "function" });
      continue;
    }

    if (SQL_KEYWORDS.has(lowerValue)) {
      styles.push({ from: token.from, to: token.to, kind: "keyword" });
      expectSource = SQL_SOURCE_KEYWORDS.has(lowerValue);
      continue;
    }

    styles.push({ from: token.from, to: token.to, kind: "identifier" });
  }

  return styles;
}

export async function loadIdeaDarkEditorTheme(): Promise<Extension> {
  const [{ EditorView }, { HighlightStyle, syntaxHighlighting }, { oneDarkHighlightStyle }] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/language"),
    import("@codemirror/theme-one-dark"),
  ]);

  const theme = EditorView.theme(
    {
      "&": {
        "--dbx-editor-gutter-divider": IDEA_DARK_EDITOR_COLORS.panelBorder,
        backgroundColor: IDEA_DARK_EDITOR_COLORS.background,
        color: IDEA_DARK_EDITOR_COLORS.foreground,
      },
      ".cm-scroller": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.background,
      },
      ".cm-content": {
        caretColor: IDEA_DARK_EDITOR_COLORS.cursor,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: IDEA_DARK_EDITOR_COLORS.cursor,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: `${IDEA_DARK_EDITOR_COLORS.selection} !important`,
      },
      ".cm-activeLine": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.activeLine,
      },
      ".cm-gutters": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.background,
        color: IDEA_DARK_EDITOR_COLORS.mutedForeground,
      },
      ".cm-activeLineGutter": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.activeLine,
        color: IDEA_DARK_EDITOR_COLORS.foreground,
      },
      ".cm-foldPlaceholder": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.panel,
        borderColor: IDEA_DARK_EDITOR_COLORS.panelBorder,
        color: IDEA_DARK_EDITOR_COLORS.mutedForeground,
      },
      ".cm-tooltip": {
        backgroundColor: IDEA_DARK_EDITOR_COLORS.panel,
        borderColor: IDEA_DARK_EDITOR_COLORS.panelBorder,
        color: IDEA_DARK_EDITOR_COLORS.foreground,
      },
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "#2d3a4d",
        color: IDEA_DARK_EDITOR_COLORS.foreground,
      },
      ".cm-searchMatch": {
        backgroundColor: "#5a4a23",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: "#6b5425",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "#3b3f45",
        outline: "1px solid #5f6368",
      },
      ".cm-dbxi-sql-comment, .cm-dbxi-sql-comment *": {
        color: `${IDEA_DARK_EDITOR_COLORS.comment} !important`,
      },
      ".cm-dbxi-sql-function, .cm-dbxi-sql-function *": {
        color: `${IDEA_DARK_EDITOR_COLORS.function} !important`,
        fontStyle: "italic",
      },
      ".cm-dbxi-sql-identifier, .cm-dbxi-sql-identifier *": {
        color: `${IDEA_DARK_EDITOR_COLORS.name} !important`,
      },
      ".cm-dbxi-sql-keyword, .cm-dbxi-sql-keyword *": {
        color: `${IDEA_DARK_EDITOR_COLORS.keyword} !important`,
      },
      ".cm-dbxi-sql-number, .cm-dbxi-sql-number *": {
        color: `${IDEA_DARK_EDITOR_COLORS.operator} !important`,
      },
      ".cm-dbxi-sql-operator, .cm-dbxi-sql-operator *": {
        color: `${IDEA_DARK_EDITOR_COLORS.foreground} !important`,
      },
      ".cm-dbxi-sql-source, .cm-dbxi-sql-source *, .cm-dbxi-sql-variable, .cm-dbxi-sql-variable *": {
        color: `${IDEA_DARK_EDITOR_COLORS.foreground} !important`,
      },
      ".cm-dbxi-sql-string, .cm-dbxi-sql-string *": {
        color: `${IDEA_DARK_EDITOR_COLORS.string} !important`,
      },
      ".cm-dbxi-sql-type, .cm-dbxi-sql-type *": {
        color: `${IDEA_DARK_EDITOR_COLORS.type} !important`,
      },
    },
    { dark: true },
  );

  const highlightSpecs = oneDarkHighlightStyle.specs.map((spec) => {
    if (!spec.color) return spec;
    return {
      ...spec,
      color: ONE_DARK_TO_IDEA_DARK_COLORS[spec.color] ?? spec.color,
    };
  });

  const highlight = syntaxHighlighting(HighlightStyle.define(highlightSpecs, { themeType: "dark" }));

  return [theme, highlight];
}

export async function loadIdeaDarkSqlHighlightOverlay(): Promise<Extension> {
  const [{ RangeSetBuilder }, { Decoration, ViewPlugin }] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
  ]);

  function buildDecorations(view: import("@codemirror/view").EditorView) {
    const builder = new RangeSetBuilder<import("@codemirror/view").Decoration>();
    for (const token of classifyIdeaDarkSqlTokens(view.state.doc.toString())) {
      builder.add(token.from, token.to, Decoration.mark({ class: IDEA_DARK_SQL_TOKEN_CLASS[token.kind] }));
    }
    return builder.finish();
  }

  return ViewPlugin.fromClass(
    class {
      decorations: import("@codemirror/view").DecorationSet;
      constructor(view: import("@codemirror/view").EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        if (update.docChanged) this.decorations = buildDecorations(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function shouldUseIdeaDarkSqlHighlight(theme: EditorTheme, appAppearance: AppThemeAppearance): boolean {
  return resolveEditorTheme(theme, appAppearance) === "idea-dark";
}

export async function loadSqlEditorTheme(
  theme: EditorTheme,
  appAppearance: AppThemeAppearance = "dark",
): Promise<Extension> {
  const editorTheme = await loadEditorTheme(theme, appAppearance);
  if (!shouldUseIdeaDarkSqlHighlight(theme, appAppearance)) return editorTheme;
  return [editorTheme, await loadIdeaDarkSqlHighlightOverlay()];
}

/** Load a CodeMirror theme extension by theme name. */
export function resolveEditorTheme(theme: EditorTheme, appAppearance: AppThemeAppearance): Exclude<EditorTheme, "app"> {
  if (theme === "app") return appAppearance === "dark" ? "idea-dark" : "vscode-light";
  return theme;
}

/** Load a CodeMirror theme extension by theme name. */
export async function loadEditorTheme(
  theme: EditorTheme,
  appAppearance: AppThemeAppearance = "dark",
): Promise<Extension> {
  const resolvedTheme = resolveEditorTheme(theme, appAppearance);
  switch (resolvedTheme) {
    case "idea-dark":
      return loadIdeaDarkEditorTheme();
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
    default:
      return loadIdeaDarkEditorTheme();
  }
}

export function buildEditorFontThemeRules(
  opts?: { fixedHeight?: boolean; scrollable?: boolean },
  defaults?: { size?: number; family?: string },
): CodeMirrorStyleSpec {
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
    ".cm-vscodeSelection": {
      opacity: "0.38",
      background: "rgb(148, 163, 184)",
    },
    ".cm-gutters": {
      borderRight: "0 !important",
      fontSize: `var(${EDITOR_FONT_SIZE_CSS_VAR}, ${defaults?.size ?? 13}px)`,
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, ${defaults?.family ?? "monospace"})`,
      position: "relative",
      userSelect: "none",
    },
    ".cm-gutters:after": {
      background: "var(--dbx-editor-gutter-divider, rgba(148, 163, 184, 0.38))",
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
      paddingRight: "16px",
      userSelect: "none",
    },
  };
}

/** Build a CodeMirror theme extension for font size + font family. */
export function editorFontTheme(
  EditorView: typeof import("@codemirror/view").EditorView,
  size: number,
  family: string,
  opts?: { fixedHeight?: boolean; scrollable?: boolean },
): Extension {
  return EditorView.theme(buildEditorFontThemeRules(opts, { size, family }));
}

export function buildSqlCompletionThemeRules(): CodeMirrorStyleSpec {
  return {
    ".cm-tooltip.cm-tooltip-autocomplete": {
      background: "var(--popover)",
      border: "1px solid color-mix(in oklch, var(--border) 82%, var(--foreground) 18%)",
      borderRadius: "8px",
      boxShadow: "0 8px 18px rgb(0 0 0 / 0.14)",
      color: "var(--popover-foreground)",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      maxWidth: "min(520px, calc(100vw - 24px))",
      minWidth: "min(280px, calc(100vw - 24px))",
      overflow: "hidden",
      padding: "4px 0",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      maxHeight: "min(280px, calc(100vh - 32px))",
      minWidth: "min(280px, calc(100vw - 24px))",
      padding: "0 4px 0 !important",
      scrollbarColor: "color-mix(in oklch, var(--muted-foreground) 44%, transparent) transparent",
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
      padding: "0 10px !important",
      transition: "background-color 90ms ease, color 90ms ease",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "color-mix(in oklch, var(--primary) 14%, var(--popover)) !important",
      color: "var(--popover-foreground) !important",
      outline: "1px solid color-mix(in oklch, var(--primary) 22%, transparent)",
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
      color: "color-mix(in oklch, var(--primary) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(TABLE_ICON),
    },
    ".cm-completionIcon-column": {
      color: "color-mix(in oklch, var(--blue-500, #3b82f6) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(COLUMNS_ICON),
    },
    ".cm-completionIcon-keyword": {
      color: "color-mix(in oklch, var(--orange-500, #f97316) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(KEYWORD_ICON),
    },
    ".cm-completionIcon-snippet": {
      color: "color-mix(in oklch, var(--violet-500, #8b5cf6) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(SNIPPET_ICON),
    },
    ".cm-completionIcon-function": {
      color: "color-mix(in oklch, var(--emerald-500, #10b981) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(FUNCTION_ICON),
    },
    ".cm-completionIcon-schema": {
      color: "color-mix(in oklch, var(--amber-500, #f59e0b) 92%, var(--popover-foreground))",
      ...lucideCompletionIconMask(SCHEMA_ICON),
    },
    ".cm-completionLabel": {
      color: "inherit",
      fontFamily: `var(${EDITOR_FONT_FAMILY_CSS_VAR}, var(--font-mono, monospace))`,
      fontSize: `clamp(12px, var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px), 14px)`,
      fontWeight: "520",
      letterSpacing: "0",
    },
    ".cm-completionMatchedText": {
      color: "oklch(0.62 0.19 255)",
      fontWeight: "700",
      textDecoration: "none",
    },
    ".cm-completionDetail": {
      color: "color-mix(in oklch, var(--popover-foreground) 68%, var(--popover))",
      fontSize: `clamp(11px, calc(var(${EDITOR_FONT_SIZE_CSS_VAR}, 13px) - 1px), 13px)`,
      fontWeight: "500",
      fontStyle: "normal",
      marginLeft: "10px",
      opacity: "1",
    },
  };
}

export function sqlCompletionTheme(EditorView: typeof import("@codemirror/view").EditorView): Extension {
  return EditorView.theme(buildSqlCompletionThemeRules());
}
