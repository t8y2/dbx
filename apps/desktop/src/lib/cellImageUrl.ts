import type { CellValue } from "@/lib/cellValue";

const IMAGE_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z0-9+/=\s]+$/i;

function isLocalHttpHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function cellImagePreviewUrl(value: CellValue): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (SAFE_DATA_IMAGE_RE.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!IMAGE_PATH_RE.test(url.pathname)) return null;
  return text;
}
