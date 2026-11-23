import { uuid } from "@/lib/common/utils";
import type { SqlSnippet } from "@/types/database";

/** Upper bound for a snippets file; real .code-snippets files are a few KB. */
export const MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES = 1024 * 1024;

export interface VscodeSnippetEntry {
  /** Map key from the source file; becomes the snippet label. */
  name: string;
  /** Resolved trigger prefix (from the "prefix" field or slugged from the name). */
  prefix: string;
  body: string;
}

export type VscodeSnippetsImportErrorCode = "too-large" | "invalid-json" | "invalid-structure" | "no-valid-snippets";

export interface VscodeSnippetsImportError {
  code: VscodeSnippetsImportErrorCode;
}

export type VscodeSnippetsParseResult = { ok: true; value: VscodeSnippetEntry[] } | { ok: false; error: VscodeSnippetsImportError };

export interface VscodeSnippetsMergeResult {
  /** Existing items (copied) followed by the imported items. */
  snippets: SqlSnippet[];
  importedCount: number;
  renamedCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * UTF-8 needs 1–3 bytes per UTF-16 code unit, so the character count alone
 * settles every text outside the ambiguous expansion band; the precise byte
 * count is only built when the length could still tip over the limit.
 */
function exceedsSnippetsImportSizeLimit(text: string): boolean {
  if (text.length > MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES) return true;
  if (text.length * 3 <= MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_VSCODE_SNIPPETS_IMPORT_FILE_BYTES;
}

function slugifySnippetName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function snippetBodyFrom(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (Array.isArray(value)) {
    const lines = value.map((line) => (typeof line === "string" || typeof line === "number" ? String(line) : null));
    if (lines.some((line) => line === null) || lines.length === 0) return null;
    const body = (lines as string[]).join("\n");
    return body.trim() ? body : null;
  }
  return null;
}

function snippetPrefixFrom(value: unknown, name: string): string | null {
  if (typeof value === "string") {
    const prefix = value.trim();
    return prefix || null;
  }
  if (Array.isArray(value)) {
    const prefix = value.find((item): item is string => typeof item === "string" && item.trim() !== "");
    return prefix ? prefix.trim() : null;
  }
  return slugifySnippetName(name) || null;
}

/**
 * Parses a VS Code snippets file (`.code-snippets` / `snippets.json`): a map of
 * snippet names to `{ prefix, body, description?, scope? }` objects. `body`
 * accepts a string or an array of lines; `description` and `scope` are ignored.
 * Placeholders such as `${1:table}` pass through untouched — dbx snippets use
 * the same syntax. Duplicate prefixes within one file are passed through;
 * `mergeImportedVscodeSnippets` owns renaming.
 */
export function parseVscodeSnippetsFile(text: string): VscodeSnippetsParseResult {
  if (exceedsSnippetsImportSizeLimit(text)) {
    return { ok: false, error: { code: "too-large" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "invalid-json" } };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: { code: "invalid-structure" } };
  }

  const entries: VscodeSnippetEntry[] = [];
  for (const [rawName, rawEntry] of Object.entries(parsed)) {
    if (!isPlainObject(rawEntry)) continue;

    const body = snippetBodyFrom(rawEntry.body);
    if (body === null) continue;

    const name = rawName.trim();
    const prefix = snippetPrefixFrom(rawEntry.prefix, name);
    if (prefix === null) continue;

    entries.push({ name: name || prefix, prefix, body });
  }

  if (entries.length === 0) {
    return { ok: false, error: { code: "no-valid-snippets" } };
  }

  return { ok: true, value: entries };
}

/**
 * Merges parsed entries after the existing draft snippets. Prefix uniqueness is
 * the only constraint dbx enforces (`saveSnippet`, `normalizeSqlSnippets`), and
 * it is an exact case-sensitive comparison, so `Sel` and `sel` may coexist. On
 * collision the imported prefix gets the smallest free `-2`, `-3`, … suffix;
 * suffixes also avoid collisions with other entries from the same batch. Labels
 * may duplicate existing ones. Never mutates `existing`.
 */
export function mergeImportedVscodeSnippets(existing: readonly SqlSnippet[], entries: readonly VscodeSnippetEntry[]): VscodeSnippetsMergeResult {
  const taken = new Set(existing.map((snippet) => snippet.prefix));
  const imported: SqlSnippet[] = [];
  let renamedCount = 0;

  for (const entry of entries) {
    let prefix = entry.prefix;
    if (taken.has(prefix)) {
      let suffix = 2;
      while (taken.has(`${entry.prefix}-${suffix}`)) suffix += 1;
      prefix = `${entry.prefix}-${suffix}`;
      renamedCount += 1;
    }
    taken.add(prefix);
    imported.push({ id: uuid(), label: entry.name || entry.prefix, prefix, body: entry.body, enabled: true });
  }

  return { snippets: [...existing.map((snippet) => ({ ...snippet })), ...imported], importedCount: entries.length, renamedCount };
}

/**
 * Serializes snippets back into the VS Code format, mirroring `parseVscodeSnippetsFile`:
 * a map of names to `{ prefix, body }`. The name is the snippet label (falling
 * back to the prefix); dbx allows duplicate labels but JSON object keys are
 * unique, so later duplicates get the same `-2`, `-3`, … disambiguation the
 * importer applies to prefixes. All snippets are exported — `enabled` has no
 * counterpart in the VS Code format, so disabled snippets come back enabled on
 * re-import.
 */
export function serializeVscodeSnippetsFile(snippets: readonly SqlSnippet[]): string {
  const entries: Record<string, { prefix: string; body: string }> = {};
  const takenNames = new Set<string>();

  for (const snippet of snippets) {
    let name = snippet.label.trim() || snippet.prefix;
    if (takenNames.has(name)) {
      let suffix = 2;
      while (takenNames.has(`${name}-${suffix}`)) suffix += 1;
      name = `${name}-${suffix}`;
    }
    takenNames.add(name);
    entries[name] = { prefix: snippet.prefix, body: snippet.body };
  }

  return `${JSON.stringify(entries, null, 2)}\n`;
}
