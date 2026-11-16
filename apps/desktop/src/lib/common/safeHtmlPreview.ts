/** CSP used by read-only HTML previews rendered inside sandboxed iframes. */
export const SAFE_HTML_PREVIEW_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";

const META_REFRESH_PATTERN = /<meta\b[^>]*?\bhttp-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh\b)[^>]*>/gi;

/** Wrap untrusted HTML in a CSP-protected document and remove meta refresh navigation. */
export function buildSafeHtmlPreview(content: string): string {
  const safeContent = content.replace(META_REFRESH_PATTERN, "<!-- meta refresh removed -->");
  return ["<!doctype html>", "<html>", "<head>", '<meta charset="utf-8">', `<meta http-equiv="Content-Security-Policy" content="${SAFE_HTML_PREVIEW_CSP}">`, "</head>", "<body>", safeContent, "</body>", "</html>"].join("\n");
}
