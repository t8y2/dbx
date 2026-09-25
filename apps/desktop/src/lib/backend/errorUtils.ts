/**
 * Utility functions for consistent error handling across the application.
 */

export type BackendErrorParam = string | number | boolean;

/**
 * Driver-reported SQL error position, relative to the statement text that was
 * actually sent to the database. `line`/`column` are 1-based and counted in
 * Unicode scalar values; `offset` is the 0-based scalar-value index.
 *
 * Currently only populated by the native PostgreSQL driver.
 */
export interface SqlErrorPosition {
  line: number;
  column: number;
  offset: number;
}

export interface BackendError {
  version: 1;
  code: string;
  messageKey: string;
  messageParams: Record<string, BackendErrorParam>;
  /** Compatibility provenance. New callers should prefer origin metadata. */
  source: string;
  operationOutcome: "not_started" | "unknown";
  origin?: {
    subsystem: string;
    adapter: string;
    driver?: string;
  };
  detail?: string;
  diagnostics?: Record<string, unknown>;
  helpUrl?: string;
  errorPosition?: SqlErrorPosition;
}

export const MANUAL_TRANSACTION_SESSION_EXPIRED_CODE = "DBX-TXN-1001";

const MAX_FALLBACK_CHARS = 64 * 1024;
const MAX_ERROR_PARSE_DEPTH = 16;
// The Agent transport appends its structured payload behind this marker. It is
// not always the last thing in the message: callers append human-readable
// fallback context after it, so the payload has to be stripped wherever it sits.
const AGENT_RPC_ERROR_DATA_MARKER = "\nDBX_AGENT_ERROR_DATA:";
// Rust-side transport suffix carrying a driver cursor position. It is stripped
// before a structured envelope is built, but metadata/catalog errors can surface
// as raw strings, so strip it here so it never reaches the UI.
const SQL_ERROR_POSITION_MARKER_PATTERN = /\nDBX_SQL_ERROR_POSITION:\d+/g;

function isInternalAgentErrorData(source: string): boolean {
  try {
    const data: unknown = JSON.parse(source);
    return Boolean(data) && typeof data === "object" && !Array.isArray(data);
  } catch {
    return false;
  }
}

/**
 * Exclusive end offset of the JSON object literal starting at `start`, or
 * `null` when no complete object follows.
 */
function jsonObjectEnd(source: string, start: number): number | null {
  if (source[start] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

/**
 * Removes every internal Agent payload, wherever the marker appears. Trailing
 * text that follows a payload is kept: callers use it to append fallback
 * context such as the alternate Oracle descriptor failure.
 */
function stripAgentErrorMessageData(message: string): string {
  let stripped = "";
  let cursor = 0;
  let droppedToEnd = false;

  while (cursor < message.length) {
    const markerIndex = message.indexOf(AGENT_RPC_ERROR_DATA_MARKER, cursor);
    if (markerIndex < 0) break;

    const dataStart = markerIndex + AGENT_RPC_ERROR_DATA_MARKER.length;
    const leadingWhitespace = message.slice(dataStart).search(/\S/);
    const objectStart = leadingWhitespace < 0 ? -1 : dataStart + leadingWhitespace;
    const objectEnd = objectStart < 0 ? null : jsonObjectEnd(message, objectStart);
    if (objectEnd === null || !isInternalAgentErrorData(message.slice(objectStart, objectEnd))) {
      // Not internal data (for example a database message that mentions the
      // marker): keep the text as-is and continue looking behind it.
      stripped += message.slice(cursor, dataStart);
      cursor = dataStart;
      continue;
    }

    stripped += message.slice(cursor, markerIndex);
    cursor = objectEnd;
    droppedToEnd = message.slice(objectEnd).trim().length === 0;
  }

  const result = stripped + message.slice(cursor);
  return droppedToEnd ? result.trimEnd() : result;
}

export function sanitizeBackendErrorMessage(message: string): string {
  return stripAgentErrorMessageData(message.replace(SQL_ERROR_POSITION_MARKER_PATTERN, ""));
}

function isBackendError(value: unknown): value is BackendError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.code !== "string" ||
    !/^DBX-[A-Z][A-Z0-9]*-\d{4}$/.test(candidate.code) ||
    typeof candidate.messageKey !== "string" ||
    !candidate.messageKey.startsWith("backendErrors.") ||
    !candidate.messageParams ||
    typeof candidate.messageParams !== "object" ||
    Array.isArray(candidate.messageParams) ||
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    candidate.source.length > 64 ||
    !["not_started", "unknown"].includes(String(candidate.operationOutcome))
  ) {
    return false;
  }
  if (candidate.origin !== undefined) {
    const origin = candidate.origin;
    const originRecord = origin as Record<string, unknown>;
    if (
      !origin ||
      typeof origin !== "object" ||
      Array.isArray(origin) ||
      typeof originRecord.subsystem !== "string" ||
      typeof originRecord.adapter !== "string" ||
      originRecord.subsystem.length > 64 ||
      originRecord.adapter.length > 64 ||
      (originRecord.driver !== undefined && (typeof originRecord.driver !== "string" || originRecord.driver.length > 64))
    ) {
      return false;
    }
  }
  if (candidate.detail !== undefined && typeof candidate.detail !== "string") return false;
  // Optional driver-reported position. Malformed values are rejected so a
  // corrupted envelope never drives a wrong editor jump, while a missing field
  // stays valid (all non-PostgreSQL errors and older backends).
  if (candidate.errorPosition !== undefined) {
    if (!isValidErrorPosition(candidate.errorPosition)) return false;
  }
  return Object.values(candidate.messageParams).every((param) => typeof param === "string" || typeof param === "boolean" || (typeof param === "number" && Number.isFinite(param)));
}

