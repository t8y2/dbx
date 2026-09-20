/**
 * YAML diagnostics for the Nacos configuration editor (#9405).
 *
 * The editor's YAML mode (`@codemirror/lang-yaml`, Lezer based) is an
 * error-tolerant grammar: it parses tab indentation and duplicate mapping keys
 * as valid structure, so it can never report the two problems this feature
 * exists for. DBX already depends on the `yaml` package for Nacos validation,
 * and that parser tracks mapping scope itself and reports both with exact
 * offsets, so the diagnostics are derived from it and are only *rendered* by
 * CodeMirror's native lint extension.
 *
 * `parseAllDocuments` is required instead of `parseDocument`: Nacos YAML configs
 * commonly separate Spring Boot profile documents with `---`, which
 * `parseDocument` rejects with a `MULTIPLE_DOCS` error even though the document
 * is valid.
 */
import { parseAllDocuments, type YAMLError } from "yaml";

export type NacosYamlDiagnosticCode = "duplicateKey" | "tabIndent" | "syntaxError" | "parserWarning";
export type NacosYamlDiagnosticSeverity = "error" | "warning";

export interface NacosYamlDiagnostic {
  code: NacosYamlDiagnosticCode;
  severity: NacosYamlDiagnosticSeverity;
  /** Start offset of the offending text in the document. */
  from: number;
  /** End offset, always greater than {@link from} so the marker has a width. */
  to: number;
  /** 1-based line, for hosts that list diagnostics instead of marking them. */
  line: number;
  /** 1-based column, for hosts that list diagnostics instead of marking them. */
  column: number;
  /** English fallback used when no translation is available. */
  message: string;
  /** Interpolation values for the translated message. */
  params: Record<string, string>;
}

export type NacosYamlDiagnosticTranslator = (key: string, params: Record<string, string>) => string;

const MESSAGE_KEYS: Record<NacosYamlDiagnosticCode, string> = {
  duplicateKey: "nacos.yamlDiagnosticDuplicateKey",
  tabIndent: "nacos.yamlDiagnosticTabIndent",
  syntaxError: "nacos.yamlDiagnosticSyntaxError",
  parserWarning: "nacos.yamlDiagnosticParserWarning",
};

/** i18n key for a diagnostic code, kept in one place so hosts cannot drift. */
export function nacosYamlDiagnosticMessageKey(code: NacosYamlDiagnosticCode): string {
  return MESSAGE_KEYS[code];
}

/**
 * Localize a diagnostic, falling back to its English message when the active
 * locale has no entry (vue-i18n returns the key itself in that case).
 */
export function translateNacosYamlDiagnostic(diagnostic: Pick<NacosYamlDiagnostic, "code" | "message" | "params">, translate: NacosYamlDiagnosticTranslator): string {
  const key = nacosYamlDiagnosticMessageKey(diagnostic.code);
  const translated = translate(key, diagnostic.params);
  return translated.length > 0 && translated !== key ? translated : diagnostic.message;
}

/**
 * Every problem `yaml` finds in `text`, in document order.
 *
 * Duplicate keys are `error`: the project's own parser rejects them
 * (`DUPLICATE_KEY`), Spring Boot's `OriginTrackedYamlLoader` fails startup on
 * them, and DBX already blocked publishing on them before this feature. Parser
 * *warnings* stay `warning` and never block publishing.
 */
export function analyzeNacosYaml(text: string): NacosYamlDiagnostic[] {
  if (!text.trim()) return [];

  const diagnostics: NacosYamlDiagnostic[] = [];
  for (const document of parseAllDocuments(text)) {
    for (const error of document.errors) diagnostics.push(nacosYamlParserDiagnostic(text, error, "error"));
    for (const warning of document.warnings) diagnostics.push(nacosYamlParserDiagnostic(text, warning, "warning"));
  }
  return dedupeNacosYamlDiagnostics(diagnostics);
}

