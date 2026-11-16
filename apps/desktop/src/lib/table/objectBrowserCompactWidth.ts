export const OBJECT_BROWSER_COMPACT_WIDTHS = [160, 200, 240] as const;
export type ObjectBrowserCompactWidth = (typeof OBJECT_BROWSER_COMPACT_WIDTHS)[number];
export const DEFAULT_OBJECT_BROWSER_COMPACT_WIDTH: ObjectBrowserCompactWidth = 160;

export function normalizeObjectBrowserCompactWidth(value: unknown): ObjectBrowserCompactWidth {
  return OBJECT_BROWSER_COMPACT_WIDTHS.includes(value as ObjectBrowserCompactWidth) ? (value as ObjectBrowserCompactWidth) : DEFAULT_OBJECT_BROWSER_COMPACT_WIDTH;
}
