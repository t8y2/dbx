/**
 * Code snapshot rendering & export utilities (CodeSnap-style).
 *
 * Flow: selected code text -> shiki re-render (reusing the AI highlighter
 * singleton) -> CodeSnap-like shell DOM (traffic lights / title / line
 * numbers / background) -> PNG export either to the system clipboard
 * (Tauri `writeImage`) or to a file (dialog + fs, with a browser-download
 * fallback for web mode).
 *
 * The rendered snapshot DOM is fully self-contained: it embeds its own
 * `<style>` tag so `dom-to-image-more` captures identical styling when it
 * clones the node into a foreignObject.
 */
import type { AppThemeAppearance } from "@/lib/app/appTheme";
import { createAiShikiCodeHighlighter, type AiCodeHighlighter } from "@/lib/ai/aiCodeHighlighter";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export interface CodeSnapshotSource {
  code: string;
  /** Shiki language name or AI label (e.g. "sql", "python", "JSON"). */
  lang: string;
  /** Optional title shown in the snapshot bar next to the traffic lights. */
  title?: string;
}

export interface CodeSnapshotStyleOptions {
  appearance: AppThemeAppearance;
  /** Render the macOS-style traffic light dots. Defaults to true. */
  showTrafficLights?: boolean;
  /** Render line numbers via CSS counters. Defaults to true. */
  showLineNumbers?: boolean;
  /** Padding (px) around the code area. Defaults to 16. */
  padding?: number;
  /** Code font size (px). Defaults to 13. */
  fontSize?: number;
}

const SNAPSHOT_BACKGROUND: Record<AppThemeAppearance, string> = {
  light: "#ffffff",
  dark: "#0d1117",
};

const SNAPSHOT_BAR_BACKGROUND: Record<AppThemeAppearance, string> = {
  light: "#f6f8fa",
  dark: "#161b22",
};

const SNAPSHOT_BAR_TEXT: Record<AppThemeAppearance, string> = {
  light: "#57606a",
  dark: "#8b949e",
};

const SNAPSHOT_LINE_NUMBER: Record<AppThemeAppearance, string> = {
  light: "#d0d7de",
  dark: "#484f58",
};

const TRAFFIC_LIGHT_COLORS = ["#ff5f57", "#febc2e", "#28c840"] as const;
const MAX_EXPORT_PIXEL_RATIO = 2;

/**
 * Self-contained stylesheet embedded in every snapshot DOM. Keep it prefix
 * namespaced (`dbx-code-snapshot`) so it never leaks into the app chrome.
 */
export const CODE_SNAPSHOT_CSS = `
.dbx-code-snapshot {
  border-radius: 8px;
  overflow: hidden;
  font-family: "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace;
  text-align: left;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.dbx-code-snapshot__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}
.dbx-code-snapshot__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
}
.dbx-code-snapshot__title {
  margin-left: 4px;
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dbx-code-snapshot__pre {
  margin: 0;
  overflow: hidden;
  line-height: 1.6;
  tab-size: 4;
}
.dbx-code-snapshot__pre code {
  font-family: inherit;
  font-size: inherit;
  background: transparent;
}
.dbx-code-snapshot__pre .line {
  display: block;
  min-height: 1.6em;
}
.dbx-code-snapshot__pre--numbered {
  counter-reset: dbx-snapshot-line;
}
.dbx-code-snapshot__pre--numbered .line {
  counter-increment: dbx-snapshot-line;
}
.dbx-code-snapshot__pre--numbered .line::before {
  content: counter(dbx-snapshot-line);
  display: inline-block;
  min-width: 2.2em;
  margin-right: 1.4em;
  text-align: right;
  color: var(--dbx-snapshot-line-number, #8b949e);
  font-variant-numeric: tabular-nums;
  user-select: none;
  -webkit-user-select: none;
}
`;

let highlighterPromise: Promise<AiCodeHighlighter> | undefined;

