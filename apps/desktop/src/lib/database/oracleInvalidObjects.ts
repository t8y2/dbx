import type { DatabaseType, ObjectSourceKind, OracleTriggerMetadata, QueryResult } from "@/types/database";

export type OracleInvalidObject = {
  owner: string;
  name: string;
  type: string;
  objectId: string;
  lastDdlTime: string;
};

export type OracleObjectError = {
  sequence: number;
  line: number;
  position: number;
  text: string;
};

export const ORACLE_INVALID_OBJECTS_PAGE_SIZE = 500;

export type OracleInvalidObjectsPageQuery = (sql: string, maxRows: number) => Promise<QueryResult>;

const ORACLE_COMPILE_TYPES = new Set(["VIEW", "MATERIALIZED VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE", "PACKAGE BODY", "TYPE", "TYPE BODY", "SYNONYM"]);

const OCEANBASE_COMPILE_TYPES = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY"]);

export interface OracleCompileOptions {
  triggerProfile?: Pick<OracleTriggerMetadata, "contractVersion" | "identityMode" | "engine" | "engineVersion">;
}

export function oracleInvalidObjectSourceKind(objectType: string): ObjectSourceKind | null {
  const kind = objectType.trim().toUpperCase().replaceAll(" ", "_");
  switch (kind) {
    case "VIEW":
    case "MATERIALIZED_VIEW":
    case "PROCEDURE":
    case "FUNCTION":
    case "TRIGGER":
    case "SEQUENCE":
    case "SYNONYM":
    case "PACKAGE":
    case "PACKAGE_BODY":
    case "TYPE":
    case "TYPE_BODY":
      return kind;
    default:
      return null;
  }
}

