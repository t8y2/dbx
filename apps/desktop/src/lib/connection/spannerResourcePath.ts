import type { ConnectionConfig } from "@/types/database";

/**
 * Cloud Spanner has no host/port identity: a database is addressed by the
 * resource path `projects/{project}/instances/{instance}/databases/{database}`.
 * DBX stores that whole path in `ConnectionConfig.database` and lets the
 * connection dialog edit it either as three IDs or as the raw path.
 *
 * Partial paths (`projects/p/instances//databases/`) are intentionally
 * representable so that typing one field at a time never discards the fields
 * already filled in; `hasSpannerResourcePath` is what gates Save/Test.
 */
export interface SpannerResourceParts {
  project: string;
  instance: string;
  database: string;
}

export const SPANNER_DEFAULT_PORT = 443;

const EMPTY_PARTS: SpannerResourceParts = { project: "", instance: "", database: "" };

// Keywords are matched case-insensitively; segments are captured verbatim.
// The trailing segment is optional so a path whose database ID is still empty
// (`projects/p/instances/i/databases/`, trailing slash trimmed) still parses.
const SPANNER_RESOURCE_PATH_RE = /^projects\/([^/]*)\/instances\/([^/]*)\/databases(?:\/([^/]*))?$/i;

type MutableSpannerConfig = Pick<ConnectionConfig, "host" | "port" | "username" | "password" | "database">;

export function isSpannerConnection(config: Pick<ConnectionConfig, "db_type">): boolean {
  return config.db_type === "spanner";
}

function normalizeResourcePath(path: string | undefined): string {
  return (path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Lenient read: returns whatever segments the value carries, with empty strings
 * for the missing ones. Anything that is not shaped like a Spanner resource path
 * yields all-empty parts, which is what keeps the raw-path editor authoritative.
 */
export function spannerResourceParts(path: string | undefined): SpannerResourceParts {
  const match = SPANNER_RESOURCE_PATH_RE.exec(normalizeResourcePath(path));
  if (!match) return { ...EMPTY_PARTS };
  return { project: match[1] ?? "", instance: match[2] ?? "", database: match[3] ?? "" };
}

/** Strict read: only a complete three-segment path parses. */
export function parseSpannerResourcePath(path: string | undefined): SpannerResourceParts | undefined {
  const parts = spannerResourceParts(path);
  return parts.project && parts.instance && parts.database ? parts : undefined;
}

/**
 * Each field holds a single ID. When a value contains slashes (typically a whole
 * resource path pasted into one box) only the last segment is kept, so
 * `projects/p1` becomes `p1` instead of `projects/projects/p1/...`.
 */
function normalizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return trimmed;
  const segments = trimmed
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1]! : "";
}

export function formatSpannerResourcePath(parts: SpannerResourceParts): string {
  const project = normalizeSegment(parts.project);
  const instance = normalizeSegment(parts.instance);
  const database = normalizeSegment(parts.database);
  if (!project && !instance && !database) return "";
  return `projects/${project}/instances/${instance}/databases/${database}`;
}

/**
 * Replaces one segment of the stored path. A full resource path pasted into any
 * of the three fields replaces all three segments at once.
 */
export function withSpannerResourcePart(database: string | undefined, key: keyof SpannerResourceParts, value: string): string {
  const pasted = parseSpannerResourcePath(value);
  if (pasted) return formatSpannerResourcePath(pasted);
  return formatSpannerResourcePath({ ...spannerResourceParts(database), [key]: value });
}

export function hasSpannerResourcePath(config: Pick<ConnectionConfig, "database">): boolean {
  return !!parseSpannerResourcePath(config.database);
}

/**
 * Submit-time normalization. Unlike Cloudflare D1 this must not clear
 * `url_params` (Spanner passes `credentials=`, `autoConfigEmulator=` through it)
 * and must not touch `host` (empty means Google Cloud, `localhost` means the
 * local emulator).
 */
export function normalizeSpannerConnection(config: MutableSpannerConfig): void {
  const parts = parseSpannerResourcePath(config.database);
  config.database = (parts ? formatSpannerResourcePath(parts) : normalizeResourcePath(config.database)) || undefined;
  config.host = config.host.trim();
  config.username = "";
  config.password = "";
  if (!Number.isInteger(config.port) || config.port <= 0) config.port = SPANNER_DEFAULT_PORT;
}

/** Sidebar/subtitle label: the database ID, not the whole resource path. */
export function spannerDisplayDatabase(database: string | undefined): string {
  return parseSpannerResourcePath(database)?.database ?? (database ?? "").trim();
}

/**
 * GoogleSQL's user schema is literally the empty string, so the sidebar would otherwise render a
 * nameless node next to any named schema. Mirrors `xuguSchemaDisplayName`: a display-only label
 * that never replaces the real schema key used for routing.
 */
export const SPANNER_DEFAULT_SCHEMA_LABEL = "(default)";

export function spannerSchemaDisplayName(schema: string): string {
  return schema === "" ? SPANNER_DEFAULT_SCHEMA_LABEL : schema;
}

/**
 * Percent-encode a Spanner resource path for display, keeping the `/` separators
 * intact — they are structure, not data. Mirrors `encode_spanner_resource_path`
 * in crates/dbx-core/src/models/connection.rs.
 *
 * Every other database type keeps whole-value encoding, where a slash inside a
 * database name really is data and should be escaped.
 */
export function encodeSpannerResourcePath(database: string): string {
  return database.split("/").map(encodeURIComponent).join("/");
}
