import type { ConnectionConfig } from "@/types/database";
import type { DriverProfileExtensionDefinition, DriverProfileObjectTreeProfile, DriverProfileSqlCompletionContext } from "@/lib/database/driverProfileExtensions";

export const DOLT_DRIVER_PROFILE = "dolt";
export const DOLT_SHOW_SYSTEM_TABLES_VARIABLE = "dolt_show_system_tables";
// Mirrors Dolt's IsSystemTable / HasDoltPrefix implementation. The reserved
// namespace comparison is case-insensitive and currently checks the "dolt" prefix.
export const DOLT_SYSTEM_TABLE_NAME_PATTERN = "dolt%";

const MYSQL_SESSION_VARIABLES_PARAM = "sessionVariables";

export type DoltSqlRoutineDefinition = {
  name: string;
  type: "procedure" | "scalar-function" | "table-function";
  signature: string;
};

// Keep this list aligned with Dolt's documented SQL procedures and functions:
// https://dolthub.com/docs/sql-reference/version-control/sql-extensions
export const DOLT_SQL_ROUTINES: readonly DoltSqlRoutineDefinition[] = [
  { name: "DOLT_ADD", type: "procedure", signature: "arguments" },
  { name: "DOLT_BACKUP", type: "procedure", signature: "arguments" },
  { name: "DOLT_BRANCH", type: "procedure", signature: "arguments" },
  { name: "DOLT_CHECKOUT", type: "procedure", signature: "arguments" },
  { name: "DOLT_CHERRY_PICK", type: "procedure", signature: "arguments" },
  { name: "DOLT_CLEAN", type: "procedure", signature: "arguments" },
  { name: "DOLT_CLONE", type: "procedure", signature: "arguments" },
  { name: "DOLT_COMMIT", type: "procedure", signature: "arguments" },
  { name: "DOLT_COMMIT_HASH_OUT", type: "procedure", signature: "out_hash, arguments" },
  { name: "DOLT_CONFLICTS_RESOLVE", type: "procedure", signature: "arguments" },
  { name: "DOLT_FETCH", type: "procedure", signature: "arguments" },
  { name: "DOLT_GC", type: "procedure", signature: "arguments" },
  { name: "DOLT_MERGE", type: "procedure", signature: "arguments" },
  { name: "DOLT_PULL", type: "procedure", signature: "arguments" },
  { name: "DOLT_PURGE_DROPPED_DATABASES", type: "procedure", signature: "arguments" },
  { name: "DOLT_PUSH", type: "procedure", signature: "arguments" },
  { name: "DOLT_REBASE", type: "procedure", signature: "arguments" },
  { name: "DOLT_REMOTE", type: "procedure", signature: "arguments" },
  { name: "DOLT_RESET", type: "procedure", signature: "arguments" },
  { name: "DOLT_REVERT", type: "procedure", signature: "arguments" },
  { name: "DOLT_RM", type: "procedure", signature: "arguments" },
  { name: "DOLT_SQUASH_HISTORY", type: "procedure", signature: "arguments" },
  { name: "DOLT_STASH", type: "procedure", signature: "arguments" },
  { name: "DOLT_TAG", type: "procedure", signature: "arguments" },
  { name: "DOLT_UNDROP", type: "procedure", signature: "arguments" },
  { name: "DOLT_UPDATE_COLUMN_TAG", type: "procedure", signature: "arguments" },
  { name: "DOLT_VERIFY_CONSTRAINTS", type: "procedure", signature: "arguments" },
  { name: "DOLT_STATS_RESTART", type: "procedure", signature: "" },
  { name: "DOLT_STATS_STOP", type: "procedure", signature: "" },
  { name: "DOLT_STATS_PURGE", type: "procedure", signature: "" },
  { name: "DOLT_STATS_ONCE", type: "procedure", signature: "" },
  { name: "DOLT_STATS_WAIT", type: "procedure", signature: "" },
  { name: "DOLT_STATS_FLUSH", type: "procedure", signature: "" },
  { name: "DOLT_STATS_GC", type: "procedure", signature: "" },
  { name: "DOLT_STATS_INFO", type: "procedure", signature: "arguments" },
  { name: "ACTIVE_BRANCH", type: "scalar-function", signature: "" },
  { name: "DOLT_MERGE_BASE", type: "scalar-function", signature: "revision_a, revision_b" },
  { name: "DOLT_HASHOF", type: "scalar-function", signature: "revision" },
  { name: "DOLT_HASHOF_DB", type: "scalar-function", signature: "revision" },
  { name: "DOLT_HASHOF_TABLE", type: "scalar-function", signature: "table" },
  { name: "DOLT_VERSION", type: "scalar-function", signature: "" },
  { name: "HAS_ANCESTOR", type: "scalar-function", signature: "target, ancestor" },
  { name: "LAST_INSERT_UUID", type: "scalar-function", signature: "" },
  { name: "DOLT_JOIN_COST", type: "scalar-function", signature: "query" },
  { name: "DOLT_DIFF", type: "table-function", signature: "from_revision, to_revision, table" },
  { name: "DOLT_DIFF_STAT", type: "table-function", signature: "from_revision, to_revision, table" },
  { name: "DOLT_DIFF_SUMMARY", type: "table-function", signature: "from_revision, to_revision, table" },
  { name: "DOLT_JSON_DIFF", type: "table-function", signature: "from_document, to_document" },
  { name: "DOLT_LOG", type: "table-function", signature: "arguments" },
  { name: "DOLT_PATCH", type: "table-function", signature: "from_revision, to_revision, table" },
  { name: "DOLT_PREVIEW_MERGE_CONFLICTS_SUMMARY", type: "table-function", signature: "base_branch, merge_branch" },
  { name: "DOLT_PREVIEW_MERGE_CONFLICTS", type: "table-function", signature: "base_branch, merge_branch, table" },
  { name: "DOLT_REFLOG", type: "table-function", signature: "arguments" },
  { name: "DOLT_SCHEMA_DIFF", type: "table-function", signature: "from_revision, to_revision, table" },
  { name: "DOLT_QUERY_DIFF", type: "table-function", signature: "query_a, query_b" },
  { name: "DOLT_BRANCH_STATUS", type: "table-function", signature: "base_refspec, target_refspecs" },
  { name: "DOLT_TEST_RUN", type: "table-function", signature: "arguments" },
];

