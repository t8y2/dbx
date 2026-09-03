import type { CellValue } from "@/lib/dataGrid/cellValue";

/** Return a browser-safe external URL only when the whole cell is an HTTP(S) URL. */
export function cellExternalUrl(value: CellValue | unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return text;
}
