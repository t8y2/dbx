export const BACKGROUND_IMAGE_STORAGE_LIMIT_BYTES = 20 * 1024 * 1024;

export const BACKGROUND_IMAGE_MIN_OPACITY = 0.05;
export const BACKGROUND_IMAGE_MAX_OPACITY = 1;
// Surface opacity: how opaque the app surfaces render over the wallpaper.
// 1 = solid surfaces (no image visible), 0.05 = strongest wallpaper.
export const BACKGROUND_IMAGE_DEFAULT_OPACITY = 0.8;
export const BACKGROUND_IMAGE_MAX_BLUR_PX = 20;
export const BACKGROUND_IMAGE_DEFAULT_BLUR_PX = 0;

export const BACKGROUND_IMAGE_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"] as const;

export type BackgroundImageSettings = {
  filePath: string | null;
  fileName: string | null;
  opacity: number;
  blur: number;
};

export function defaultBackgroundImageSettings(): BackgroundImageSettings {
  return {
    filePath: null,
    fileName: null,
    opacity: BACKGROUND_IMAGE_DEFAULT_OPACITY,
    blur: BACKGROUND_IMAGE_DEFAULT_BLUR_PX,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeBackgroundImageSettings(value: unknown): BackgroundImageSettings {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    filePath: normalizeOptionalText(source.filePath),
    fileName: normalizeOptionalText(source.fileName),
    opacity: clampNumber(source.opacity, BACKGROUND_IMAGE_MIN_OPACITY, BACKGROUND_IMAGE_MAX_OPACITY, BACKGROUND_IMAGE_DEFAULT_OPACITY),
    blur: clampNumber(source.blur, 0, BACKGROUND_IMAGE_MAX_BLUR_PX, BACKGROUND_IMAGE_DEFAULT_BLUR_PX),
  };
}

/** Extension (lowercase, no dot) for dialog filters and stored-copy naming; null when the name has none. */
export function backgroundImageFileExtension(fileName: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  if (!match) return null;
  const extension = match[1].toLowerCase();
  return (BACKGROUND_IMAGE_FILE_EXTENSIONS as readonly string[]).includes(extension) ? extension : null;
}

/** Blur softens edges outward, which would reveal transparent margins: scale slightly to cover. */
export function backgroundImageStyle(settings: Pick<BackgroundImageSettings, "blur">): Record<string, string> {
  if (settings.blur > 0) {
    return { filter: `blur(${settings.blur}px)`, transform: "scale(1.06)" };
  }
  return {};
}

/**
 * Root surface variables that become translucent while a wallpaper is active.
 * Card/popover/dialog surfaces stay opaque on purpose: floating panels keep
 * their text readable regardless of what the wallpaper shows behind them.
 */
export const BACKGROUND_IMAGE_SURFACE_VARS = ["--background", "--sidebar", "--muted", "--secondary", "--accent", "--dbx-chrome", "--dbx-chrome-muted", "--dbx-content", "--dbx-editor-toolbar", "--dbx-gutter", "--dbx-sidebar-header"] as const;

/** Alpha for the surface variables derived from the surface-opacity setting. */
export function backgroundImageSurfaceAlpha(settings: Pick<BackgroundImageSettings, "opacity">): number {
  return clampNumber(settings.opacity, BACKGROUND_IMAGE_MIN_OPACITY, BACKGROUND_IMAGE_MAX_OPACITY, BACKGROUND_IMAGE_DEFAULT_OPACITY);
}

/** Parses "#rgb", "#rrggbb", "rgb(r g b)", "rgb(r, g, b)" and "rgb(r g b / a)" into an rgb triplet; null when unparsable. */
export function parseCssColorTriplet(value: string): [number, number, number] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const rgbMatch = /^rgba?\((\d+)\s*,?\s+(\d+)\s*,?\s+(\d+)(?:\s*\/\s*[\d.]+)?\)$/i.exec(trimmed);
  if (rgbMatch) return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : null;
  if (hex && (hex.length === 3 || hex.length === 6)) {
    const expand =
      hex.length === 3
        ? hex
            .split("")
            .map((char) => char + char)
            .join("")
        : hex;
    return [parseInt(expand.slice(0, 2), 16), parseInt(expand.slice(2, 4), 16), parseInt(expand.slice(4, 6), 16)];
  }
  return null;
}

/**
 * Re-emit a surface color with the given alpha, e.g. "rgb(17 18 20 / 0.8)".
 * Keeps the source notation when possible: wide-gamut palettes declare their
 * tokens in oklch (see the @supports block in globals.css) and converting them
 * to rgb would clip them; hsl stays hsl, oklch stays oklch, hex/rgb become rgb.
 * Also accepts raw "H S% L%" channel triplets as used by shadcn-style themes.
 */
export function surfaceColorWithAlpha(color: string, alpha: number): string | null {
  const trimmed = color.trim();
  if (!trimmed) return null;
  const fnMatch = /^([a-zA-Z-]+)\(([^()]+)\)$/.exec(trimmed);
  if (fnMatch) {
    const fn = fnMatch[1].toLowerCase();
    const inner = fnMatch[2].trim();
    if (fn === "rgb" || fn === "rgba") {
      const triplet = parseCssColorTriplet(trimmed);
      return triplet ? `rgb(${triplet[0]} ${triplet[1]} ${triplet[2]} / ${alpha})` : null;
    }
    if (inner.includes(",")) {
      const parts = inner.split(",").map((part) => part.trim());
      if (parts.length !== 3 || parts.some((part) => !part)) return null;
      return `${fn}(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
    const base = inner.split("/")[0].trim();
    if (!base) return null;
    return `${fn}(${base} / ${alpha})`;
  }
  if (trimmed.startsWith("#")) {
    const triplet = parseCssColorTriplet(trimmed);
    return triplet ? `rgb(${triplet[0]} ${triplet[1]} ${triplet[2]} / ${alpha})` : null;
  }
  if (/^[\d.]+%?\s+[\d.]+%?\s+[\d.]+%?$/.test(trimmed)) {
    return `hsl(${trimmed} / ${alpha})`;
  }
  return null;
}