function doltRoutineParameters(signature: string): string[] {
  return signature
    .split(",")
    .map((parameter) => parameter.trim())
    .filter(Boolean);
}

function doltRoutineApplyName(routine: DoltSqlRoutineDefinition, openingParenAfterCursor: boolean): string {
  if (openingParenAfterCursor) return routine.name;
  const parameters = doltRoutineParameters(routine.signature);
  return `${routine.name}(${parameters.map((parameter, index) => `\${${index + 1}:${parameter}}`).join(", ")})`;
}

function doltCompletionObjects(context: DriverProfileSqlCompletionContext) {
  const routineTypes = context.exclusiveRoutineSuggestions
    ? new Set<DoltSqlRoutineDefinition["type"]>(["procedure"])
    : context.statementKind === "select"
      ? new Set<DoltSqlRoutineDefinition["type"]>(["scalar-function"])
      : context.suggestTables
        ? new Set<DoltSqlRoutineDefinition["type"]>()
        : new Set<DoltSqlRoutineDefinition["type"]>(["procedure", "scalar-function", "table-function"]);

  return DOLT_SQL_ROUTINES.filter((routine) => routineTypes.has(routine.type)).map((routine) => ({
    name: routine.name,
    type: routine.type === "procedure" ? ("procedure" as const) : ("function" as const),
    signature: routine.signature,
    boost: routine.type === "table-function" ? -200 : 0,
  }));
}

function doltCompletionTables(context: DriverProfileSqlCompletionContext) {
  if (!context.suggestTables) return [];
  return DOLT_SQL_ROUTINES.filter((routine) => routine.type === "table-function").map((routine) => ({
    name: routine.name,
    detail: "Dolt table function",
    applyName: doltRoutineApplyName(routine, context.openingParenAfterCursor),
    boost: 200,
  }));
}

export function isDoltDriverProfile(driverProfile?: string): boolean {
  return driverProfile?.toLowerCase() === DOLT_DRIVER_PROFILE;
}

export function doltObjectTreeProfileForConnection(config?: ConnectionConfig): DriverProfileObjectTreeProfile | undefined {
  if (!config || !isDoltDriverProfile(config.driver_profile)) return undefined;
  const systemTablesVisible = doltSystemTablesVisible(config.driver_profile, config.url_params);
  return {
    cacheKey: `dolt-system-tables-v1:${systemTablesVisible ? "shown" : "hidden"}`,
    groupOverrides: systemTablesVisible
      ? [
          {
            nodeType: "group-tables",
            tableNameFilter: { includePatterns: [], excludePatterns: [DOLT_SYSTEM_TABLE_NAME_PATTERN] },
          },
          {
            nodeType: "group-dolt-system-tables",
            label: "tree.doltSystemTables",
            tableNameFilter: { includePatterns: [DOLT_SYSTEM_TABLE_NAME_PATTERN], excludePatterns: [] },
          },
        ]
      : [],
  };
}

