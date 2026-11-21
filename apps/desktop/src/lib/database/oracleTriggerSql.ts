import type { DatabaseType, OracleTriggerMetadata } from "@/types/database";

export type OracleTriggerDatabaseType = Extract<DatabaseType, "oracle" | "oceanbase-oracle" | "dameng">;

export type OracleTriggerSqlBinding = {
  scope: "TABLE" | "VIEW" | "SCHEMA" | "DATABASE" | "TIMER";
  owner?: string | null;
  name?: string | null;
  pluggable?: boolean;
};

export type OracleTriggerSqlHeader = {
  scope: "RELATION" | "SCHEMA" | "DATABASE" | "TIMER";
  owner?: string | null;
  name?: string | null;
  viewOnly: boolean;
  pluggable: boolean;
};

export type OracleTriggerSqlInput = {
  databaseType: OracleTriggerDatabaseType;
  owner: string;
  name: string;
  source: string;
  purpose: "inspect" | "create" | "replace";
  binding?: OracleTriggerSqlBinding;
  enabled?: boolean;
  allowExportAppendix?: boolean;
};

export type PreparedOracleTriggerSql = {
  definition: string;
  /** Comparison only: declaration wrapper canonicalized, header/body text preserved. */
  comparisonSource: string;
  header: OracleTriggerSqlHeader;
  inlineEnabled?: boolean | null;
  exportEnabled?: boolean | null;
  requiresStateRestore: boolean;
  structuredEditable?: boolean;
};

export function oracleTriggerDefinitionScopes(profile: Pick<OracleTriggerMetadata, "engine" | "engineVersion">): readonly OracleTriggerSqlBinding["scope"][] {
  if (profile.engine === "oracle") return ["TABLE", "VIEW", "SCHEMA", "DATABASE"];
  if (profile.engine === "oceanbase-oracle" && /(?:^|[^0-9])4\.2\.5\.7(?:[^0-9]|$)/.test(profile.engineVersion ?? "")) return ["TABLE", "VIEW"];
  if (profile.engine === "dm" && /(?:^|\D)8\./.test(profile.engineVersion ?? "")) return ["TABLE", "VIEW", "SCHEMA", "DATABASE", "TIMER"];
  return [];
}

/** A starting definition only. The SQL provider and write plan still verify it. */
export function buildOracleTriggerCreateDraft(profile: OracleTriggerMetadata, owner: string, name: string, binding: OracleTriggerSqlBinding): string {
  if (!owner.length || !name.length) throw new Error("Enter the exact trigger owner and name");
  if (!oracleTriggerDefinitionScopes(profile).includes(binding.scope)) throw new Error("Trigger creation for this scope has not been verified for the connected engine/version");
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  let header: string;
  if (binding.scope === "TABLE" || binding.scope === "VIEW") {
    if (!binding.owner?.length || !binding.name?.length) throw new Error("Select the exact owning table or view");
    header = `${binding.scope === "VIEW" ? "INSTEAD OF" : "BEFORE"} INSERT ON ${quote(binding.owner)}.${quote(binding.name)}\nFOR EACH ROW`;
  } else if (binding.scope === "SCHEMA") {
    if (!binding.owner?.length) throw new Error("Select the actual scope owner");
    header = `AFTER CREATE ON ${quote(binding.owner)}.SCHEMA`;
  } else if (binding.scope === "TIMER") {
    // DM's native trigger syntax, not a Job/Scheduler object.
    header = "AFTER TIMER ON DATABASE\nFOR EACH 1 DAY FOR EACH 1 MINUTE";
  } else header = `AFTER CREATE ON ${binding.pluggable ? "PLUGGABLE " : ""}DATABASE`;
  return `CREATE TRIGGER ${quote(owner)}.${quote(name)}\n${header}\nBEGIN\n  NULL;\nEND;`;
}

/** Database/container context is verified separately by the execution plan. */
export function oracleTriggerSourceBinding(metadata: OracleTriggerMetadata): OracleTriggerSqlBinding | undefined {
  if ((metadata.scope === "TABLE" || metadata.scope === "VIEW") && metadata.parent?.objectType === metadata.scope) {
    return { scope: metadata.scope, owner: metadata.parent.owner, name: metadata.parent.name };
  }
  if (metadata.scope === "SCHEMA" && metadata.scopeOwner) return { scope: "SCHEMA", owner: metadata.scopeOwner };
}

export function oracleTriggerSourceScopeMatches(metadata: OracleTriggerMetadata, header: OracleTriggerSqlHeader): boolean {
  if (metadata.scope === "TABLE" || metadata.scope === "VIEW") return header.scope === "RELATION" && (!header.viewOnly || metadata.scope === "VIEW");
  if (metadata.scope === "SCHEMA" || metadata.scope === "DATABASE" || metadata.scope === "TIMER") return header.scope === metadata.scope;
  return true; // Unknown summary scope is still unavailable to a write plan.
}
