/**
 * Utility functions for consistent error handling across the application.
 */

export type BackendErrorParam = string | number | boolean;

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
}

const MAX_FALLBACK_CHARS = 64 * 1024;
const MAX_ERROR_PARSE_DEPTH = 16;
const AGENT_RPC_ERROR_DATA_MARKER = "\nDBX_AGENT_ERROR_DATA:";

export function sanitizeBackendErrorMessage(message: string): string {
  const markerIndex = message.lastIndexOf(AGENT_RPC_ERROR_DATA_MARKER);
  if (markerIndex < 0) return message;

  const rawData = message.slice(markerIndex + AGENT_RPC_ERROR_DATA_MARKER.length).trim();
  try {
    const data: unknown = JSON.parse(rawData);
    if (!data || typeof data !== "object" || Array.isArray(data)) return message;
  } catch {
    return message;
  }

  return message.slice(0, markerIndex).trimEnd();
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
  return Object.values(candidate.messageParams).every((param) => typeof param === "string" || typeof param === "boolean" || (typeof param === "number" && Number.isFinite(param)));
}

export function normalizeBackendError(error: unknown): BackendError | null {
  return normalizeBackendErrorAtDepth(error, new WeakSet<object>(), 0);
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

export class BackendErrorException extends Error {
  readonly backendError: BackendError;

  constructor(error: unknown) {
    const backendError = normalizeRawBackendError(error);
    const fallbackDetail = boundedFallbackText(error);
    const fallbackMessage = sanitizeBackendErrorMessage(fallbackDetail ?? "Backend request failed");
    super(backendError?.detail ? sanitizeBackendErrorMessage(backendError.detail) : fallbackMessage);
    this.name = "BackendErrorException";
    this.backendError = backendError ?? {
      version: 1,
      code: "DBX-LEGACY-0001",
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

  // Fallback: attempt to stringify
  try {
    return sanitizeBackendErrorMessage(String(e));
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
