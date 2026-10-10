export interface OracleUserChange {
  action: "create" | "alter" | "password" | "lock" | "unlock" | "drop";
  name: string;
  profile?: string;
  defaultTablespace?: string;
  temporaryTablespace?: string;
}
export interface OracleUserRequest {
  operation: "read" | "preview" | "apply";
  change: OracleUserChange;
  revision?: string;
  password?: string;
}
export interface OracleUserSnapshot {
  user: Record<string, unknown> | null;
  locked: boolean | null;
  objects: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
  dropChecks: boolean;
}
export interface OracleUserResponse {
  snapshot?: OracleUserSnapshot;
  before?: OracleUserSnapshot;
  after?: OracleUserSnapshot;
  blocked?: string;
  revision?: string;
  requiresPassword?: boolean;
  steps?: { label: string; sql: string }[];
  outcome?: "verified" | "applied" | "partial" | "failed" | "unverified";
  sentSteps?: string[];
  completedSteps?: string[];
  error?: string;
  readbackError?: string;
  authenticationVerified?: boolean;
  recoveryHint?: string;
}

export function userPreviewRequest(change: OracleUserChange): OracleUserRequest {
  // Explicit field allowlist prevents a form object's password from reaching a preview.
  return {
    operation: "preview",
    change: { action: change.action, name: change.name, ...(change.profile ? { profile: change.profile } : {}), ...(change.defaultTablespace ? { defaultTablespace: change.defaultTablespace } : {}), ...(change.temporaryTablespace ? { temporaryTablespace: change.temporaryTablespace } : {}) },
  };
}
export function validOraclePassword(value: string): boolean {
  return value.length > 0 && !/["\r\n\0]/.test(value);
}
