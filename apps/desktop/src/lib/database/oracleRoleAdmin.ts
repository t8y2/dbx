import type { OracleGrantSource } from "@/lib/database/oracleSecurity";

export interface OracleRoleChange {
  action: "createRole" | "alterRole" | "dropRole" | "grant" | "revoke";
  principal: string;
  kind?: "system" | "object" | "role";
  privilege?: string;
  role?: string;
  owner?: string;
  objectName?: string;
  column?: string;
  grantor?: string;
  authentication?: "none" | "password";
  option?: boolean;
}
export interface OracleRoleRequest {
  operation: "read" | "preview" | "apply";
  change: OracleRoleChange;
  revision?: string;
  password?: string;
}
export interface OracleRoleResponse {
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  sources?: unknown[];
  remainingSources?: unknown[];
  revision?: string;
  blocked?: string;
  steps?: { label: string; sql: string }[];
  requiresPassword?: boolean;
  impact?: string;
  outcome?: "verified" | "applied" | "failed" | "unverified";
  sentSteps?: string[];
  completedSteps?: string[];
  error?: string;
  readbackError?: string;
  recoveryHint?: string;
  authenticationVerified?: boolean;
}

export function rolePreviewRequest(change: OracleRoleChange): OracleRoleRequest {
  const lifecycle = ["createRole", "alterRole", "dropRole"].includes(change.action);
  return {
    operation: "preview",
    change: {
      action: change.action,
      principal: change.principal,
      ...(lifecycle
        ? { authentication: change.authentication }
        : {
            kind: change.kind,
            option: change.action === "grant" && !!change.option,
            ...(change.kind === "role" ? { role: change.role } : { privilege: change.privilege }),
            ...(change.kind === "object" ? { owner: change.owner, objectName: change.objectName, column: change.column || undefined, grantor: change.action === "revoke" ? change.grantor : undefined } : {}),
          }),
    },
  };
}
export function directGrantChange(source: OracleGrantSource, principal: string): OracleRoleChange {
  if (!(source.source === "direct" || (source.source === "public" && principal === "PUBLIC")) || (principal && source.grant.grantee !== principal)) throw new Error("Select the direct grantee; inherited rights cannot be revoked from the current principal.");
  if (source.kind === "column") throw new Error("Column-only revocation requires a separate plan.");
  const grant = source.grant;
  return { action: "revoke", principal: grant.grantee, kind: source.kind, privilege: grant.privilege, ...("owner" in grant ? { owner: grant.owner, objectName: grant.objectName, grantor: grant.grantor } : {}) };
}
