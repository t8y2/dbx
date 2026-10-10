export interface OracleJobIdentity {
  owner: string;
  name: string;
}
export interface OracleJobDefinition {
  jobType: string;
  jobAction: string;
  arguments: string[];
  startDate: string;
  repeatInterval: string;
  endDate: string;
}
export interface OracleJobChange {
  action: "create" | "update" | "enable" | "disable" | "drop";
  identity: OracleJobIdentity;
  definition?: OracleJobDefinition;
}
export interface OracleJobsRequest {
  operation: "list" | "read" | "readLegacy" | "preview" | "apply";
  identity?: OracleJobIdentity;
  change?: OracleJobChange;
  revision?: string;
}
export type OracleJobRow = Record<string, string | number | boolean | null>;
export interface OracleJobSection {
  availability: "available" | "denied" | "unsupported" | "unknown";
  scope?: string;
  rows: OracleJobRow[];
  warning?: string;
  error?: string;
}
export interface OracleJobsResponse {
  scheduleImpact?: {
    state: "evaluated" | "noFutureRun" | "unknown" | "unsupported";
    previousNextRun: unknown;
    requestedStartDate: string;
    requestedEndDate: string;
    requestedRepeatInterval: string;
    requestedNextRun: string | null;
    evaluationAfter: string | null;
    reason: string;
  } | null;
  capability?: { engine: string; version: string; canManage: boolean; jobTypes: string[] };
  scheduler?: OracleJobSection;
  legacy?: OracleJobSection | OracleJobRow | null;
  job?: OracleJobRow | null;
  arguments?: OracleJobRow[];
  argumentsAvailability?: string;
  argumentsError?: string;
  history?: OracleJobSection;
  revision?: string;
  steps?: { label: string; sql: string }[];
  before?: OracleJobsResponse;
  outcome?: "verified" | "partial" | "failed" | "unverified" | "disappeared";
  executedSteps?: string[];
  attemptedSteps?: string[];
  error?: string | null;
  readback?: OracleJobsResponse | null;
  readbackError?: string | null;
  recoveryHint?: string;
}

export function jobIdentity(row: OracleJobRow): OracleJobIdentity {
  return { owner: String(row.OWNER ?? ""), name: String(row.JOB_NAME ?? "") };
}

export function jobEnabled(value: unknown): boolean | null {
  if (value === true || value === 1 || String(value).toUpperCase() === "TRUE" || value === "1") return true;
  if (value === false || value === 0 || String(value).toUpperCase() === "FALSE" || value === "0") return false;
  return null;
}

export function definitionFromJob(details: OracleJobsResponse): OracleJobDefinition {
  const row = details.job;
  if (!row || details.argumentsAvailability !== "available") throw new Error("Job definition or arguments are unavailable");
  if (row.NUMBER_OF_ARGUMENTS == null) throw new Error("Job argument count is unknown");
  const count = Number(row.NUMBER_OF_ARGUMENTS);
  const args = details.arguments ?? [];
  if (!Number.isInteger(count) || count < 0 || count > 255 || args.length !== count) throw new Error("Job arguments are incomplete");
  const ordered = Array.from({ length: count }, (_, index) => {
    const argument = args.find((arg) => Number(arg.ARGUMENT_POSITION) === index + 1);
    if (!argument || argument.VALUE == null) throw new Error("Job argument value is unavailable");
    return String(argument.VALUE);
  });
  return { jobType: String(row.JOB_TYPE ?? ""), jobAction: String(row.JOB_ACTION ?? ""), arguments: ordered, startDate: String(row.START_DATE ?? ""), repeatInterval: String(row.REPEAT_INTERVAL ?? ""), endDate: String(row.END_DATE ?? "") };
}

export function freezeJobChange(change: OracleJobChange): OracleJobChange {
  return JSON.parse(JSON.stringify(change)) as OracleJobChange;
}