function isValidErrorPosition(value: unknown): value is SqlErrorPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { line, column, offset } = value as Record<string, unknown>;
  return isPositiveInt(line) && isPositiveInt(column) && isNonNegativeInt(offset);
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isNonNegativeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function normalizeBackendError(error: unknown): BackendError | null {
  return normalizeBackendErrorAtDepth(error, new WeakSet<object>(), 0);
}

export function isManualTransactionSessionExpired(error: unknown): boolean {
  if (normalizeBackendError(error)?.code === MANUAL_TRANSACTION_SESSION_EXPIRED_CODE) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return message?.startsWith("Transaction session not found or expired;") === true || message === "Transaction was auto-rolled back due to 5 minutes of inactivity";
}

export function isUnsupportedManualTransactionMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!message) return false;
  const normalized = message.toLowerCase();
  return normalized.includes("begin_manual_transaction") && (normalized.includes("unknown method") || normalized.includes("method not found"));
}

function normalizeBackendErrorAtDepth(error: unknown, seen: WeakSet<object>, depth: number): BackendError | null {
  if (depth > MAX_ERROR_PARSE_DEPTH) return null;

  if (error && typeof error === "object") {
    if (seen.has(error)) return null;
    seen.add(error);

    if ("name" in error && error.name === "BackendErrorException" && "backendError" in error) {
      const normalized = normalizeBackendErrorAtDepth((error as { backendError: unknown }).backendError, seen, depth + 1);
      if (normalized) return normalized;
    }
  }
  if (typeof error === "string") {
    try {
      return normalizeBackendErrorAtDepth(JSON.parse(error), seen, depth + 1);
    } catch {
      return null;
    }
  }
  if (isBackendError(error)) return error;
  if (error && typeof error === "object" && "backendError" in error) {
    const backendError = (error as { backendError: unknown }).backendError;
    const normalized = normalizeBackendErrorAtDepth(backendError, seen, depth + 1);
    if (normalized) return normalized;
  }
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error: unknown }).error;
    const normalized = normalizeBackendErrorAtDepth(nested, seen, depth + 1);
    if (normalized) return normalized;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    try {
      const parsed: unknown = JSON.parse(error.message);
      const normalized = normalizeBackendErrorAtDepth(parsed, seen, depth + 1);
      if (normalized) return normalized;
    } catch {
      // Keep checking compatibility wrappers before falling back to plain text.
    }
  }
  return null;
}

export const GENERIC_TRANSPORT_FAILURE_MESSAGE = "Backend request failed";

/**
 * Marks a backend message the UI could not classify, so it is carried as raw text inside a
 * structured envelope. Callers may still match that text against the known-message catalog.
 */
