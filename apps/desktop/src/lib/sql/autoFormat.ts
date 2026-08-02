import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { formatXmlSource } from "@/lib/common/xmlFormat";

/** Structured (non-SQL) content types the auto-format can recognise. */
export type AutoDetectedStructuredType = "json" | "xml";

/**
 * Result of {@link detectAndFormatStructured}.
 *
 * - `{ kind: "sql" }` — not a JSON/XML document; hand off to the SQL formatter.
 * - `{ kind: "json" | "xml", formatted }` — a valid structured document.
 * - `{ kind: "unsupported", detectedType }` — structured-looking invalid text.
 *   The caller must keep the original text unchanged and must never pass it to
 *   the SQL formatter.
 */
export type StructuredFormatResult = { kind: "sql" } | { kind: "json" | "xml"; formatted: string } | { kind: "unsupported"; detectedType: AutoDetectedStructuredType };

/** First non-whitespace character of `text`, or null when it is all whitespace. */
export function firstNonWhitespaceChar(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f" && c !== "\v") return c;
  }
  return null;
}

/**
 * Detects whether an editor selection is a JSON/XML document and formats it.
 *
 * A valid JSON document must start with `{` or `[`, but an editor selection can
 * also be a SQL fragment such as a SQL Server bracket-quoted identifier. Only a
 * successful JSON source parse is therefore classified as JSON; all other text
 * continues through the existing SQL path.
 *
 * Safety contract: valid JSON/XML is formatted before reaching the SQL formatter.
 * Invalid XML is returned as unsupported because sql-formatter silently rewrites
 * XML-looking input into corrupted output.
 */
export function detectAndFormatStructured(text: string, options: { indentSize: number; useTabs?: boolean }): StructuredFormatResult {
  const first = firstNonWhitespaceChar(text);
  if (first === "{" || first === "[") {
    try {
      return { kind: "json", formatted: formatJsonSource(text, options.indentSize) };
    } catch {
      return { kind: "sql" };
    }
  }
  if (looksLikeXml(text)) {
    try {
      return { kind: "xml", formatted: formatXmlSource(text, options.useTabs ? "\t" : " ".repeat(options.indentSize)) };
    } catch {
      return { kind: "unsupported", detectedType: "xml" };
    }
  }
  return { kind: "sql" };
}

export function looksLikeXml(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<?") || trimmed.startsWith("<!--") || /^<!DOCTYPE\b/i.test(trimmed) || /^<\/?[A-Za-z_:]/.test(trimmed);
}
