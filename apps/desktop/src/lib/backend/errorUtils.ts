/**
 * Utility functions for consistent error handling across the application.
 */

export type BackendErrorParam = string | number | boolean;

export interface BackendError {
  version: 1;
  code: string;
  messageKey: string;
  messageParams: Record<string, BackendErrorParam>;
  source: "jdbcAgent" | "jdbcAgentLegacy" | "legacyBackend";
  operationOutcome: "not_started" | "unknown";
  detail?: string;
  diagnostics?: Record<string, unknown>;
  helpUrl?: string;
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
    !["jdbcAgent", "jdbcAgentLegacy", "legacyBackend"].includes(String(candidate.source)) ||
    !["not_started", "unknown"].includes(String(candidate.operationOutcome))
  ) {
    return false;
  }
  if (candidate.detail !== undefined && typeof candidate.detail !== "string") return false;
  return Object.values(candidate.messageParams).every((param) => typeof param === "string" || typeof param === "boolean" || (typeof param === "number" && Number.isFinite(param)));
}

export function normalizeBackendError(error: unknown): BackendError | null {
  if (error instanceof BackendErrorException) return error.backendError;
  if (isBackendError(error)) return error;
  if (error && typeof error === "object" && "backendError" in error) {
    const backendError = (error as { backendError: unknown }).backendError;
    if (isBackendError(backendError)) return backendError;
  }
  if (error && typeof error === "object" && "error" in error) {
    const nested = (error as { error: unknown }).error;
    if (isBackendError(nested)) return nested;
  }
  return null;
}

export class BackendErrorException extends Error {
  readonly backendError: BackendError;

  constructor(error: unknown) {
    const backendError = normalizeRawBackendError(error);
    const fallbackMessage = typeof error === "string" ? error : error instanceof Error ? error.message : "Backend request failed";
    super(backendError?.detail || fallbackMessage);
    this.name = "BackendErrorException";
    this.backendError = backendError ?? {
      version: 1,
      code: "DBX-LEGACY-0001",
      messageKey: "backendErrors.legacy",
      messageParams: {},
      source: "legacyBackend",
      operationOutcome: "unknown",
      detail: fallbackMessage,
    };
  }
}

function normalizeRawBackendError(error: unknown): BackendError | null {
  if (typeof error === "string") {
    try {
      const parsed: unknown = JSON.parse(error);
      return normalizeBackendError(parsed);
    } catch {
      return null;
    }
  }
  return normalizeBackendError(error);
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
  if (backendError?.detail) return backendError.detail;

  if (e instanceof Error) {
    return e.message;
  }

  if (typeof e === "string") {
    return e;
  }

  if (e === null || e === undefined) {
    return "Unknown error occurred";
  }

  // Try to extract message property from object-like values
  if (typeof e === "object" && "message" in e) {
    const message = (e as { message: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  // Fallback: attempt to stringify
  try {
    return String(e);
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
