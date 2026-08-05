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
  const values = sortedParameters.filter((parameter) => shouldIncludeParameter(parameter));
  const useNamedArguments = shouldUseNamedArguments(options.databaseType, sortedParameters);
  if (options.databaseType === "oracle" || options.databaseType === "dameng" || options.databaseType === "oceanbase-oracle") {
    return `BEGIN\n  ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});\nEND;`;
  }
  if (options.databaseType === "databend") {
    return `CALL PROCEDURE ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
  }
  return `CALL ${routine}(${values.map((parameter) => routineArgumentSql(options.databaseType, parameter, useNamedArguments)).join(", ")});`;
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