function splitMysqlSessionVariables(value: string): string[] {
  const assignments: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let parenthesisDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        if (value[index + 1] === quote) {
          current += quote;
          index += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
    } else if (character === "(") {
      parenthesisDepth += 1;
      current += character;
    } else if (character === ")") {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      current += character;
    } else if ((character === "," || character === ";") && parenthesisDepth === 0) {
      if (current.trim()) assignments.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }

  if (current.trim()) assignments.push(current.trim());
  return assignments;
}

function sessionVariableName(assignment: string): string {
  const separator = assignment.indexOf("=");
  if (separator < 0) return "";
  return assignment
    .slice(0, separator)
    .trim()
    .replace(/^@@(?:session\.)?/i, "")
    .toLowerCase();
}

function sessionVariableValue(assignment: string): string {
  const separator = assignment.indexOf("=");
  return separator < 0
    ? ""
    : assignment
        .slice(separator + 1)
        .trim()
        .toLowerCase();
}

function mysqlSessionVariableAssignments(params: URLSearchParams): string[] {
  const assignments: string[] = [];
  for (const [key, value] of params) {
    if (key.toLowerCase() === MYSQL_SESSION_VARIABLES_PARAM.toLowerCase()) {
      assignments.push(...splitMysqlSessionVariables(value));
    }
  }
  return assignments;
}

export function doltSystemTablesVisible(driverProfile?: string, urlParams?: string): boolean {
  if (!isDoltDriverProfile(driverProfile)) return false;
  const params = new URLSearchParams((urlParams || "").trim().replace(/^\?/, ""));
  return mysqlSessionVariableAssignments(params).some((assignment) => sessionVariableName(assignment) === DOLT_SHOW_SYSTEM_TABLES_VARIABLE && ["1", "true", "on"].includes(sessionVariableValue(assignment)));
}

export function setDoltSystemTablesVisible(driverProfile: string | undefined, urlParams: string | undefined, visible: boolean): string {
  if (!isDoltDriverProfile(driverProfile)) return urlParams || "";

  const params = new URLSearchParams((urlParams || "").trim().replace(/^\?/, ""));
  const assignments = mysqlSessionVariableAssignments(params).filter((assignment) => sessionVariableName(assignment) !== DOLT_SHOW_SYSTEM_TABLES_VARIABLE);
  if (visible) assignments.push(`${DOLT_SHOW_SYSTEM_TABLES_VARIABLE}=1`);

  const sessionVariableParamKeys = Array.from(params.keys()).filter((key) => key.toLowerCase() === MYSQL_SESSION_VARIABLES_PARAM.toLowerCase());
  for (const key of sessionVariableParamKeys) params.delete(key);
  if (assignments.length > 0) params.set(MYSQL_SESSION_VARIABLES_PARAM, assignments.join(","));
  return params.toString();
}

export function doltSqlBuiltinTerms(driverProfile?: string): string {
  if (!isDoltDriverProfile(driverProfile)) return "";
  return DOLT_SQL_ROUTINES.map((routine) => routine.name.toLowerCase()).join(" ");
}

export function doltSqlRoutineSignatures(driverProfile?: string): Map<string, string[]> {
  if (!isDoltDriverProfile(driverProfile)) return new Map();
  return new Map(DOLT_SQL_ROUTINES.map((routine) => [routine.name, doltRoutineParameters(routine.signature)]));
}

export const DOLT_DRIVER_PROFILE_EXTENSION: DriverProfileExtensionDefinition = {
  id: DOLT_DRIVER_PROFILE,
  objectTreeProfile: doltObjectTreeProfileForConnection,
  completionTableMetadata: (tableName) =>
    tableName.toLowerCase().startsWith("dolt")
      ? {
          detail: "Dolt system table",
          boost: -1200,
        }
      : undefined,
  completionObjects: doltCompletionObjects,
  completionTables: doltCompletionTables,
  sqlBuiltinTerms: () => DOLT_SQL_ROUTINES.map((routine) => routine.name.toLowerCase()).join(" "),
  routineSignatures: () => new Map(DOLT_SQL_ROUTINES.map((routine) => [routine.name, doltRoutineParameters(routine.signature)])),
};
