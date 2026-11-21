import type { AnnotationFile } from "@/docs/types";
import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

/**
 * Character budgets for notes injected into the AI schema prompt. Mirrors
 * `crates/dbx-core/src/data/docs/annotations.rs`; keeping the numbers identical
 * means the same note is truncated the same way in the built-in prompt and in
 * the Rust tool results.
 */
export const SCHEMA_NOTE_TABLE_MAX_CHARS = 2_000;
export const SCHEMA_NOTE_COLUMN_MAX_CHARS = 500;
export const SCHEMA_NOTE_TOTAL_MAX_CHARS = 8_000;

/**
 * The instruction/data boundary for local notes. Mirrors
 * `crates/dbx-core/src/data/docs/annotations.rs`: a note is always wrapped in
 * these markers, and delimiters inside it are escaped, so adversarial text
 * cannot forge a closing marker. MCP clients do not receive DBX's system
 * prompt, so the boundary must travel with the data.
 */
export const LOCAL_NOTE_OPEN = "[local-note]";
export const LOCAL_NOTE_CLOSE = "[/local-note]";

export function renderUntrustedNote(note: string): string {
  // Brackets are escaped because the markers themselves are bracketed, so a
  // note containing `[/local-note]` cannot forge the closing marker.
  const escaped = note.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;");
  return `${LOCAL_NOTE_OPEN}${escaped}${LOCAL_NOTE_CLOSE}`;
}

/**
 * Mirror of `dbx_core::docs::keys::fold_identifier`.
 *
 * The notes file is keyed by `schema.table` with database-specific case
 * folding. Doing this in TypeScript MUST stay in sync with the Rust reader:
 * PostgreSQL/MySQL and the rest fold to lower case, Oracle to upper case, and
 * ClickHouse/MongoDB are genuinely case-sensitive. A mismatch would attach a
 * note to the wrong table (or silently drop it).
 */
export function foldIdentifier(dbType: DatabaseType, value: string): string {
  switch (dbType) {
    case "oracle":
      return value.toUpperCase();
    case "clickhouse":
    case "mongodb":
      return value;
    default:
      return value.toLowerCase();
  }
}

function tableKey(dbType: DatabaseType, schema: string | undefined, table: string): string {
  const foldedTable = foldIdentifier(dbType, table);
  return schema ? `${foldIdentifier(dbType, schema)}.${foldedTable}` : foldedTable;
}

/**
 * The notes entry for a table. The qualified `schema.table` key wins; on a miss
 * the bare table key is tried too.
 *
 * The documentation collector stores non-schema-aware engines (MySQL, SQLite)
 * under the bare table name, while the AI context carries a namespace anyway
 * (SQLite's "main", or MySQL's database used as the schema argument). Trying
 * the bare key only after the qualified one misses keeps a `public.orders` note
 * from leaking into another schema.
 */
function tableEntry(annotations: AnnotationFile, dbType: DatabaseType, schema: string | undefined, table: string) {
  const qualified = tableKey(dbType, schema, table);
  const direct = annotations.tables?.[qualified];
  if (direct) return direct;
  const bare = tableKey(dbType, undefined, table);
  return bare === qualified ? undefined : annotations.tables?.[bare];
}

/** The local note for a table, if the notes file defines one. */
export function localTableNote(annotations: AnnotationFile, dbType: DatabaseType, schema: string | undefined, table: string): string | undefined {
  const note = tableEntry(annotations, dbType, schema, table)?.note?.trim();
  return note || undefined;
}

/** The local note for a column, if the notes file defines one. */
export function localColumnNote(annotations: AnnotationFile, dbType: DatabaseType, schema: string | undefined, table: string, column: string): string | undefined {
  const entry = tableEntry(annotations, dbType, schema, table);
  if (!entry?.columns) return undefined;
  const folded = foldIdentifier(dbType, column);
  for (const [name, annotation] of Object.entries(entry.columns)) {
    if (foldIdentifier(dbType, name) === folded) {
      const note = annotation.note?.trim();
      return note || undefined;
    }
  }
  return undefined;
}

/**
 * Shared character budget for one prompt/tool result. Once it is exhausted,
 * later notes fall back to the database comment instead of growing the prompt
 * without bound.
 */
export class SchemaNoteBudget {
  private remaining = SCHEMA_NOTE_TOTAL_MAX_CHARS;
  private appliedCount = 0;

  take(note: string | undefined, perNoteMax: number): string | undefined {
    // The note is rendered inside a per-column prompt line (`- name: type --
    // note`); Markdown newlines would otherwise look like extra schema lines.
    // The documentation viewer still renders the original Markdown.
    const trimmed = note?.trim().replace(/\s+/g, " ");
    if (!trimmed || this.remaining <= 0 || perNoteMax <= 0) return undefined;
    const limit = Math.min(perNoteMax, this.remaining);
    // Code points, matching Rust's `chars()`, so a surrogate pair is never cut
    // in half.
    const chars = Array.from(trimmed);
    const capped = chars.slice(0, limit).join("");
    const result = chars.length > limit ? `${capped}…` : capped;
    this.remaining -= Math.min(chars.length, limit);
    this.appliedCount += 1;
    return result;
  }

  get remainingChars(): number {
    return this.remaining;
  }

  /** How many notes actually made it into the context. */
  get applied(): number {
    return this.appliedCount;
  }
}

export interface SchemaNotes {
  annotations?: AnnotationFile;
  /** Set when the notes file exists but could not be read; AI keeps working. */
  warning?: string;
}

/**
 * Load the connection's documentation notes for an AI request.
 *
 * Errors are fail-open: a malformed notes file must not block the chat, but the
 * model is told that notes are unavailable (see the warning line appended by
 * `buildSystemPrompt`). `null` (no file) is the normal first-run state.
 */
export async function loadSchemaNotes(connectionId: string): Promise<SchemaNotes> {
  // Partial backend mocks in tests may not implement this forwarder.
  const load = api.loadDocsAnnotations;
  if (typeof load !== "function") return {};
  try {
    const annotations = await load(connectionId);
    return annotations ? { annotations } : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: message.slice(0, 300) };
  }
}

export interface SchemaNoteTable {
  name: string;
  comment?: string | null;
  columns: Array<{ name: string; comment?: string | null }>;
}

/**
 * Overlay a table's local notes onto the AI context. Precedence matches the
 * documentation viewer: local note ?? database comment. `schema` must be the
 * namespace the table lives in, even when `AiSchemaTable.schema` is hidden for
 * display on non-schema-aware engines.
 */
export function applySchemaNotes<T extends SchemaNoteTable>(table: T, annotations: AnnotationFile | undefined, dbType: DatabaseType, schema: string | undefined, budget: SchemaNoteBudget): T {
  if (!annotations) return table;

  const tableNote = budget.take(localTableNote(annotations, dbType, schema, table.name), SCHEMA_NOTE_TABLE_MAX_CHARS);
  const renderedTableNote = tableNote ? renderUntrustedNote(tableNote) : undefined;
  const columns = table.columns.map((column) => {
    const note = localColumnNote(annotations, dbType, schema, table.name, column.name);
    const comment = budget.take(note, SCHEMA_NOTE_COLUMN_MAX_CHARS);
    return comment ? { ...column, comment: renderUntrustedNote(comment) } : column;
  });

  return { ...table, comment: renderedTableNote ?? table.comment, columns };
}
