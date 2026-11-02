import { isSecretConnectionProperty, quoteJdbcProperty } from "./jdbcProperties";

/** Lossless connection-parameter editing. Unchanged tokens never pass through an encoder. */
export interface ParameterSyntax {
  separator: "&" | ";" | ",";
  /** SQL Server accepts both separators, except inside JDBC brace-escaped values. */
  mixedSeparators?: boolean;
  encoding: "percent" | "literal" | "sqlserver" | "teradata";
  leadingColon?: boolean;
}

export interface ParameterEntry {
  id: string;
  key: string;
  value: string;
  hasEquals: boolean;
  editable: boolean;
}

interface ParameterToken {
  separator: string;
  raw: string;
  rawKey: string;
  rawValue: string;
  original?: ParameterEntry;
}

export interface ParameterDocument {
  source: string;
  prefix: string;
  syntax: ParameterSyntax;
  entries: ParameterEntry[];
  /** An invalid escape or an unclosed SQL Server value stays available in raw mode. */
  issues: Array<{ entryId: string; reason: "encoding" | "braces" | "key" }>;
  tokens: ParameterToken[];
}

export const QUERY_PARAMETER_SYNTAX: ParameterSyntax = { separator: "&", encoding: "percent" };
export const SQLSERVER_PARAMETER_SYNTAX: ParameterSyntax = { separator: ";", mixedSeparators: true, encoding: "sqlserver" };
export const LITERAL_PARAMETER_SYNTAX: ParameterSyntax = { separator: ";", encoding: "literal" };
export const TERADATA_PARAMETER_SYNTAX: ParameterSyntax = { separator: ",", mixedSeparators: true, encoding: "teradata" };

function decode(value: string, syntax: ParameterSyntax, isValue: boolean): string {
  if (syntax.encoding === "percent") return decodeURIComponent(value.replace(/\+/g, " "));
  if ((syntax.encoding === "sqlserver" || syntax.encoding === "teradata") && isValue) {
    const trimmed = value.trim();
    const opening = syntax.encoding === "sqlserver" ? "{" : "'";
    const closing = syntax.encoding === "sqlserver" ? "}" : "'";
    if (trimmed.startsWith(opening)) {
      if (!trimmed.endsWith(closing)) throw new Error("braces");
      return trimmed
        .slice(1, -1)
        .split(closing + closing)
        .join(closing);
    }
  }
  return value;
}

/** A parser is chosen by the actual transport; semicolons inside query values are not separators. */
export function parseConnectionParameters(source: string, syntax: ParameterSyntax = QUERY_PARAMETER_SYNTAX): ParameterDocument {
  const prefix = source.startsWith("?") ? "?" : syntax.leadingColon && source.startsWith(":") ? ":" : "";
  const text = source.slice(prefix.length);
  const document: ParameterDocument = { source, prefix, syntax, entries: [], issues: [], tokens: [] };
  let start = 0;
  let separator = "";
  let inBraces = false;
  let firstEquals = -1;
  const push = (end: number, unclosed = false) => {
    const raw = text.slice(start, end);
    const equals = raw.indexOf("=");
    const rawKey = equals < 0 ? raw : raw.slice(0, equals);
    const rawValue = equals < 0 ? "" : raw.slice(equals + 1);
    const token: ParameterToken = { separator, raw, rawKey, rawValue };
    if (raw.trim()) {
      const entry: ParameterEntry = { id: `parameter-${document.tokens.length}`, key: rawKey, value: rawValue, hasEquals: equals >= 0, editable: !unclosed };
      if (unclosed) document.issues.push({ entryId: entry.id, reason: "braces" });
      try {
        entry.key = decode(rawKey, syntax, false);
        entry.value = decode(rawValue, syntax, true);
      } catch {
        entry.editable = false;
        if (!unclosed) document.issues.push({ entryId: entry.id, reason: "encoding" });
      }
      if (!entry.key.trim()) {
        entry.editable = false;
        document.issues.push({ entryId: entry.id, reason: "key" });
      }
      token.original = { ...entry };
      document.entries.push(entry);
    }
    document.tokens.push(token);
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (syntax.encoding === "sqlserver" || syntax.encoding === "teradata") {
      const opening = syntax.encoding === "sqlserver" ? "{" : "'";
      const closing = syntax.encoding === "sqlserver" ? "}" : "'";
      if (inBraces) {
        if (char === closing && text[index + 1] === closing) index++;
        else if (char === closing) inBraces = false;
        continue;
      }
      if (char === "=" && firstEquals < 0) firstEquals = index;
      if (char === opening && firstEquals >= 0) {
        inBraces = true;
        continue;
      }
    }
    if (char === syntax.separator || (syntax.mixedSeparators && (char === "&" || char === ";"))) {
      push(index);
      start = index + 1;
      separator = char;
      firstEquals = -1;
    }
  }
  push(text.length, inBraces);
  return document;
}