/** Lazy singleton reusing the AI assistant's shiki highlighter instance. */
export function getCodeSnapshotHighlighter(): Promise<AiCodeHighlighter> {
  highlighterPromise ??= createAiShikiCodeHighlighter({
    appearance: () => "dark",
  }).catch((err: unknown) => {
    // Reset so a transient highlighter failure can be retried on the next
    // render instead of permanently poisoning the singleton.
    highlighterPromise = undefined;
    throw err;
  });
  return highlighterPromise;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderSnapshotBar(title: string | undefined, appearance: AppThemeAppearance, showTrafficLights: boolean): string {
  const dots = showTrafficLights ? TRAFFIC_LIGHT_COLORS.map((color) => `<span class="dbx-code-snapshot__dot" style="background:${color}"></span>`).join("") : "";
  const titleHtml = title ? `<span class="dbx-code-snapshot__title" style="color:${SNAPSHOT_BAR_TEXT[appearance]}">${escapeHtml(title)}</span>` : "";
  return `<div class="dbx-code-snapshot__bar" style="background:${SNAPSHOT_BAR_BACKGROUND[appearance]};color:${SNAPSHOT_BAR_TEXT[appearance]}">${dots}${titleHtml}</div>`;
}

/**
 * Render a self-contained snapshot DOM (as an HTML string) for the given code.
 * The returned string includes its own `<style>` tag and can be injected via
 * `v-html`, then exported with `snapshotElementToPng`.
 */
export async function renderCodeSnapshotHtml(source: CodeSnapshotSource, options: CodeSnapshotStyleOptions): Promise<string> {
  const highlight = await getCodeSnapshotHighlighter();
  const body = highlight(source.code, source.lang, options.appearance);

  const appearance = options.appearance;
  const showBar = options.showTrafficLights !== false || !!source.title;
  const showLineNumbers = options.showLineNumbers !== false;
  const padding = options.padding ?? 16;
  const fontSize = options.fontSize ?? 13;

  const bar = showBar ? renderSnapshotBar(source.title, appearance, options.showTrafficLights !== false) : "";
  const preClass = `dbx-code-snapshot__pre${showLineNumbers ? " dbx-code-snapshot__pre--numbered" : ""}`;
  const lineNumberColor = SNAPSHOT_LINE_NUMBER[appearance];

  return (
    `<style>${CODE_SNAPSHOT_CSS}</style>` +
    `<div class="dbx-code-snapshot" data-snapshot-appearance="${appearance}" style="background:${SNAPSHOT_BACKGROUND[appearance]};font-size:${fontSize}px">` +
    bar +
    `<pre class="${preClass}" style="--dbx-snapshot-line-number:${lineNumberColor};padding:0 ${padding}px ${padding}px"><code>${body}</code></pre>` +
    `</div>`
  );
}

/** Convert a snapshot DOM element into a PNG data URL. */
export async function snapshotElementToPng(element: HTMLElement): Promise<string> {
  const domtoimage = (await import("dom-to-image-more")).default;
  return domtoimage.toPng(element, {
    quality: 1,
    width: element.offsetWidth,
    height: element.offsetHeight,
    // Preserve text sharpness on high-DPI displays without letting a large
    // selected block allocate an unbounded export canvas.
    pixelRatio: Math.min(MAX_EXPORT_PIXEL_RATIO, Math.max(1, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1)),
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return await (await fetch(dataUrl)).blob();
}

/**
 * Copy a PNG data URL to the system clipboard. Uses the Tauri
 * clipboard-manager `writeImage` on desktop and falls back to the Web
 * Clipboard API (`ClipboardItem`) for web mode.
 */
export async function copyPngDataUrlToClipboard(dataUrl: string): Promise<void> {
  const blob = await dataUrlToBlob(dataUrl);
  if (isTauriRuntime()) {
    const { writeImage } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeImage(new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return;
  }
  throw new Error("Clipboard image write is not supported in this environment");
}

/**
 * Save a PNG data URL to a file. On desktop this opens the native save
 * dialog; on web it downloads the image. Returns false when the user
 * cancels the native save dialog.
 */
export async function savePngDataUrlToFile(dataUrl: string, defaultName: string): Promise<boolean> {
  const blob = await dataUrlToBlob(dataUrl);
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!path) return false;
    // Native write errors must reach the caller so the UI never claims the
    // user-selected path was saved when the filesystem rejected it.
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultName;
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}