export const LEGACY_BACKEND_ERROR_CODE = "DBX-LEGACY-0001";

export class BackendErrorException extends Error {
  readonly backendError: BackendError;

  constructor(error: unknown) {
    const backendError = normalizeRawBackendError(error);
    const fallbackDetail = boundedFallbackText(error);
    const fallbackMessage = sanitizeBackendErrorMessage(fallbackDetail ?? GENERIC_TRANSPORT_FAILURE_MESSAGE);
    super(backendError?.detail ? sanitizeBackendErrorMessage(backendError.detail) : fallbackMessage);
    this.name = "BackendErrorException";
    this.backendError = backendError ?? {
      version: 1,
      code: LEGACY_BACKEND_ERROR_CODE,
      messageKey: "backendErrors.legacy",
      messageParams: {},
      source: "legacyBackend",
      operationOutcome: "unknown",
      origin: { subsystem: "backend", adapter: "legacy" },
      ...(fallbackDetail ? { detail: sanitizeBackendErrorMessage(fallbackDetail) } : {}),
    };
  }
}

function normalizeRawBackendError(error: unknown): BackendError | null {
  return normalizeBackendError(error);
}

function boundedFallbackText(error: unknown): string | undefined {
  return boundedFallbackTextAtDepth(error, new WeakSet<object>(), 0);
}

function boundedFallbackTextAtDepth(error: unknown, seen: WeakSet<object>, depth: number): string | undefined {
  if (depth > MAX_ERROR_PARSE_DEPTH) return undefined;

  let text: string | undefined;
  if (typeof error === "string") {
    text = error;
  } else if (error instanceof Error) {
    text = error.message;
  } else if (error && typeof error === "object") {
    if (seen.has(error)) return undefined;
    seen.add(error);
    const candidate = error as Record<string, unknown>;
    for (const key of ["message", "reason", "detail"]) {
      if (typeof candidate[key] === "string") {
        text = candidate[key];
        break;
      }
    }
    if (!text && "error" in candidate) text = boundedFallbackTextAtDepth(candidate.error, seen, depth + 1);
    if (!text && "backendError" in candidate) text = boundedFallbackTextAtDepth(candidate.backendError, seen, depth + 1);
  }
  const normalized = text?.trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, MAX_FALLBACK_CHARS).join("");
}

/**
 * Formats an unknown error value into a human-readable string.
 * Handles Error objects, strings, null/undefined, and other types.
 *
 * @param e - The error value to format (from a catch block)
 * @returns A human-readable error message string
 *
 * @example
 * try {
 *   await someOperation();
 * } catch (e: unknown) {
 *   errorMessage.value = formatError(e);
 * }
 */
export function formatError(e: unknown): string {
  const backendError = normalizeBackendError(e);
  if (backendError?.detail) return sanitizeBackendErrorMessage(backendError.detail);
  if (backendError) return backendError.code;

  if (e instanceof Error) {
    return sanitizeBackendErrorMessage(e.message);
  }

  if (typeof e === "string") {
    return sanitizeBackendErrorMessage(e);
  }

  if (e === null || e === undefined) {
    return "Unknown error occurred";
  }

  // Try to extract message property from object-like values
  if (typeof e === "object" && "message" in e) {
    const message = (e as { message: unknown }).message;
    if (typeof message === "string") {
      return sanitizeBackendErrorMessage(message);
    }
  }

  // Fallback: prefer bounded nested text (message/reason/detail, .error/.backendError)
  // over raw string coercion so object-shaped failures never degrade to "[object Object]".
  const fallback = boundedFallbackText(e);
  try {
    return sanitizeBackendErrorMessage(fallback ?? String(e));
  } catch {
    return "Unknown error occurred";
  }
}

/**
 * Formats an error with a context prefix for better debugging.
 *
 * @param e - The error value to format
 * @param context - The operation context (e.g., "loading topics", "creating tenant")
 * @returns A formatted error message with context
 *
 * @example
 * catch (e: unknown) {
 *   errorMessage.value = formatErrorWithContext(e, 'loading topics');
 * }
 */
export function formatErrorWithContext(e: unknown, context: string): string {
  const message = formatError(e);
  return `Failed to ${context}: ${message}`;
}
