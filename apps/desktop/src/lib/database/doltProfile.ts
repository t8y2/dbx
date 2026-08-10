export const DOLT_DRIVER_PROFILE = "dolt";

export type DoltSqlRoutineDefinition = {
  name: string;
  type: "procedure" | "function";
  signature: string;
};

export const DOLT_SQL_ROUTINES: readonly DoltSqlRoutineDefinition[] = [
  { name: "ACTIVE_BRANCH", type: "function", signature: "" },
  { name: "DOLT_ADD", type: "procedure", signature: "arguments" },
  { name: "DOLT_BRANCH", type: "procedure", signature: "arguments" },
  { name: "DOLT_CHECKOUT", type: "procedure", signature: "arguments" },
  { name: "DOLT_CHERRY_PICK", type: "procedure", signature: "arguments" },
  { name: "DOLT_COMMIT", type: "procedure", signature: "arguments" },
  { name: "DOLT_FETCH", type: "procedure", signature: "arguments" },
  { name: "DOLT_MERGE", type: "procedure", signature: "arguments" },
  { name: "DOLT_PULL", type: "procedure", signature: "arguments" },
  { name: "DOLT_PUSH", type: "procedure", signature: "arguments" },
  { name: "DOLT_REBASE", type: "procedure", signature: "arguments" },
  { name: "DOLT_REMOTE", type: "procedure", signature: "arguments" },
  { name: "DOLT_RESET", type: "procedure", signature: "arguments" },
  { name: "DOLT_REVERT", type: "procedure", signature: "arguments" },
  { name: "DOLT_TAG", type: "procedure", signature: "arguments" },
  { name: "DOLT_DIFF", type: "function", signature: "arguments" },
  { name: "DOLT_DIFF_STAT", type: "function", signature: "arguments" },
  { name: "DOLT_DIFF_SUMMARY", type: "function", signature: "arguments" },
  { name: "DOLT_HASHOF", type: "function", signature: "revision" },
  { name: "DOLT_HASHOF_DB", type: "function", signature: "revision" },
  { name: "DOLT_HASHOF_TABLE", type: "function", signature: "table" },
  { name: "DOLT_LOG", type: "function", signature: "arguments" },
  { name: "DOLT_MERGE_BASE", type: "function", signature: "revision_a, revision_b" },
  { name: "DOLT_PATCH", type: "function", signature: "arguments" },
  { name: "DOLT_QUERY_DIFF", type: "function", signature: "query_a, query_b" },
  { name: "DOLT_REFLOG", type: "function", signature: "arguments" },
  { name: "DOLT_SCHEMA_DIFF", type: "function", signature: "arguments" },
  { name: "DOLT_VERSION", type: "function", signature: "" },
];

export function isDoltDriverProfile(driverProfile?: string): boolean {
  return driverProfile?.toLowerCase() === DOLT_DRIVER_PROFILE;
}

export function doltSqlBuiltinTerms(driverProfile?: string): string {
  if (!isDoltDriverProfile(driverProfile)) return "";
  return DOLT_SQL_ROUTINES.map((routine) => routine.name.toLowerCase()).join(" ");
}

export function doltSqlRoutineSignatures(driverProfile?: string): Map<string, string[]> {
  if (!isDoltDriverProfile(driverProfile)) return new Map();
  return new Map(
    DOLT_SQL_ROUTINES.map((routine) => [
      routine.name,
      routine.signature
        .split(",")
        .map((parameter) => parameter.trim())
        .filter(Boolean),
    ]),
  );
}
