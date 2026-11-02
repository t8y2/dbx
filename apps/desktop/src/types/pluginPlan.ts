/**
 * Plugin Host API contract for read-only estimated execution plans (#9675).
 *
 * Kept in `@/types` because three layers share it: the bridge that enforces the
 * plugin permission, the backend transport that reaches DBX Core, and the
 * plugin SDK surface. The Rust side lives in
 * `crates/dbx-core/src/query/plugin_plan.rs`; field names are the serialized
 * `camelCase` names of those structs.
 *
 * The plugin submits its own SQL and a connection reference. The host owns the
 * EXPLAIN statement, the connection, the credentials, the driver and the
 * timeout, and returns only the raw plan. There is deliberately no way to pass
 * an EXPLAIN statement, a driver command or an execution mode.
 */

/** Permission a plugin must declare to reach `host.getPlanCapabilities` / `host.explainPlan`. */
export const PLUGIN_PLAN_PERMISSION = "host.plans:read";

/** Host-wide ceiling for `timeoutMs`, mirrored from `MAX_PLUGIN_PLAN_TIMEOUT_MS`. */
export const MAX_PLUGIN_PLAN_TIMEOUT_MS = 60_000;

/** Host-wide ceiling for `rawPlan`, mirrored from `MAX_PLUGIN_PLAN_BYTES`. */
export const MAX_PLUGIN_PLAN_BYTES = 4 * 1024 * 1024;

/** Ceiling for the submitted `sql`, mirrored from `MAX_PLUGIN_PLAN_SQL_CHARS`. */
export const MAX_PLUGIN_PLAN_SQL_CHARS = 200_000;

/**
 * Warning codes the host may report. `plan_not_json` means the answer was
 * reported as `format: "text"` instead of pretending it was parseable JSON;
 * the other two mean the host cut the plan to respect its own limits.
 */
export const PLUGIN_PLAN_WARNING = {
  notJson: "plan_not_json",
  truncated: "plan_truncated",
  rowsTruncated: "plan_rows_truncated",
} as const;

/** How to decode `rawPlan`. */
export type PluginPlanFormat = "json" | "xml" | "text";

/** Only estimated plans are served; actual plans execute the statement. */
export type PluginPlanMode = "estimated";

export interface PluginPlanCapabilities {
  /** Dialect the plan will be generated for, in DBX's `db_type` vocabulary. */
  dbType: string;
  /** Server product version when DBX already learned it for this connection. */
  dbVersion?: string;
  supports: {
    /** False when this connection's dialect has no estimated plan path in DBX. */
    estimatedPlan: boolean;
  };
  limits: {
    /** Tightest timeout the host accepts, after the connection's own limit. */
    maxTimeoutMs: number;
    maxPlanBytes: number;
  };
}

export interface PluginPlanRequest {
  connectionId: string;
  database?: string;
  schema?: string;
  sql: string;
  mode: PluginPlanMode;
  timeoutMs?: number;
}

export interface PluginPlanResult {
  dbType: string;
  dbVersion?: string;
  format: PluginPlanFormat;
  /** A JSON document for `format: "json"`; the plan text otherwise (ShowPlanXML stays a string). */
  rawPlan: unknown;
  /** True when the host cut the plan to respect `limits`. */
  truncated: boolean;
  warnings: string[];
}
