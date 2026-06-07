import type { Extension } from "@codemirror/state";
import type { EditorTheme } from "@/stores/settingsStore";
import type { AppThemeAppearance } from "@/lib/appTheme";

type CodeMirrorStyleSpec = Parameters<typeof import("@codemirror/view").EditorView.theme>[0];
type LucideIconNode = Array<[string, Record<string, string>]>;

export const EDITOR_FONT_SIZE_CSS_VAR = "--dbx-editor-font-size";
export const EDITOR_FONT_FAMILY_CSS_VAR = "--dbx-editor-font-family";

const SUPPORTS_COLOR_MIX =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("color", "color-mix(in oklch, black 50%, white)");
const SUPPORTS_OKLCH =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("color", "oklch(0.62 0.19 255)");

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
export async function loadEditorTheme(
  theme: EditorTheme,
  appAppearance: AppThemeAppearance = "dark",
): Promise<Extension> {
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
    default:
      return (await import("@codemirror/theme-one-dark")).oneDark;
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
      border: colorMixValue(
        "1px solid var(--border)",
        "1px solid color-mix(in oklch, var(--border) 82%, var(--foreground) 18%)",
      ),
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
      scrollbarColor: colorMixValue(
        "var(--muted-foreground) transparent",
        "color-mix(in oklch, var(--muted-foreground) 44%, transparent) transparent",
      ),
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
      background: `${colorMixValue("var(--accent)", "color-mix(in oklch, var(--primary) 14%, var(--popover))")} !important`,
      color: "var(--popover-foreground) !important",
      outline: colorMixValue(
        "1px solid var(--border)",
        "1px solid color-mix(in oklch, var(--primary) 22%, transparent)",
      ),
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
      color: colorMixValue(
        "var(--blue-500, #3b82f6)",
        "color-mix(in oklch, var(--blue-500, #3b82f6) 92%, var(--popover-foreground))",
      ),
      ...lucideCompletionIconMask(COLUMNS_ICON),
    },
    ".cm-completionIcon-keyword": {
      color: colorMixValue(
        "var(--orange-500, #f97316)",
        "color-mix(in oklch, var(--orange-500, #f97316) 92%, var(--popover-foreground))",
      ),
      ...lucideCompletionIconMask(KEYWORD_ICON),
    },
    ".cm-completionIcon-snippet": {
      color: colorMixValue(
        "var(--violet-500, #8b5cf6)",
        "color-mix(in oklch, var(--violet-500, #8b5cf6) 92%, var(--popover-foreground))",
      ),
      ...lucideCompletionIconMask(SNIPPET_ICON),
    },
    ".cm-completionIcon-function": {
      color: colorMixValue(
        "var(--emerald-500, #10b981)",
        "color-mix(in oklch, var(--emerald-500, #10b981) 92%, var(--popover-foreground))",
      ),
      ...lucideCompletionIconMask(FUNCTION_ICON),
    },
    ".cm-completionIcon-schema": {
      color: colorMixValue(
        "var(--amber-500, #f59e0b)",
        "color-mix(in oklch, var(--amber-500, #f59e0b) 92%, var(--popover-foreground))",
      ),
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
      color: oklchValue("rgb(29 132 245)", "oklch(0.62 0.19 255)"),
      fontWeight: "700",
      textDecoration: "none",
    },
    ".cm-completionDetail": {
      color: colorMixValue(
        "var(--muted-foreground)",
        "color-mix(in oklch, var(--popover-foreground) 68%, var(--popover))",
      ),
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