export function quoteOracleLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function quoteOracleIdentifier(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Invalid Oracle identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

export function buildOracleInvalidObjectsSql(owner: string, limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("Invalid row limit");
  const escapedOwner = quoteOracleLiteral(owner);
  return `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME\nFROM (SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = ${escapedOwner} AND STATUS = 'INVALID' ORDER BY OBJECT_NAME, OBJECT_TYPE)\nWHERE ROWNUM <= ${limit}`;
}

export function buildOracleInvalidObjectsPageSql(owner: string, afterObjectId = "0"): string {
  if (!/^(0|[1-9]\d*)$/.test(afterObjectId)) throw new Error("Invalid Oracle object ID cursor");
  return `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TO_CHAR(OBJECT_ID) AS OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME\nFROM (SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = ${quoteOracleLiteral(owner)} AND STATUS = 'INVALID' AND OBJECT_ID > ${afterObjectId} ORDER BY OBJECT_ID)\nWHERE ROWNUM <= ${ORACLE_INVALID_OBJECTS_PAGE_SIZE}`;
}

function strictInvalidObjectRows(rows: unknown[][], owner: string, previousId: bigint): OracleInvalidObject[] {
  let lastId = previousId;
  const result: OracleInvalidObject[] = [];
  for (const row of rows) {
    const [rowOwner, name, type, objectId, lastDdlTime] = row;
    if (typeof rowOwner !== "string" || rowOwner !== owner || typeof name !== "string" || !name || typeof type !== "string" || !type || typeof objectId !== "string" || !/^[1-9]\d*$/.test(objectId) || typeof lastDdlTime !== "string" || !lastDdlTime) {
      throw new Error("Incomplete Oracle invalid-object row");
    }
    const numericId = BigInt(objectId);
    if (numericId <= lastId) throw new Error("Oracle invalid-object cursor did not advance");
    lastId = numericId;
    result.push({ owner: rowOwner, name, type, objectId, lastDdlTime });
  }
  return result;
}

export async function readAllOracleInvalidObjects(query: OracleInvalidObjectsPageQuery, owner: string, options: { onProgress?: (count: number) => void; isCurrent?: () => boolean } = {}): Promise<OracleInvalidObject[]> {
  const objects: OracleInvalidObject[] = [];
  let cursor = "0";
  let previousId = 0n;
  const seen = new Set<string>();
  while (true) {
    if (options.isCurrent && !options.isCurrent()) throw new Error("Oracle invalid-object read is no longer current");
    const page = await query(buildOracleInvalidObjectsPageSql(owner, cursor), ORACLE_INVALID_OBJECTS_PAGE_SIZE + 1);
    if (options.isCurrent && !options.isCurrent()) throw new Error("Oracle invalid-object read is no longer current");
    if (page.execution_error) throw new Error(page.error?.detail ?? String(page.rows[0]?.[0] ?? "Oracle invalid-object page query failed"));
    if (page.truncated === true || page.rows.length > ORACLE_INVALID_OBJECTS_PAGE_SIZE) throw new Error("Oracle invalid-object page was truncated");
    const columns = new Set(page.columns.map((column) => column.trim().toUpperCase()));
    if (["OWNER", "OBJECT_NAME", "OBJECT_TYPE", "OBJECT_ID", "LAST_DDL_TIME"].some((column) => !columns.has(column))) throw new Error("Oracle invalid-object page omitted required columns");
    const mapped = strictInvalidObjectRows(page.rows, owner, previousId);
    for (const object of mapped) {
      if (seen.has(object.objectId)) throw new Error("Duplicate Oracle invalid-object ID");
      seen.add(object.objectId);
      previousId = BigInt(object.objectId);
    }
    objects.push(...mapped);
    options.onProgress?.(objects.length);
    if (page.rows.length < ORACLE_INVALID_OBJECTS_PAGE_SIZE) return objects;
    cursor = mapped[mapped.length - 1]?.objectId ?? cursor;
    if (!mapped.length) throw new Error("Oracle invalid-object cursor did not advance");
  }
}

export function buildOracleObjectErrorsSql(owner: string, object: Pick<OracleInvalidObject, "name" | "type">): string {
  return `SELECT SEQUENCE, LINE, POSITION, TEXT FROM ALL_ERRORS WHERE OWNER = ${quoteOracleLiteral(owner)} AND NAME = ${quoteOracleLiteral(object.name)} AND TYPE = ${quoteOracleLiteral(object.type)} ORDER BY SEQUENCE`;
}

export function buildOracleObjectIdentitySql(owner: string, object: OracleInvalidObject): string {
  return `SELECT TO_CHAR(OBJECT_ID) AS OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME FROM ALL_OBJECTS WHERE OWNER = ${quoteOracleLiteral(owner)} AND OBJECT_NAME = ${quoteOracleLiteral(object.name)} AND OBJECT_TYPE = ${quoteOracleLiteral(object.type)} AND STATUS = 'INVALID'`;
}

export function buildOracleObjectStatusSql(owner: string, object: OracleInvalidObject): string {
  return `SELECT TO_CHAR(OBJECT_ID) AS OBJECT_ID, TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD HH24:MI:SS') AS LAST_DDL_TIME, STATUS FROM ALL_OBJECTS WHERE OWNER = ${quoteOracleLiteral(owner)} AND OBJECT_NAME = ${quoteOracleLiteral(object.name)} AND OBJECT_TYPE = ${quoteOracleLiteral(object.type)}`;
}

export function oracleCompileUnsupportedReason(dbType: DatabaseType, objectType: string, options?: OracleCompileOptions): "unsupported-type" | "unsupported-on-engine" | null {
  const type = objectType.toUpperCase();
  if (!ORACLE_COMPILE_TYPES.has(type)) return "unsupported-type";
  if (dbType === "oceanbase-oracle" && !OCEANBASE_COMPILE_TYPES.has(type)) {
    const profile = options?.triggerProfile;
    if (type === "TRIGGER" && profile?.contractVersion === 1 && profile.identityMode === "exact" && profile.engine === "oceanbase-oracle" && /(?:^|[^0-9])4\.2\.5\.7(?:[^0-9]|$)/.test(profile.engineVersion ?? "")) return null;
    return "unsupported-on-engine";
  }
  return null;
}

export function buildOracleCompileSql(dbType: DatabaseType, owner: string, object: Pick<OracleInvalidObject, "name" | "type">, options?: OracleCompileOptions): string {
  const type = object.type.toUpperCase();
  if (oracleCompileUnsupportedReason(dbType, type, options)) throw new Error("Unsupported Oracle object compile type");
  const qualified = `${quoteOracleIdentifier(owner)}.${quoteOracleIdentifier(object.name)}`;
  if (type === "SYNONYM") return `ALTER ${owner === "PUBLIC" ? "PUBLIC " : ""}SYNONYM ${owner === "PUBLIC" ? quoteOracleIdentifier(object.name) : qualified} COMPILE`;
  if (type === "MATERIALIZED VIEW") return `ALTER MATERIALIZED VIEW ${qualified} COMPILE`;
  if (type === "PACKAGE BODY") return `ALTER PACKAGE ${qualified} COMPILE BODY${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  if (type === "PACKAGE" && dbType === "oracle") return `ALTER PACKAGE ${qualified} COMPILE SPECIFICATION REUSE SETTINGS`;
  if (type === "TYPE") return `ALTER TYPE ${qualified} COMPILE SPECIFICATION${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  if (type === "TYPE BODY") return `ALTER TYPE ${qualified} COMPILE BODY${dbType === "oracle" ? " REUSE SETTINGS" : ""}`;
  const reuseSettings = dbType === "oracle" && ["PROCEDURE", "FUNCTION", "TRIGGER"].includes(type) ? " REUSE SETTINGS" : "";
  return `ALTER ${type} ${qualified} COMPILE${reuseSettings}`;
}

export function mapOracleInvalidObjects(rows: unknown[][], owner: string): OracleInvalidObject[] {
  return rows.flatMap((row) => {
    const name = row[1];
    const type = row[2];
    if (typeof name !== "string" || typeof type !== "string") return [];
    return [{ owner: String(row[0] ?? owner), name, type, objectId: String(row[3] ?? ""), lastDdlTime: String(row[4] ?? "") }];
  });
}

export function mapOracleObjectErrors(rows: unknown[][]): OracleObjectError[] {
  return rows
    .flatMap((row) => {
      const sequence = Number(row[0]);
      const line = Number(row[1]);
      const position = Number(row[2]);
      if (![sequence, line, position].every(Number.isSafeInteger)) return [];
      return [{ sequence, line, position, text: String(row[3] ?? "") }];
    })
    .sort((a, b) => a.sequence - b.sequence);
}
