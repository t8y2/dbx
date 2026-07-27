export type EtcdDashboardErrorKind = "unsupported" | "request";

export interface EtcdDashboardError {
  kind: EtcdDashboardErrorKind;
  message: string;
}

const unsupportedStatusPatterns = ["etcd_status_unsupported", "unknown method: kv_status", "method not found: kv_status", "method not found: `kv_status`"];

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

export function sanitizeEtcdDashboardError(error: unknown): string {
  const raw = errorText(error).trim();
  const withoutStderr = raw.split(/\s*(?:\.\s*)?recent stderr\s*:/i, 1)[0]?.trim() || raw;
  return withoutStderr.replace(/^ETCD_STATUS_UNSUPPORTED:\s*/i, "").slice(0, 600);
}

export function classifyEtcdDashboardError(error: unknown): EtcdDashboardError {
  const raw = errorText(error);
  const normalized = raw.toLowerCase();
  return {
    kind: unsupportedStatusPatterns.some((pattern) => normalized.includes(pattern)) ? "unsupported" : "request",
    message: sanitizeEtcdDashboardError(error),
  };
}