function unchanged(entry: ParameterEntry, original: ParameterEntry): boolean {
  return entry.key === original.key && entry.value === original.value && entry.hasEquals === original.hasEquals;
}

function encode(value: string, syntax: ParameterSyntax, isValue: boolean): string {
  if (syntax.encoding === "percent") return encodeURIComponent(value);
  if ((syntax.encoding === "sqlserver" || syntax.encoding === "teradata") && isValue) return quoteJdbcProperty(value, syntax.encoding);
  const delimiters = syntax.mixedSeparators ? (syntax.separator === "," ? /[,;&]/ : /[;&]/) : syntax.separator === ";" ? /;/ : /&/;
  if (delimiters.test(value) || (!isValue && /[={}]/.test(value))) throw new Error("literal-delimiter");
  return value;
}

export interface ParameterWriteResult {
  value: string;
  errors: Array<{ entryId: string; reason: "key" | "encoding" | "literal-delimiter" | "opaque" | "duplicate-id" }>;
}

/** Deleted rows are explicit; unknown, empty, repeated and invalid original parameters are retained. */
export function writeConnectionParameters(document: ParameterDocument, entries: readonly ParameterEntry[]): ParameterWriteResult {
  const errors: ParameterWriteResult["errors"] = [];
  const byId = new Map<string, ParameterEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) errors.push({ entryId: entry.id, reason: "duplicate-id" });
    byId.set(entry.id, entry);
  }
  let body = "";
  let keptTokens = 0;
  const encodeEntry = (entry: ParameterEntry, token?: ParameterToken): string => {
    const original = token?.original;
    if (original && unchanged(entry, original)) return token.raw;
    if (original && !original.editable) {
      errors.push({ entryId: entry.id, reason: "opaque" });
      return token.raw;
    }
    if (!entry.key.trim()) {
      errors.push({ entryId: entry.id, reason: "key" });
      return "";
    }
    try {
      const key = original && entry.key === original.key ? token!.rawKey : encode(entry.key, document.syntax, false);
      const value = original && entry.value === original.value ? token!.rawValue : encode(entry.value, document.syntax, true);
      return `${key}${entry.hasEquals ? `=${value}` : ""}`;
    } catch (error) {
      errors.push({ entryId: entry.id, reason: error instanceof Error && error.message === "literal-delimiter" ? "literal-delimiter" : "encoding" });
      return token?.raw ?? "";
    }
  };
  for (const token of document.tokens) {
    if (token.original) {
      const entry = byId.get(token.original.id);
      if (!entry) continue;
      body += (keptTokens ? token.separator : "") + encodeEntry(entry, token);
      byId.delete(entry.id);
    } else {
      body += (keptTokens ? token.separator : "") + token.raw;
    }
    keptTokens++;
  }
  for (const entry of byId.values()) {
    const hasTrailingSeparator = body.endsWith(document.syntax.separator) || (!!document.syntax.mixedSeparators && /[;&]$/.test(body));
    body += (body && !hasTrailingSeparator ? document.syntax.separator : "") + encodeEntry(entry);
  }
  return { value: errors.length ? document.source : document.prefix + body, errors };
}

/** Display summaries must never disclose secrets or entire connection strings. */
export function parameterIsSecret(key: string): boolean {
  return isSecretConnectionProperty(key) || /password|passwd|pwd|token|secret|credential|private.?key|pvt.?key|access.?key/i.test(key);
}

/** Dedicated form controls use this too, so changing TLS/charset cannot normalize other parameters. */
export function patchConnectionParameter(source: string | undefined, name: string, value: string | null, options: { aliases?: readonly string[]; caseInsensitive?: boolean } = {}): string {
  const document = parseConnectionParameters(source ?? "");
  const normalize = (key: string) => (options.caseInsensitive ? key.trim().toLowerCase() : key);
  const names = [name, ...(options.aliases ?? [])].map(normalize);
  let updated = false;
  const entries = document.entries.flatMap((entry) => {
    if (!names.includes(normalize(entry.key))) return [{ ...entry }];
    if (value === null || updated) return [];
    updated = true;
    // An explicit control change may replace a malformed old value; unrelated opaque tokens stay intact.
    return [{ ...entry, id: entry.editable ? entry.id : `replacement:${entry.id}`, key: name, value, hasEquals: true, editable: true }];
  });
  if (!updated && value !== null) entries.push({ id: `added:${name}`, key: name, value, hasEquals: true, editable: true });
  const result = writeConnectionParameters(document, entries);
  if (result.errors.length) throw new Error("Could not encode connection parameter");
  return result.value;
}
