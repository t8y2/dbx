export function hexToRgba(color: string | undefined, alpha: number): string | undefined {
  if (!color) return undefined;
  const trimmed = color.trim();

  // Already rgba/rgb: replace or add alpha, then return
  const rgbaMatch = trimmed.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i);
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${alpha})`;
  }
  const rgbMatch = trimmed.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }

  const hex = trimmed.replace(/^#/, "");
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return undefined;

  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Hue in degrees (0-360); saturation and value as 0-1 fractions. */
export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseHexChannels(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, "");
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((char) => char + char)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * @param color Hex color, with or without the leading hash
 * @return Matching HSV coordinates, or null when the input is not a hex color
 */
export function hexToHsv(color: string): HsvColor | null {
  const channels = parseHexChannels(color);
  if (!channels) return null;
  const [r, g, b] = channels.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }

  return { h: (h + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

/**
 * @param hsv HSV coordinates; hue wraps and the fractions are clamped
 * @return Lowercase `#rrggbb` string
 */
export function hsvToHex(hsv: HsvColor): string {
  const hue = (((Number.isNaN(hsv.h) ? 0 : hsv.h) % 360) + 360) % 360;
  const chroma = clamp01(hsv.v) * clamp01(hsv.s);
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = clamp01(hsv.v) - chroma;
  const sector = Math.floor(hue / 60) % 6;
  const rgb = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][sector];

  return `#${rgb
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