function nacosYamlParserDiagnostic(text: string, error: YAMLError, severity: NacosYamlDiagnosticSeverity): NacosYamlDiagnostic {
  const code = diagnosticCodeFor(error, severity);
  const range = code === "duplicateKey" ? yamlKeyRange(text, error.pos[0], error.pos[1]) : clampRange(text, error.pos[0], error.pos[1]);
  const { line, column } = yamlLineColumn(text, error);
  const key = code === "duplicateKey" ? yamlKeyName(text.slice(range.from, range.to)) : "";
  const reason = yamlMessageReason(error.message);

  if (code === "duplicateKey") {
    return { code, severity, ...range, line, column, message: yamlFallbackMessage(code, reason, key), params: { key } };
  }
  if (code === "tabIndent") {
    return { code, severity, ...range, line, column, message: yamlFallbackMessage(code, reason, ""), params: {} };
  }
  return { code, severity, ...range, line, column, message: yamlFallbackMessage(code, reason, ""), params: { reason } };
}

function diagnosticCodeFor(error: YAMLError, severity: NacosYamlDiagnosticSeverity): NacosYamlDiagnosticCode {
  if (error.code === "DUPLICATE_KEY") return "duplicateKey";
  if (error.code === "TAB_AS_INDENT") return "tabIndent";
  return severity === "warning" ? "parserWarning" : "syntaxError";
}

/** English text for hosts that render `message` directly, mirroring the i18n keys. */
function yamlFallbackMessage(code: NacosYamlDiagnosticCode, reason: string, key: string): string {
  if (code === "duplicateKey") return `Duplicate mapping key: ${key}`;
  if (code === "tabIndent") return "YAML indentation must not use tab characters; use spaces instead";
  if (code === "parserWarning") return `YAML parser warning: ${reason}`;
  return `YAML syntax error: ${reason}`;
}

/**
 * `yaml` appends ` at line N, column M:` plus a source excerpt and a caret to
 * every message; both are redundant next to a positioned marker.
 */
function yamlMessageReason(message: string): string {
  const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.replace(/\s+at line \d+, column \d+:?\s*$/, "");
}

/**
 * `DUPLICATE_KEY` points at the first character of the repeated key only, so the
 * range is widened to the whole key. Keys are never widened past `:` or the end
 * of the line, which keeps a wide marker from swallowing the value.
 */
function yamlKeyRange(text: string, start: number, parserEnd: number): { from: number; to: number } {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    const closing = closingQuoteIndex(text, start, quote);
    if (closing > start) return clampRange(text, start, closing + 1);
  }

  let end = start;
  while (end < text.length && text[end] !== ":" && text[end] !== "\n" && text[end] !== "\r") end += 1;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end -= 1;
  return clampRange(text, start, Math.max(end, parserEnd));
}

function closingQuoteIndex(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

function yamlKeyName(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return quoted ? trimmed.slice(1, -1) : trimmed;
}

function clampRange(text: string, from: number, to: number): { from: number; to: number } {
  const start = Math.min(Math.max(from, 0), Math.max(0, text.length - 1));
  const end = Math.min(Math.max(to, start + 1), text.length);
  return { from: start, to: end };
}

function yamlLineColumn(text: string, error: YAMLError): { line: number; column: number } {
  const position = error.linePos?.[0];
  if (position && position.line >= 1 && position.col >= 1) return { line: position.line, column: position.col };
  return offsetLineColumn(text, error.pos[0]);
}

function offsetLineColumn(text: string, offset: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, bounded);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: bounded - lineStart + 1 };
}

/**
 * One broken construct is often reported more than once — a tab also raises
 * `BLOCK_AS_IMPLICIT_KEY`, and `MULTILINE_IMPLICIT_KEY` spans the narrower
 * `BLOCK_AS_IMPLICIT_KEY` range — so identical and contained ranges collapse
 * into the widest diagnostic instead of stacking near-duplicate markers.
 */
function dedupeNacosYamlDiagnostics(diagnostics: readonly NacosYamlDiagnostic[]): NacosYamlDiagnostic[] {
  const kept: NacosYamlDiagnostic[] = [];
  for (const diagnostic of [...diagnostics].sort((left, right) => left.from - right.from || right.to - left.to)) {
    const seen = kept.some((candidate) => diagnostic.from >= candidate.from && diagnostic.to <= candidate.to);
    if (!seen) kept.push(diagnostic);
  }
  return kept;
}
