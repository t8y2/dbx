export type KvMutationErrorKind = "keyAlreadyExists" | "conflict" | "request";

export interface KvMutationError {
  kind: KvMutationErrorKind;
  message: string;
}

export interface KvMutationErrorMessages {
  keyAlreadyExists?: string;
  conflict?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "");
}

export function sanitizeKvMutationError(error: unknown): string {
  const raw = errorText(error).trim();
  const withoutStderr = raw.split(/\s*(?:\.\s*)?recent stderr\s*:/i, 1)[0]?.trim() || raw;
  return withoutStderr.replace(/^Agent RPC error(?:\s*\([^)]*\))?\s*:\s*/i, "").slice(0, 600);
}

export function classifyKvMutationError(error: unknown, creating: boolean, messages: KvMutationErrorMessages = {}): KvMutationError {
  const sanitized = sanitizeKvMutationError(error);
  const normalized = sanitized.toLowerCase();

  if (normalized.includes("etcd_key_already_exists") || (creating && normalized.includes("etcd_cas_conflict"))) {
    return {
      kind: "keyAlreadyExists",
      message: messages.keyAlreadyExists || "A Key with this name already exists. Choose another name or edit the existing Key.",
    };
  }
  if (normalized.includes("etcd_cas_conflict")) {
    return {
      kind: "conflict",
      message: messages.conflict || "The Key changed after it was loaded. Refresh it and try again.",
    };
  }
  return { kind: "request", message: sanitized };
}
