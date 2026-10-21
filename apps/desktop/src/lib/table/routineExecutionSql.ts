import type { DatabaseType } from "@/types/database";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";

export interface BuildRoutineExecutionSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
}

export type RoutineParameterMode = "IN" | "OUT" | "INOUT" | "RETURN" | "UNKNOWN";

export interface RoutineParameter {
  name: string;
  dataType: string;
  mode: RoutineParameterMode;
  ordinal: number;
  hasDefault?: boolean;
  defaultValue?: string | null;
  nullable?: boolean | null;
}

export interface RoutineParameterValue extends RoutineParameter {
  value: string;
  useNull?: boolean;
  useDefault?: boolean;
}

export function qualifiedRoutineName(options: BuildRoutineExecutionSqlOptions): string {
  const { databaseType, schema, routineName } = options;
  if (databaseType === "databend") return routineName;
  if (isSchemaAware(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, routineName)}`;
  }
  return quoteTableIdentifier(databaseType, routineName);
}

export function buildProcedureExecutionSql(options: BuildRoutineExecutionSqlOptions): string {
  return buildProcedureExecutionSqlFromValues({ ...options, parameters: [] });
}

export function buildProcedureExecutionSqlFromValues(options: BuildRoutineExecutionSqlOptions & { parameters: RoutineParameterValue[] }): string {
  const routine = qualifiedRoutineName(options);
  const sortedParameters = [...options.parameters].sort((a, b) => a.ordinal - b.ordinal);
  if (options.databaseType === "sqlserver") {
    return buildSqlServerProcedureExecutionSql(routine, sortedParameters);
  }
  if (options.databaseType === "mysql") {
    return buildMySqlProcedureExecutionSql(routine, sortedParameters);
  }
  if (options.databaseType === "xugu") {
    return buildXuguProcedureExecutionSql(routine, sortedParameters);
  }
  if (options.databaseType === "oracle" || options.databaseType === "oceanbase-oracle") {
    return buildOracleProcedureExecutionSql(options.databaseType, routine, sortedParameters);
  }
  const values = sortedParameters.filter((parameter) => shouldIncludeParameter(parameter));
  const useNamedArguments = shouldUseNamedArguments(options.databaseType, sortedParameters);
  if (options.databaseType === "dameng") {
    return `BEGIN\n  ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});\nEND;`;
  }
  if (options.databaseType === "databend") {
    return `CALL PROCEDURE ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
  }
  return `CALL ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
}

function buildXuguProcedureExecutionSql(routine: string, sortedParameters: RoutineParameterValue[]): string {
  const callableParameters = sortedParameters.filter((parameter) => parameter.mode !== "RETURN");
  const useNamedArguments = shouldUseXuguNamedArguments(callableParameters);
  const args = callableParameters.flatMap((parameter) => {
    if (parameter.useDefault && parameter.hasDefault && acceptsRoutineInput(parameter)) return [];
    const value = parameter.mode === "OUT" ? "NULL" : routineParameterSqlValue("xugu", parameter);
    if (!useNamedArguments) return [value];
    return [`${quoteTableIdentifier("xugu", parameter.name)} => ${value}`];
  });
  return `CALL ${routine}(${args.join(", ")});`;
}

function shouldUseXuguNamedArguments(parameters: RoutineParameterValue[]): boolean {
  let omittedDefault = false;
  for (const parameter of parameters) {
    if (parameter.useDefault && parameter.hasDefault && acceptsRoutineInput(parameter)) {
      omittedDefault = true;
      continue;
    }
    if (omittedDefault) return parameters.every((item) => !!item.name);
  }
  return false;
}

export function shouldIncludeParameter(parameter: RoutineParameterValue): boolean {
  if (parameter.useDefault && parameter.hasDefault) return false;
  return acceptsRoutineInput(parameter);
}

export function acceptsRoutineInput(parameter: Pick<RoutineParameterValue, "mode">): boolean {
  return parameter.mode === "IN" || parameter.mode === "INOUT" || parameter.mode === "UNKNOWN";
}

export function routineParameterSqlValue(databaseType: DatabaseType | undefined, parameter: RoutineParameterValue): string {
  if (parameter.useNull) return "NULL";
  const raw = parameter.value;
  if (raw.trim() === "") return "NULL";
  if (looksLikeNumericType(parameter.dataType)) return raw.trim();
  if (looksLikeBooleanType(parameter.dataType)) return normalizeBooleanLiteral(raw, databaseType);
  return quoteSqlString(raw);
}

function sqlServerParameterName(name: string): string {
  return name.startsWith("@") ? name : `@${name}`;
}

function buildMySqlProcedureExecutionSql(routine: string, sortedParameters: RoutineParameterValue[]): string {
  const outputBindings = new Map<RoutineParameterValue, { variableName: string; alias: string }>();
  const initializations: string[] = [];

  sortedParameters.forEach((parameter, index) => {
    if (!returnsRoutineOutput(parameter)) return;
    const variableName = `@dbx_output_${index + 1}`;
    const initialValue = parameter.mode === "INOUT" ? routineParameterSqlValue("mysql", parameter) : "NULL";
    initializations.push(`SET ${variableName} = ${initialValue};`);
    outputBindings.set(parameter, {
      variableName,
      alias: quoteTableIdentifier("mysql", parameter.name.replace(/^@/, "") || `output_${index + 1}`),
    });
  });

  const args = sortedParameters.flatMap((parameter) => {
    const outputBinding = outputBindings.get(parameter);
    if (outputBinding) return [outputBinding.variableName];
    if (!shouldIncludeParameter(parameter)) return [];
    return [routineParameterSqlValue("mysql", parameter)];
  });
  const statements = [...initializations, `CALL ${routine}(${args.join(", ")});`];
  if (outputBindings.size > 0) {
    statements.push(`SELECT ${[...outputBindings.values()].map(({ variableName, alias }) => `${variableName} AS ${alias}`).join(", ")};`);
  }
  return statements.join("\n");
}

function buildSqlServerProcedureExecutionSql(routine: string, sortedParameters: RoutineParameterValue[]): string {
  const outputBindings = new Map<RoutineParameterValue, { variableName: string; alias: string }>();
  const declarations: string[] = [];

  sortedParameters.forEach((parameter, index) => {
    if (!returnsRoutineOutput(parameter)) return;
    if (parameter.mode === "INOUT" && parameter.useDefault && parameter.hasDefault) return;
    const declarationType = parameter.dataType.trim();
    if (!declarationType) return;

    const variableName = `@dbx_output_${index + 1}`;
    const initialValue = parameter.mode === "INOUT" ? ` = ${routineParameterSqlValue("sqlserver", parameter)}` : "";
    declarations.push(`DECLARE ${variableName} ${declarationType}${initialValue};`);
    outputBindings.set(parameter, {
      variableName,
      alias: quoteTableIdentifier("sqlserver", parameter.name.replace(/^@/, "") || `output_${index + 1}`),
    });
  });

  const args = sortedParameters.flatMap((parameter) => {
    const outputBinding = outputBindings.get(parameter);
    if (outputBinding) {
      return [`${sqlServerParameterName(parameter.name)} = ${outputBinding.variableName} OUTPUT`];
    }
    if (returnsRoutineOutput(parameter) || !shouldIncludeParameter(parameter)) return [];
    return [`${sqlServerParameterName(parameter.name)} = ${routineParameterSqlValue("sqlserver", parameter)}`];
  });
  const statements = [...declarations, args.length > 0 ? `EXEC ${routine} ${args.join(", ")};` : `EXEC ${routine};`];

  if (outputBindings.size > 0) {
    statements.push(`SELECT ${[...outputBindings.values()].map(({ variableName, alias }) => `${variableName} AS ${alias}`).join(", ")};`);
  }
  return statements.join("\n");
}

function buildOracleProcedureExecutionSql(databaseType: "oracle" | "oceanbase-oracle", routine: string, sortedParameters: RoutineParameterValue[]): string {
  const outputBindings = new Map<RoutineParameterValue, string>();
  const declarations: string[] = [];
  const printStatements: string[] = [];

  sortedParameters.forEach((parameter, index) => {
    if (!returnsRoutineOutput(parameter)) return;
    const variableName = `dbx_output_${index + 1}`;
    const initialValue = parameter.mode === "INOUT" ? ` := ${routineParameterSqlValue(databaseType, parameter)}` : "";
    declarations.push(`  ${variableName} ${oracleVariableType(parameter.dataType)}${initialValue};`);
    outputBindings.set(parameter, variableName);
    const printable = oraclePrintableValue(parameter.dataType, variableName);
    if (printable) {
      printStatements.push(`  DBMS_OUTPUT.PUT_LINE(${quoteSqlString(`${parameter.name || `output_${index + 1}`} = `)} || ${printable});`);
    }
  });

  const useNamedArguments = shouldUseOracleNamedArguments(sortedParameters, outputBindings);
  const args = sortedParameters.flatMap((parameter) => {
    const variableName = outputBindings.get(parameter);
    if (variableName) {
      return [useNamedArguments ? `${quoteTableIdentifier(databaseType, parameter.name)} => ${variableName}` : variableName];
    }
    if (!shouldIncludeParameter(parameter)) return [];
    return [routineArgumentSql(databaseType, parameter, useNamedArguments)];
  });
  const call = `  ${routine}(${args.join(", ")});`;
  if (outputBindings.size === 0) return `BEGIN\n${call}\nEND;`;
  return ["DECLARE", ...declarations, "BEGIN", call, ...printStatements, "END;"].join("\n");
}

function shouldUseOracleNamedArguments(sortedParameters: RoutineParameterValue[], outputBindings: Map<RoutineParameterValue, string>): boolean {
  let omittedDefault = false;
  for (const parameter of sortedParameters) {
    if (!outputBindings.has(parameter) && parameter.useDefault && parameter.hasDefault && acceptsRoutineInput(parameter)) {
      omittedDefault = true;
      continue;
    }
    if (omittedDefault && (outputBindings.has(parameter) || shouldIncludeParameter(parameter))) return sortedParameters.every((item) => !!item.name);
  }
  return false;
}

// `ALL_ARGUMENTS.DATA_TYPE` carries no length, and PL/SQL rejects unconstrained string variables (PLS-00215).
// A CHAR formal parameter is blank-padded to the length of the variable passed in, so CHAR and NCHAR use the
// SQL column limits instead of the PL/SQL maximum. NVARCHAR2 is sized for the 3-byte UTF8 national character set.
function oracleVariableType(dataType: string): string {
  const type = dataType.trim().toUpperCase();
  if (type.includes("(")) return dataType.trim();
  switch (type) {
    case "VARCHAR2":
    case "VARCHAR":
    case "RAW":
      return `${type}(32767)`;
    case "NVARCHAR2":
      return "NVARCHAR2(10922)";
    case "CHAR":
      return "CHAR(2000)";
    case "NCHAR":
      return "NCHAR(1000)";
    case "REF CURSOR":
      return "SYS_REFCURSOR";
    case "PL/SQL BOOLEAN":
      return "BOOLEAN";
    default:
      return dataType.trim();
  }
}

// `DBMS_OUTPUT.PUT_LINE` raises ORU-10028 above 32767 bytes, which would fail the whole block after the
// procedure has run, so string values are truncated and LOB, RAW, BOOLEAN, and cursor values are not printed.
function oraclePrintableValue(dataType: string, variableName: string): string | null {
  const type = dataType.trim().toUpperCase().replace(/\(.*$/, "").trim();
  if (["VARCHAR2", "VARCHAR", "NVARCHAR2", "CHAR", "NCHAR"].includes(type)) return `SUBSTR(${variableName}, 1, 4000)`;
  if (/^(NUMBER|FLOAT|INTEGER|BINARY_INTEGER|PLS_INTEGER|BINARY_FLOAT|BINARY_DOUBLE|DATE|ROWID|UROWID)$/.test(type)) return variableName;
  if (/^(TIMESTAMP|INTERVAL)\b/.test(type)) return variableName;
  return null;
}

function returnsRoutineOutput(parameter: Pick<RoutineParameterValue, "mode">): boolean {
  return parameter.mode === "OUT" || parameter.mode === "INOUT";
}

function routineArgumentSql(databaseType: DatabaseType | undefined, parameter: RoutineParameterValue, useNamedArguments: boolean): string {
  const value = routineParameterSqlValue(databaseType, parameter);
  if (!useNamedArguments) return value;
  return `${quoteTableIdentifier(databaseType, parameter.name)} => ${value}`;
}

function shouldUseNamedArguments(databaseType: DatabaseType | undefined, sortedParameters: RoutineParameterValue[]): boolean {
  if (databaseType !== "postgres" && databaseType !== "oracle" && databaseType !== "dameng" && databaseType !== "oceanbase-oracle") {
    return false;
  }
  let omittedDefault = false;
  for (const parameter of sortedParameters) {
    if (parameter.useDefault && parameter.hasDefault && acceptsRoutineInput(parameter)) {
      omittedDefault = true;
      continue;
    }
    if (omittedDefault && shouldIncludeParameter(parameter)) return sortedParameters.every((item) => !!item.name);
  }
  return false;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function looksLikeNumericType(dataType: string): boolean {
  return /\b(bigint|int|integer|smallint|tinyint|serial|number|numeric|decimal|dec|float|double|real|money)\b/i.test(dataType);
}

function looksLikeBooleanType(dataType: string): boolean {
  return /\b(bool|boolean|bit)\b/i.test(dataType);
}

function normalizeBooleanLiteral(value: string, databaseType: DatabaseType | undefined): string {
  const normalized = value.trim().toLowerCase();
  const truthy = normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y" || normalized === "1";
  const falsy = normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n" || normalized === "0";
  if (!truthy && !falsy) return quoteSqlString(value);
  if (databaseType === "sqlserver") return truthy ? "1" : "0";
  return truthy ? "TRUE" : "FALSE";
}
