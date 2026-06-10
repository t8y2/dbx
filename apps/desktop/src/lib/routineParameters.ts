import * as api from "@/lib/api";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { RoutineParameter, RoutineParameterMode } from "./routineExecutionSql";

export interface LoadRoutineParametersOptions {
  connectionId: string;
  database: string;
  databaseType?: DatabaseType;
  schema?: string;
  routineName: string;
}

export async function loadRoutineParameters(options: LoadRoutineParametersOptions): Promise<RoutineParameter[]> {
  const sql = routineParametersQuery(options);
  if (!sql) return [];
  const result = await api.executeQuery(options.connectionId, options.database, sql, options.schema, undefined, {
    maxRows: 200,
    pageSize: 200,
  });
  return routineParametersFromResult(result);
}

export function supportsRoutineParameterMetadata(databaseType?: DatabaseType): boolean {
  return databaseType === "postgres" || databaseType === "mysql" || databaseType === "doris" || databaseType === "starrocks" || databaseType === "sqlserver" || databaseType === "oracle" || databaseType === "dameng" || databaseType === "oceanbase-oracle";
}

export function routineParametersQuery(options: Pick<LoadRoutineParametersOptions, "database" | "databaseType" | "schema" | "routineName">): string | null {
  if (!supportsRoutineParameterMetadata(options.databaseType)) return null;
  const effectiveSchema = options.schema || (options.databaseType === "postgres" ? "public" : "") || (options.databaseType === "mysql" || options.databaseType === "doris" || options.databaseType === "starrocks" ? options.database : "");
  const schema = quoteSqlLiteral(effectiveSchema);
  const name = quoteSqlLiteral(options.routineName);
  if (options.databaseType === "postgres") {
    return `
SELECT
  NULLIF(arg.name, '') AS name,
  arg.data_type,
  CASE arg.mode
    WHEN 'i' THEN 'IN'
    WHEN 'o' THEN 'OUT'
    WHEN 'b' THEN 'INOUT'
    WHEN 'v' THEN 'IN'
    WHEN 't' THEN 'OUT'
    ELSE 'IN'
  END AS mode,
  arg.ordinal,
  CASE
    WHEN COALESCE(arg.mode, 'i') IN ('i', 'b', 'v') AND p.pronargdefaults > 0 AND arg.input_ordinal > p.pronargs - p.pronargdefaults THEN TRUE
    ELSE FALSE
  END AS has_default
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL (
  SELECT
    gs.ordinal AS ordinal,
    p.proargnames[gs.ordinal] AS name,
    CASE
      WHEN p.proallargtypes IS NULL THEN p.proargtypes[gs.ordinal - 1]
      ELSE p.proallargtypes[gs.ordinal]
    END::regtype::text AS data_type,
    COALESCE(p.proargmodes[gs.ordinal], 'i') AS mode,
    COUNT(*) FILTER (WHERE COALESCE(p.proargmodes[gs.ordinal], 'i') IN ('i', 'b', 'v')) OVER (ORDER BY gs.ordinal) AS input_ordinal
  FROM generate_series(1, COALESCE(array_length(p.proallargtypes, 1), p.pronargs)) AS gs(ordinal)
) arg
WHERE p.prokind = 'p'
  AND n.nspname = ${schema}
  AND p.proname = ${name}
ORDER BY arg.ordinal;`.trim();
  }
  if (options.databaseType === "mysql" || options.databaseType === "doris" || options.databaseType === "starrocks") {
    return `
SELECT
  PARAMETER_NAME AS name,
  DTD_IDENTIFIER AS data_type,
  COALESCE(PARAMETER_MODE, 'IN') AS mode,
  ORDINAL_POSITION AS ordinal,
  FALSE AS has_default
FROM information_schema.PARAMETERS
WHERE SPECIFIC_SCHEMA = ${schema}
  AND SPECIFIC_NAME = ${name}
  AND ORDINAL_POSITION > 0
ORDER BY ORDINAL_POSITION;`.trim();
  }
  if (options.databaseType === "sqlserver") {
    return `
SELECT
  p.name AS name,
  TYPE_NAME(p.user_type_id) AS data_type,
  CASE WHEN p.is_output = 1 THEN 'OUT' ELSE 'IN' END AS mode,
  p.parameter_id AS ordinal,
  p.has_default_value AS has_default
FROM sys.parameters p
JOIN sys.objects o ON o.object_id = p.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('P', 'PC')
  AND s.name = ${schema}
  AND o.name = ${name}
ORDER BY p.parameter_id;`.trim();
  }
  if (options.databaseType === "oracle" || options.databaseType === "dameng" || options.databaseType === "oceanbase-oracle") {
    return `
SELECT
  ARGUMENT_NAME AS name,
  DATA_TYPE AS data_type,
  IN_OUT AS mode,
  POSITION AS ordinal,
  DEFAULTED AS has_default
FROM ALL_ARGUMENTS
WHERE OWNER = UPPER(${schema})
  AND OBJECT_NAME = UPPER(${name})
  AND POSITION > 0
ORDER BY SEQUENCE;`.trim();
  }
  return null;
}

export function routineParametersFromResult(result: QueryResult): RoutineParameter[] {
  return result.rows
    .map((row, index) => ({
      name: String(row[0] || `arg${index + 1}`),
      dataType: String(row[1] || ""),
      mode: normalizeParameterMode(row[2]),
      ordinal: Number(row[3] || index + 1),
      hasDefault: normalizeBoolean(row[4]),
    }))
    .filter((parameter) => parameter.mode !== "RETURN");
}

function normalizeParameterMode(value: unknown): RoutineParameterMode {
  const mode = String(value || "IN")
    .toUpperCase()
    .replace(/\s+/g, "");
  if (mode === "IN") return "IN";
  if (mode === "OUT") return "OUT";
  if (mode === "INOUT" || mode === "IN/OUT") return "INOUT";
  if (mode === "RETURN") return "RETURN";
  return "UNKNOWN";
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value || "").toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1";
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
