import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import { invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { DatabaseType, OracleViewRenameIssue, QueryResult } from "@/types/database";

type DependentType = "VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER";
type RewriteableDependentType = Exclude<DependentType, "VIEW">;
type ObjectType = "TABLE" | "OPERATOR" | "PACKAGE BODY" | "TYPE BODY" | "SEQUENCE" | "SYNONYM" | "PACKAGE" | "MATERIALIZED VIEW" | "TYPE" | DependentType;

export interface OracleTableRenameTarget {
  connectionId: string;
  database: string;
  databaseType: Extract<DatabaseType, "oracle" | "oceanbase-oracle">;
  schema: string;
  oldName: string;
  newName: string;
}

export interface OracleTableRenameIssue {
  code: string;
  message: string;
  objectName?: string;
  location?: { line: number; column: number };
  repairable: boolean;
}

export interface OracleTableRenameDependent {
  name: string;
  objectType: DependentType;
  objectId: string;
  source: string;
  executionSource: string;
  status: string;
  grants: string;
  errors: string;
  triggerStatus?: string;
  triggerTable?: string;
  draft: string;
  rewrittenSource: string;
  fingerprint: string;
  originalFingerprint: string;
  rewriteRequired: boolean;
}

export interface OracleTableRenameStep {
  kind: "rename" | "replace" | "compile";
  objectName: string;
  objectType: ObjectType;
  sql: string;
}

export interface OracleTableRenamePlan {
  target: OracleTableRenameTarget;
  canonicalNewName: string;
  tableObjectId: string;
  tableSnapshot: OracleTableSnapshot | null;
  dependents: OracleTableRenameDependent[];
  dependencyEdges: string[];
  issues: OracleTableRenameIssue[];
  metadataComplete: boolean;
  executable: boolean;
  steps: OracleTableRenameStep[];
  statements: string[];
}

interface OracleTableSnapshot {
  source: string;
  grants: string;
  indexes: string;
  indexColumns: string;
  constraints: string;
  constraintColumns: string;
  incomingForeignKeys: string;
  boundTriggers: string;
}

export class OracleTableRenameFailure extends Error {
  constructor(
    public readonly plan: OracleTableRenamePlan,
    public readonly completed: string[],
    public readonly uncertain: string,
    public readonly reconciliation: "confirmed" | "not-confirmed" | "unknown",
    cause: unknown,
  ) {
    super(`Table rename stopped. Confirmed: ${completed.join(", ") || "none"}. ${uncertain} is ${reconciliation}. ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

const metadataLimit = 5000;
const sourceLimit = 1_000_000;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const acceptedTypes = new Set<DependentType>(["VIEW", "PROCEDURE", "FUNCTION", "TRIGGER"]);
const tableNamespaceTypes: ObjectType[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "SYNONYM", "PACKAGE", "MATERIALIZED VIEW", "TYPE", "OPERATOR"];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function query(target: OracleTableRenameTarget, sql: string): Promise<QueryResult> {
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { maxRows: metadataLimit + 1 });
  if (result.execution_error) throw new BackendErrorException(result.error || "Metadata query failed.");
  if (result.truncated || result.has_more || result.rows.length > metadataLimit || result.large_value_cells?.length) {
    throw new Error("Metadata is incomplete; refresh the table rename plan before execution.");
  }
  return result;
}

async function checkOwner(target: OracleTableRenameTarget) {
  const result = await query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
  if (result.rows.length !== 1 || result.rows[0][0] !== target.schema || result.rows[0][1] !== target.schema) {
    throw new Error("Table rename requires the object's owner and matching current schema.");
  }
}

async function objectStates(target: OracleTableRenameTarget, name: string, types: ObjectType[]) {
  if (!types.length) return [] as unknown[][];
  const objectTypes = types.map(literal).join(",");
  return (await query(target, `SELECT OBJECT_TYPE, OBJECT_ID, STATUS FROM USER_OBJECTS WHERE OBJECT_NAME=${literal(name)} AND OBJECT_TYPE IN (${objectTypes}) ORDER BY OBJECT_TYPE`)).rows;
}

async function readSource(target: OracleTableRenameTarget, objectType: ObjectType, name: string) {
  const metadataType = objectType === "TABLE" ? "TABLE" : objectType;
  const ddl = `DBMS_METADATA.GET_DDL(${literal(metadataType)},${literal(name)},${literal(target.schema)})`;
  const lengthRows = (await query(target, `SELECT DBMS_LOB.GETLENGTH(${ddl}) FROM DUAL`)).rows;
  const length = Number(lengthRows[0]?.[0]);
  if (lengthRows.length !== 1 || !Number.isSafeInteger(length) || length <= 0 || length > sourceLimit) throw new Error(`Complete ${objectType} DDL is unavailable for ${name}.`);
  let source = "";
  for (let firstOffset = 1; firstOffset <= length; firstOffset += 32_000) {
    const offsets: number[] = [];
    for (let offset = firstOffset; offset <= length && offsets.length < 32; offset += 1000) offsets.push(offset);
    const rows = (await query(target, offsets.map((offset) => `SELECT ${offset} CHUNK_OFFSET, DBMS_LOB.SUBSTR(${ddl},1000,${offset}) CHUNK_TEXT FROM DUAL`).join(" UNION ALL "))).rows;
    const chunks = new Map(rows.map((row) => [Number(row[0]), row[1]]));
    if (rows.length !== offsets.length || chunks.size !== offsets.length) throw new Error(`Complete DDL is unavailable for ${name}.`);
    for (const offset of offsets) {
      const chunk = chunks.get(offset);
      if (typeof chunk !== "string" || Array.from(chunk).length !== Math.min(1000, length - offset + 1)) throw new Error(`Complete DDL is unavailable for ${name}.`);
      source += chunk;
    }
  }
  return source;
}

async function readGrants(target: OracleTableRenameTarget, name: string) {
  const tables = await query(target, `SELECT GRANTOR, GRANTEE, PRIVILEGE, GRANTABLE FROM ALL_TAB_PRIVS WHERE TABLE_SCHEMA=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  const schemaColumn = target.databaseType === "oracle" ? "TABLE_SCHEMA" : "OWNER";
  const columns = await query(target, `SELECT GRANTOR, GRANTEE, COLUMN_NAME, PRIVILEGE, GRANTABLE FROM ALL_COL_PRIVS WHERE ${schemaColumn}=${literal(target.schema)} AND TABLE_NAME=${literal(name)}`);
  return JSON.stringify([tables.rows.map((row) => JSON.stringify(row)).sort(), columns.rows.map((row) => JSON.stringify(row)).sort()]);
}

async function readErrors(target: OracleTableRenameTarget, name: string, objectType: DependentType) {
  const rows = (await query(target, `SELECT ATTRIBUTE, LINE, POSITION, TEXT FROM USER_ERRORS WHERE NAME=${literal(name)} AND TYPE=${literal(objectType)} ORDER BY SEQUENCE`)).rows;
  return JSON.stringify(rows.map((row) => row.map((value) => (value === null ? null : String(value)))));
}

async function readTrigger(target: OracleTableRenameTarget, name: string) {
  const rows = (await query(target, `SELECT STATUS, TABLE_NAME FROM USER_TRIGGERS WHERE TRIGGER_NAME=${literal(name)}`)).rows;
  if (rows.length !== 1 || typeof rows[0][0] !== "string" || typeof rows[0][1] !== "string") throw new Error(`Trigger metadata for ${name} is incomplete.`);
  return { status: rows[0][0] as string, table: rows[0][1] as string };
}

async function readBoundTriggers(target: OracleTableRenameTarget, tableName: string) {
  const rows = (await query(target, `SELECT TRIGGER_NAME, STATUS FROM USER_TRIGGERS WHERE TABLE_NAME=${literal(tableName)} ORDER BY TRIGGER_NAME`)).rows;
  if (rows.some((row) => typeof row[0] !== "string" || !["ENABLED", "DISABLED"].includes(String(row[1])))) throw new Error(`Bound trigger metadata for ${tableName} is incomplete.`);
  return rows;
}

async function readTableSnapshot(target: OracleTableRenameTarget, name: string): Promise<OracleTableSnapshot> {
  const [source, grants, indexes, indexColumns, constraints, constraintColumns, incomingForeignKeys, boundTriggers] = await Promise.all([
    readSource(target, "TABLE", name),
    readGrants(target, name),
    query(target, `SELECT INDEX_NAME, INDEX_TYPE, UNIQUENESS, STATUS, TABLESPACE_NAME FROM USER_INDEXES WHERE TABLE_NAME=${literal(name)} ORDER BY INDEX_NAME`),
    query(target, `SELECT INDEX_NAME, COLUMN_NAME, COLUMN_POSITION, DESCEND FROM USER_IND_COLUMNS WHERE TABLE_NAME=${literal(name)} ORDER BY INDEX_NAME, COLUMN_POSITION`),
    query(target, `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, STATUS, VALIDATED, DEFERRABLE, DEFERRED, DELETE_RULE, R_OWNER, R_CONSTRAINT_NAME FROM USER_CONSTRAINTS WHERE TABLE_NAME=${literal(name)} ORDER BY CONSTRAINT_NAME`),
    query(target, `SELECT CONSTRAINT_NAME, COLUMN_NAME, POSITION FROM USER_CONS_COLUMNS WHERE TABLE_NAME=${literal(name)} ORDER BY CONSTRAINT_NAME, POSITION`),
    query(
      target,
      `SELECT c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME, c.STATUS, c.VALIDATED, c.DELETE_RULE, c.R_OWNER, c.R_CONSTRAINT_NAME FROM ALL_CONSTRAINTS c JOIN ALL_CONSTRAINTS r ON r.OWNER=c.R_OWNER AND r.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME WHERE c.CONSTRAINT_TYPE='R' AND r.OWNER=${literal(target.schema)} AND r.TABLE_NAME=${literal(name)} ORDER BY c.OWNER, c.CONSTRAINT_NAME`,
    ),
    readBoundTriggers(target, name),
  ]);
  return {
    source,
    grants,
    indexes: JSON.stringify(indexes.rows),
    indexColumns: JSON.stringify(indexColumns.rows),
    constraints: JSON.stringify(constraints.rows),
    constraintColumns: JSON.stringify(constraintColumns.rows),
    incomingForeignKeys: JSON.stringify(incomingForeignKeys.rows),
    boundTriggers: JSON.stringify(boundTriggers),
  };
}

function maskTriggerCommentsAndStrings(source: string) {
  const output = source.split("");
  const mask = (start: number, end: number) => {
    for (let index = start; index < end; index++) if (source[index] !== "\n" && source[index] !== "\r") output[index] = " ";
  };
  for (let index = 0; index < source.length;) {
    if (source.startsWith("--", index)) {
      const newline = source.indexOf("\n", index + 2);
      const end = newline < 0 ? source.length : newline;
      mask(index, end);
      index = end;
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) return "";
      mask(index, close + 2);
      index = close + 2;
    } else if ((source[index] === "q" || source[index] === "Q") && source[index + 1] === "'") {
      const opener = source[index + 2];
      if (!opener) return "";
      const closer = ({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[opener] || opener;
      const end = source.indexOf(`${closer}'`, index + 3);
      if (end < 0) return "";
      mask(index, end + 2);
      index = end + 2;
    } else if (source[index] === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "'" && source[index + 1] === "'") index += 2;
        else if (source[index++] === "'") break;
      }
      mask(start, index);
    } else index++;
  }
  return output.join("");
}

function executableTriggerSource(source: string, schema: string, name: string, status: string) {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffix = new RegExp(`\\s*ALTER\\s+TRIGGER\\s+"?${escaped(schema)}"?\\s*\\.\\s*"?${escaped(name)}"?\\s+(ENABLE|DISABLE)\\s*;?\\s*$`, "i");
  const match = suffix.exec(source);
  if (!match) throw new Error(`Trigger ${name} DDL has an unsupported state clause.`);
  let create = source.slice(0, match.index).trimEnd();
  const disabled = status === "DISABLED";
  if (disabled) {
    const syntax = maskTriggerCommentsAndStrings(create);
    if (!/\bFOR\s+EACH\s+ROW\b/i.test(syntax)) throw new Error(`Disabled trigger ${name} is outside the supported row-trigger subset.`);
    if (!/\bFOR\s+EACH\s+ROW\s+DISABLE\b/i.test(syntax)) {
      const header = /\bFOR\s+EACH\s+ROW\b/i.exec(syntax)!;
      const insertion = header.index + header[0].length;
      create = `${create.slice(0, insertion)} DISABLE${create.slice(insertion)}`;
    }
  } else if (status !== "ENABLED") {
    throw new Error(`Trigger ${name} has an unknown enabled state.`);
  }
  return create;
}

function sourceIdentifier(value: string) {
  return value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toUpperCase();
}

function tableDefinitionFingerprint(source: string, schema: string, name: string) {
  const syntax = maskTriggerCommentsAndStrings(source);
  const identifierToken = '("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*)';
  const declaration = new RegExp(`^(\\s*CREATE\\s+(?:(?:GLOBAL|PRIVATE)\\s+TEMPORARY\\s+)?TABLE\\s+)${identifierToken}(?:\\s*\\.\\s*${identifierToken})?`, "i").exec(syntax);
  if (!declaration) throw new Error(`Table source for ${name} has no verifiable CREATE declaration.`);
  const qualified = declaration[3] !== undefined;
  const declaredOwner = qualified ? sourceIdentifier(declaration[2]!) : schema;
  const declaredName = sourceIdentifier(qualified ? declaration[3]! : declaration[2]!);
  if (declaredOwner !== schema || declaredName !== name) throw new Error(`Table source declares ${declaredOwner}.${declaredName}, not ${schema}.${name}.`);
  return source.slice(0, declaration.index) + `${declaration[1]}<TABLE>` + source.slice(declaration.index + declaration[0].length);
}

function tableSnapshotsMatch(expected: OracleTableSnapshot, actual: OracleTableSnapshot, schema: string, expectedName: string, actualName: string) {
  return (
    tableDefinitionFingerprint(expected.source, schema, expectedName) === tableDefinitionFingerprint(actual.source, schema, actualName) &&
    expected.grants === actual.grants &&
    expected.indexes === actual.indexes &&
    expected.indexColumns === actual.indexColumns &&
    expected.constraints === actual.constraints &&
    expected.constraintColumns === actual.constraintColumns &&
    expected.incomingForeignKeys === actual.incomingForeignKeys &&
    expected.boundTriggers === actual.boundTriggers
  );
}

function validateDependentDeclaration(source: string, schema: string, name: string, objectType: RewriteableDependentType) {
  const syntax = maskTriggerCommentsAndStrings(source);
  const identifierToken = '("(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*)';
  const declaration = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:FORCE|NOFORCE)\\s+)?(?:(?:NON)?EDITIONABLE\\s+)?${objectType}\\s+${identifierToken}(?:\\s*\\.\\s*${identifierToken})?`, "i").exec(syntax);
  if (!declaration) throw new Error(`${objectType} source has no verifiable CREATE declaration.`);
  const qualified = declaration[2] !== undefined;
  const declaredOwner = qualified ? sourceIdentifier(declaration[1]!) : schema;
  const declaredName = sourceIdentifier(qualified ? declaration[2]! : declaration[1]!);
  if (declaredOwner !== schema || declaredName !== name) throw new Error(`${objectType} source declares ${declaredOwner}.${declaredName}, not ${schema}.${name}.`);
  if ((syntax.match(/\bCREATE\b/gi) || []).length !== 1 || !/\bEND(?:\s+(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*))?\s*;\s*\/?\s*$/i.test(syntax)) {
    throw new Error(`${objectType} source must contain one complete CREATE statement for ${name}.`);
  }
  const bodyStart = objectType === "TRIGGER" ? /\bDECLARE\b|\bBEGIN\b/i.exec(syntax) : /\bAS\b|\bIS\b/i.exec(syntax);
  const firstBegin = bodyStart && objectType === "TRIGGER" && /^BEGIN$/i.test(bodyStart[0]) ? bodyStart : bodyStart ? /\bBEGIN\b/i.exec(syntax.slice(bodyStart.index + bodyStart[0].length)) : null;
  if (!bodyStart || !firstBegin) throw new Error(`${objectType} source has no verifiable PL/SQL body for ${name}.`);
  const tokens = [...syntax.matchAll(/\bBEGIN\b|\bEND\b(?:\s+(?:IF|LOOP|CASE)\b)?|[^\s;]+|;/gi)];
  let depth = 0;
  let bodyClosed = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]![0];
    if (/^BEGIN$/i.test(token)) {
      if (bodyClosed) throw new Error(`${objectType} source contains statements after its CREATE body.`);
      depth++;
    } else if (/^END(?:\s+(?:IF|LOOP|CASE))?$/i.test(token) && !/\s+(?:IF|LOOP|CASE)$/i.test(token)) {
      depth--;
      if (depth < 0) throw new Error(`${objectType} source has an invalid PL/SQL block boundary.`);
      if (depth === 0) {
        bodyClosed = true;
        const tail = tokens
          .slice(index + 1)
          .map((entry) => entry[0])
          .filter((entry) => entry !== ";" && entry !== "/");
        if (tail.length > 1 || (tail.length === 1 && !/^(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*)$/.test(tail[0]!))) {
          throw new Error(`${objectType} source contains statements after its CREATE body.`);
        }
        if (tail.length === 1 && index + 2 < tokens.length && tokens[index + 2]![0] !== ";") {
          throw new Error(`${objectType} source contains statements after its CREATE body.`);
        }
      }
    }
  }
  if (!bodyClosed || depth !== 0) throw new Error(`${objectType} source has an incomplete PL/SQL body.`);
}

function tableRelations(source: string) {
  const syntax = maskTriggerCommentsAndStrings(source);
  const relations = new Set<string>();
  const identifierToken = '((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*)(?:\\s*\\.\\s*(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*))?)';
  const canonical = (reference: string) =>
    reference
      .match(/"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*/g)!
      .map((part) => (part.startsWith('"') ? `Q:${part.slice(1, -1).replaceAll('""', '"')}` : `U:${part.toUpperCase()}`))
      .join(".");
  const pattern = new RegExp(`\\b(?:FROM|JOIN|UPDATE|ON)\\s+${identifierToken}`, "gi");
  for (const match of syntax.matchAll(pattern)) relations.add(canonical(match[1]!));
  const dml = new RegExp(`\\b(?:INSERT|MERGE)\\s+INTO\\s+${identifierToken}`, "gi");
  for (const match of syntax.matchAll(dml)) relations.add(canonical(match[1]!));
  const typeReference = new RegExp(`${identifierToken}\\s*%\\s*(?:TYPE|ROWTYPE)`, "gi");
  for (const match of syntax.matchAll(typeReference)) relations.add(canonical(match[1]!));
  return relations;
}

function validateDraftRelations(original: string, draft: string, schema: string, oldName: string, newName: string) {
  const rootSegments = new Set([`U:${oldName.toUpperCase()}`, `U:${newName.toUpperCase()}`, `Q:${oldName}`, `Q:${newName}`]);
  const ownerSegments = new Set([`U:${schema.toUpperCase()}`, `Q:${schema}`]);
  const normalize = (name: string) => {
    const parts = name.split(".");
    const hasAllowedOwner = parts.length === 1 || (parts.length === 2 && ownerSegments.has(parts[0]!));
    return hasAllowedOwner && rootSegments.has(parts[parts.length - 1]!) ? "ROOT_TABLE" : name;
  };
  const expected = new Set([...tableRelations(original)].map(normalize));
  const actual = new Set([...tableRelations(draft)].map(normalize));
  const unexpected = [...actual].filter((name) => !expected.has(name) && name !== "ROOT_TABLE");
  const removed = [...expected].filter((name) => !actual.has(name) && name !== "ROOT_TABLE");
  const calls = (source: string) => {
    const syntax = maskTriggerCommentsAndStrings(source);
    const ignored = new Set([
      "IF",
      "IN",
      "EXISTS",
      "VALUES",
      "CAST",
      "TABLE",
      "SELECT",
      "FROM",
      "AS",
      "CASE",
      "WHEN",
      "OVER",
      "PARTITION",
      "WITH",
      "PRIOR",
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "NVL",
      "NVL2",
      "COALESCE",
      "DECODE",
      "TO_CHAR",
      "TO_DATE",
      "TO_NUMBER",
      "SUBSTR",
      "TRIM",
      "UPPER",
      "LOWER",
      "ROUND",
      "ABS",
      "LENGTH",
      "INSTR",
      "EXTRACT",
      "JSON_VALUE",
      "JSON_QUERY",
      "LISTAGG",
      "ROW_NUMBER",
      "RANK",
      "DENSE_RANK",
    ]);
    const identifier = '(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*)';
    const canonical = (reference: string) =>
      reference
        .match(/"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$#]*/g)!
        .map((part) => (part.startsWith('"') ? `Q:${part.slice(1, -1).replaceAll('""', '"')}` : `U:${part.toUpperCase()}`))
        .join(".");
    const found = new Set([...syntax.matchAll(new RegExp(`${identifier}(?:\\s*\\.\\s*${identifier})*\\s*\\(`, "g"))].map((match) => canonical(match[0]!.replace(/\s*\($/, ""))));
    const noArgStatement = new Set(
      [...syntax.matchAll(new RegExp(`(?:\\bBEGIN\\b|\\bTHEN\\b|\\bELSE\\b|\\bLOOP\\b|(;))\\s*(${identifier}(?:\\s*\\.\\s*${identifier})*)\\s*(?=;)`, "gi"))]
        .map((match) => canonical(match[2]!))
        .filter((name) => !new Set(["U:END", "U:NULL", "U:RETURN", "U:THEN", "U:ELSE", "U:COMMIT", "U:ROLLBACK"]).has(name)),
    );
    for (const name of noArgStatement) found.add(name);
    return new Set([...found].filter((name) => (!name.includes(".") && name.startsWith("U:") ? !ignored.has(name.slice(2)) : true)));
  };
  const originalCalls = calls(original);
  const draftCalls = calls(draft);
  const changedCalls = [...originalCalls].filter((name) => !draftCalls.has(name)).concat([...draftCalls].filter((name) => !originalCalls.has(name)));
  if (unexpected.length || removed.length || changedCalls.length)
    throw new Error(`The draft changes planned dependencies${unexpected.length ? `; adds ${unexpected.join(", ")}` : ""}${removed.length ? `; removes ${removed.join(", ")}` : ""}${changedCalls.length ? `; changes calls ${changedCalls.join(", ")}` : ""}.`);
}

interface DependentSnapshot extends Omit<OracleTableRenameDependent, "draft" | "rewrittenSource" | "fingerprint" | "originalFingerprint" | "rewriteRequired"> {
  executionSource: string;
}

async function readSnapshot(target: OracleTableRenameTarget, name: string, objectType: DependentType): Promise<DependentSnapshot> {
  const states = await objectStates(target, name, [objectType]);
  if (states.length !== 1 || states[0][0] !== objectType || states[0][1] == null || states[0][2] == null) throw new Error(`${objectType} ${name} is missing or has an ambiguous identity.`);
  const source = await readSource(target, objectType, name);
  const grants = await readGrants(target, name);
  const errors = await readErrors(target, name, objectType);
  const trigger = objectType === "TRIGGER" ? await readTrigger(target, name) : undefined;
  const executionSource = trigger ? executableTriggerSource(source, target.schema, name, trigger.status) : source;
  return {
    name,
    objectType,
    objectId: String(states[0][1]),
    source,
    executionSource,
    status: String(states[0][2]),
    grants,
    errors,
    ...(trigger ? { triggerStatus: trigger.status, triggerTable: trigger.table } : {}),
  };
}

async function readDependents(target: OracleTableRenameTarget, name: string, objectType: ObjectType) {
  const suffix = ` WHERE REFERENCED_OWNER=${literal(target.schema)} AND REFERENCED_NAME=${literal(name)} AND REFERENCED_TYPE=${literal(objectType)}`;
  const columns = "SELECT OWNER, NAME, TYPE, REFERENCED_LINK_NAME FROM ";
  try {
    return (await query(target, `${columns}SYS.DBA_DEPENDENCIES${suffix}`)).rows;
  } catch (error) {
    if (!/ORA-00942|ORA-01031/.test(errorMessage(error))) throw error;
    return (await query(target, `${columns}SYS.ALL_DEPENDENCIES${suffix}`)).rows;
  }
}

function issue(issues: OracleTableRenameIssue[], code: string, message: string, objectName?: string, repairable = false) {
  issues.push({ code, message, objectName, repairable });
}

function objectKey(name: string, type: ObjectType) {
  return `${type}:${name}`;
}

function orderDependents(names: Map<string, { name: string; type: DependentType }>, edges: string[], schema: string) {
  const indegree = new Map([...names.keys()].map((key) => [key, 0]));
  const outgoing = new Map([...names.keys()].map((key) => [key, new Set<string>()]));
  for (const edge of edges) {
    const [referencedName, referencedType, owner, dependentName, dependentType, link] = JSON.parse(edge) as [string, ObjectType, string, string, DependentType, string | null];
    if (owner !== schema || link) continue;
    const from = objectKey(referencedName, referencedType);
    const to = objectKey(dependentName, dependentType);
    if (!indegree.has(to) || !outgoing.has(to)) continue;
    if (indegree.has(from) && from !== to && !outgoing.get(from)!.has(to)) {
      outgoing.get(from)!.add(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
  }
  const compare = (left: string, right: string) => left.localeCompare(right);
  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort(compare);
  const ordered: string[] = [];
  while (ready.length) {
    const key = ready.shift()!;
    ordered.push(key);
    for (const child of outgoing.get(key)!) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  return ordered;
}

function normalizeEdgesForRenamedTable(edges: string[], oldName: string, newName: string) {
  return edges
    .map((edge) => {
      const [referencedName, referencedType, owner, dependentName, dependentType, link] = JSON.parse(edge) as [string, ObjectType, string, string, DependentType, string | null];
      return JSON.stringify([referencedType === "TABLE" && referencedName === oldName ? newName : referencedName, referencedType, owner, dependentName, dependentType, link]);
    })
    .sort();
}

async function canonicalTableSource(objectType: RewriteableDependentType, source: string, tableName: string, schema: string, databaseType: OracleTableRenameTarget["databaseType"]) {
  const marker = "DBX_TABLE_RENAME_FINGERPRINT_MARKER";
  const marked = await api.rewriteOracleTableReferences({ databaseType, objectType, schema, oldName: tableName, newName: marker, source });
  return api.rewriteOracleTableReferences({ databaseType, objectType, schema, oldName: marker, newName: tableName, source: marked });
}

async function sourceAfterEngineRename(objectType: RewriteableDependentType, source: string, oldName: string, newName: string, schema: string, databaseType: OracleTableRenameTarget["databaseType"]) {
  let withNewName = source;
  try {
    withNewName = await api.rewriteOracleTableReferences({ databaseType, objectType, schema, oldName, newName, source });
  } catch {
    // A trigger may already have its ON binding rewritten by RENAME while
    // remaining source references still use the old table name.
  }
  return canonicalTableSource(objectType, withNewName, newName, schema, databaseType);
}

function planIdentity(plan: OracleTableRenamePlan) {
  return JSON.stringify([
    plan.target,
    plan.canonicalNewName,
    plan.tableObjectId,
    plan.tableSnapshot,
    plan.dependencyEdges,
    plan.issues,
    plan.metadataComplete,
    plan.dependents.map((item) => [item.name, item.objectType, item.objectId, item.source, item.status, item.grants, item.errors, item.triggerStatus, item.triggerTable, item.draft, item.fingerprint, item.originalFingerprint, item.rewriteRequired]),
    plan.steps,
  ]);
}

export async function prepareOracleTableRename(target: OracleTableRenameTarget, drafts: Record<string, string> = {}): Promise<OracleTableRenamePlan> {
  target = { ...target };
  const plan: OracleTableRenamePlan = { target, canonicalNewName: target.newName, tableObjectId: "", tableSnapshot: null, dependents: [], dependencyEdges: [], issues: [], metadataComplete: true, executable: false, steps: [], statements: [] };
  try {
    plan.canonicalNewName = await api.parseOracleObjectName(target.newName);
    if (plan.canonicalNewName === target.oldName) issue(plan.issues, "invalid_name", "The new name matches the existing table name.");
    await checkOwner(target);
    const [oldState, newState] = await Promise.all([objectStates(target, target.oldName, ["TABLE"]), objectStates(target, plan.canonicalNewName, tableNamespaceTypes)]);
    if (oldState.length !== 1 || oldState[0][0] !== "TABLE" || oldState[0][1] == null) throw new Error(`Table ${target.oldName} is missing or has an ambiguous identity.`);
    plan.tableObjectId = String(oldState[0][1]);
    plan.tableSnapshot = await readTableSnapshot(target, target.oldName);
    if (newState.length) issue(plan.issues, "target_conflict", `An object named ${plan.canonicalNewName} already exists.`);
  } catch (error) {
    plan.metadataComplete = false;
    issue(plan.issues, /owner|current schema/i.test(errorMessage(error)) ? "owner_mismatch" : "metadata_incomplete", errorMessage(error));
  }

  const objects = new Map<string, { name: string; type: DependentType }>();
  if (plan.tableSnapshot) {
    for (const [triggerName] of JSON.parse(plan.tableSnapshot.boundTriggers) as unknown[][]) {
      const name = String(triggerName);
      const key = objectKey(name, "TRIGGER");
      if (!objects.has(key)) objects.set(key, { name, type: "TRIGGER" });
    }
  }
  const edges: string[] = [];
  const pending: Array<{ name: string; type: ObjectType }> = [{ name: target.oldName, type: "TABLE" }];
  const visited = new Set<string>();
  while (pending.length && plan.metadataComplete) {
    const reference = pending.shift()!;
    const refKey = objectKey(reference.name, reference.type);
    if (visited.has(refKey)) continue;
    if (visited.size >= metadataLimit) {
      plan.metadataComplete = false;
      issue(plan.issues, "dependency_incomplete", "The visible dependency graph exceeds the safe metadata limit.");
      break;
    }
    visited.add(refKey);
    let rows: unknown[][];
    try {
      rows = await readDependents(target, reference.name, reference.type);
    } catch (error) {
      plan.metadataComplete = false;
      issue(plan.issues, "dependency_read_failed", errorMessage(error), reference.name);
      break;
    }
    for (const row of rows) {
      const [owner, dependentName, dependentType, link] = row;
      if (typeof owner !== "string" || typeof dependentName !== "string" || typeof dependentType !== "string") {
        plan.metadataComplete = false;
        issue(plan.issues, "dependency_incomplete", `Dependency metadata for ${reference.name} is incomplete.`, reference.name);
        continue;
      }
      edges.push(JSON.stringify([reference.name, reference.type, owner, dependentName, dependentType, typeof link === "string" ? link : null]));
      if (owner !== target.schema || link || !acceptedTypes.has(dependentType as DependentType)) {
        issue(plan.issues, "unsupported_dependency", `Cannot automatically update dependent ${owner}.${dependentName} (${dependentType}${link ? `@${String(link)}` : ""}).`, dependentName);
        continue;
      }
      const type = dependentType as DependentType;
      const key = objectKey(dependentName, type);
      if (!objects.has(key)) objects.set(key, { name: dependentName, type });
      pending.push({ name: dependentName, type });
    }
  }
  plan.dependencyEdges = edges.sort();
  const order = orderDependents(objects, plan.dependencyEdges, target.schema);
  if (order.length !== objects.size) issue(plan.issues, "dependency_cycle", "The visible dependent graph contains a cycle that cannot be ordered safely.", target.oldName);

  for (const key of order) {
    const object = objects.get(key)!;
    let snapshot: DependentSnapshot;
    try {
      snapshot = await readSnapshot(target, object.name, object.type);
      if (snapshot.status !== "VALID" || snapshot.errors !== "[]") throw new Error(`${object.type} ${object.name} is not valid or has compilation errors.`);
      if (snapshot.objectType === "TRIGGER" && snapshot.triggerTable !== target.oldName) throw new Error(`Trigger ${object.name} is not bound to ${target.oldName}.`);
    } catch (error) {
      plan.metadataComplete = false;
      issue(plan.issues, "source_read_failed", errorMessage(error), object.name);
      continue;
    }
    const draft = drafts[object.name] ?? snapshot.executionSource;
    let rewrittenSource = "";
    let fingerprint = "";
    let originalFingerprint = "";
    const directDependency = plan.dependencyEdges.some((edge) => {
      const [referencedName, referencedType, owner, name, type] = JSON.parse(edge) as [string, ObjectType, string, string, DependentType];
      return referencedName === target.oldName && referencedType === "TABLE" && owner === target.schema && name === object.name && type === object.type;
    });
    try {
      if (object.type === "VIEW") {
        const originalReview = await api.reviewOracleViewRenameSource({ source: snapshot.source, owner: target.schema, viewName: object.name, oldName: target.oldName, newName: target.oldName });
        const review = await api.reviewOracleViewRenameSource({ source: draft, owner: target.schema, viewName: object.name, oldName: target.oldName, newName: directDependency ? plan.canonicalNewName : target.oldName });
        plan.issues.push(...review.issues.map((entry: OracleViewRenameIssue) => ({ code: entry.code, message: entry.message, objectName: object.name, repairable: entry.repairable })));
        const normalizeReferences = (references: typeof review.references) => references.map((reference) => JSON.stringify([reference.owner, reference.name === plan.canonicalNewName ? target.oldName : reference.name])).sort();
        const originalParseFailed = !originalReview.source && originalReview.issues.some((entry: OracleViewRenameIssue) => entry.code === "invalid_definition" || entry.code === "invalid_declaration");
        if (!review.source) throw new Error(review.issues.map((entry: OracleViewRenameIssue) => entry.message).join("; ") || `Cannot validate ${object.name}.`);
        if (originalReview.source) {
          plan.issues.push(...originalReview.issues.map((entry: OracleViewRenameIssue) => ({ code: entry.code, message: entry.message, objectName: object.name, repairable: entry.repairable })));
          if (JSON.stringify(normalizeReferences(originalReview.references)) !== JSON.stringify(normalizeReferences(review.references))) throw new Error(`The definition of ${object.name} changes its planned dependencies.`);
        } else if (originalParseFailed) {
          if (!directDependency && draft !== snapshot.executionSource) throw new Error(`A manual draft for indirect dependent ${object.name} cannot be applied by the planned compile step.`);
          const plannedNames = new Set([target.oldName, ...order.map((plannedKey) => objects.get(plannedKey)!.name)]);
          const expected = [
            ...new Set(
              edges
                .map((edge) => JSON.parse(edge) as [string, ObjectType, string, string, DependentType, string | null])
                .filter(([, , owner, name]) => owner === target.schema && name === object.name)
                .map(([name, , owner]) => JSON.stringify([owner, name])),
            ),
          ].sort();
          const actual = [
            ...new Set(
              review.references
                .filter((reference) => reference.owner === target.schema && plannedNames.has(reference.name === plan.canonicalNewName ? target.oldName : reference.name))
                .map((reference) => JSON.stringify([reference.owner, reference.name === plan.canonicalNewName ? target.oldName : reference.name])),
            ),
          ].sort();
          if (JSON.stringify(expected) !== JSON.stringify(actual)) issue(plan.issues, "manual_graph", `The proposed definition changes planned dependencies of ${object.name}.`, object.name, true);
        } else {
          plan.issues.push(...originalReview.issues.map((entry: OracleViewRenameIssue) => ({ code: entry.code, message: entry.message, objectName: object.name, repairable: entry.repairable })));
          throw new Error([...originalReview.issues, ...review.issues].map((entry: OracleViewRenameIssue) => entry.message).join("; ") || `Cannot validate ${object.name}.`);
        }
        const bindsOldTable = review.references.some((reference) => reference.owner === target.schema && reference.name === target.oldName);
        if (directDependency !== bindsOldTable) throw new Error(`The definition of ${object.name} does not match its direct table dependency.`);
        rewrittenSource = review.source.source;
        const rewrittenReview = await api.reviewOracleViewRenameSource({ source: rewrittenSource, owner: target.schema, viewName: object.name, oldName: plan.canonicalNewName, newName: plan.canonicalNewName });
        if (!rewrittenReview.source || rewrittenReview.issues.length || JSON.stringify(normalizeReferences(rewrittenReview.references)) !== JSON.stringify(normalizeReferences(review.references))) {
          throw new Error(`The rewritten definition of ${object.name} does not preserve its planned references.`);
        }
        fingerprint = review.source.fingerprint;
        originalFingerprint = originalReview.source?.fingerprint ?? "";
      } else {
        if (directDependency) {
          validateDependentDeclaration(draft, target.schema, object.name, object.type);
          validateDraftRelations(snapshot.executionSource, draft, target.schema, target.oldName, plan.canonicalNewName);
          rewrittenSource = await api.rewriteOracleTableReferences({ databaseType: target.databaseType, objectType: object.type, schema: target.schema, oldName: target.oldName, newName: plan.canonicalNewName, source: draft });
          fingerprint = await canonicalTableSource(object.type, rewrittenSource, plan.canonicalNewName, target.schema, target.databaseType);
        } else {
          rewrittenSource = draft;
          fingerprint = draft;
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      const location = /line (\d+), column (\d+)/i.exec(message);
      plan.issues.push({ code: "source_rewrite_failed", message, objectName: object.name, repairable: true, ...(location ? { location: { line: Number(location[1]), column: Number(location[2]) } } : {}) });
    }
    plan.dependents.push({ ...snapshot, draft, rewrittenSource, fingerprint, originalFingerprint, rewriteRequired: directDependency });
  }

  if (plan.metadataComplete && plan.issues.length === 0) {
    plan.steps = [
      { kind: "rename", objectName: target.oldName, objectType: "TABLE", sql: `RENAME ${identifier(target.oldName)} TO ${identifier(plan.canonicalNewName)};` },
      ...plan.dependents.map((dependent) =>
        dependent.rewriteRequired
          ? { kind: "replace" as const, objectName: dependent.name, objectType: dependent.objectType, sql: dependent.rewrittenSource }
          : { kind: "compile" as const, objectName: dependent.name, objectType: dependent.objectType, sql: `ALTER ${dependent.objectType} ${identifier(target.schema)}.${identifier(dependent.name)} COMPILE;` },
      ),
    ];
    plan.statements = plan.steps.map((step) => step.sql);
    plan.executable = true;
  }
  return plan;
}

async function readTableIdentity(target: OracleTableRenameTarget, name: string) {
  const rows = await objectStates(target, name, ["TABLE"]);
  return rows.length === 1 && rows[0][0] === "TABLE" && rows[0][1] != null ? String(rows[0][1]) : null;
}

async function nameIsOccupied(target: OracleTableRenameTarget, name: string) {
  return (await objectStates(target, name, tableNamespaceTypes)).length > 0;
}

async function verifyGraph(target: OracleTableRenameTarget, plan: OracleTableRenamePlan) {
  const references: Array<{ name: string; type: ObjectType }> = [{ name: plan.canonicalNewName, type: "TABLE" }, ...plan.dependents.map((item) => ({ name: item.name, type: item.objectType }))];
  const actual: string[] = [];
  for (const reference of references) {
    for (const [owner, name, type, link] of await readDependents(target, reference.name, reference.type)) {
      actual.push(JSON.stringify([reference.name, reference.type, owner, name, type, typeof link === "string" ? link : null]));
    }
  }
  const expected = normalizeEdgesForRenamedTable(plan.dependencyEdges, plan.target.oldName, plan.canonicalNewName);
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error("The visible dependency graph changed during table rename.");
}

async function verifyOriginalGraph(target: OracleTableRenameTarget, plan: OracleTableRenamePlan) {
  const references: Array<{ name: string; type: ObjectType }> = [{ name: plan.target.oldName, type: "TABLE" }, ...plan.dependents.map((item) => ({ name: item.name, type: item.objectType }))];
  const actual: string[] = [];
  for (const reference of references) {
    for (const [owner, name, type, link] of await readDependents(target, reference.name, reference.type)) {
      actual.push(JSON.stringify([reference.name, reference.type, owner, name, type, typeof link === "string" ? link : null]));
    }
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...plan.dependencyEdges].sort())) throw new Error("The visible dependency graph changed before table rename.");
}

async function verifyOriginalSnapshots(target: OracleTableRenameTarget, plan: OracleTableRenamePlan) {
  if (!plan.tableSnapshot || !tableSnapshotsMatch(plan.tableSnapshot, await readTableSnapshot(target, plan.target.oldName), target.schema, plan.target.oldName, plan.target.oldName)) {
    throw new Error("The original table definition, grants, indexes, constraints, foreign keys, or triggers changed before rename.");
  }
  for (const dependent of plan.dependents) {
    const actual = await readSnapshot(target, dependent.name, dependent.objectType);
    if (
      actual.objectId !== dependent.objectId ||
      actual.source !== dependent.source ||
      actual.status !== dependent.status ||
      actual.grants !== dependent.grants ||
      actual.errors !== dependent.errors ||
      actual.triggerStatus !== dependent.triggerStatus ||
      actual.triggerTable !== dependent.triggerTable
    ) {
      throw new Error(`${dependent.objectType} ${dependent.name} changed before table rename.`);
    }
  }
}

async function verifyFinalSnapshots(target: OracleTableRenameTarget, plan: OracleTableRenamePlan) {
  if (!plan.tableSnapshot || !tableSnapshotsMatch(plan.tableSnapshot, await readTableSnapshot(target, plan.canonicalNewName), target.schema, plan.target.oldName, plan.canonicalNewName)) {
    throw new Error("The renamed table definition, grants, indexes, constraints, foreign keys, or triggers changed before final verification.");
  }
  if ((await readTableIdentity(target, plan.canonicalNewName)) !== plan.tableObjectId || (await readTableIdentity(target, plan.target.oldName)) !== null) {
    throw new Error("The renamed table identity changed before final verification.");
  }
  if (await nameIsOccupied(target, plan.target.oldName)) throw new Error("The old table name was reused before final verification.");
  for (const dependent of plan.dependents) {
    const actual = await readSnapshot(target, dependent.name, dependent.objectType);
    if (actual.objectId !== dependent.objectId || actual.status !== "VALID" || actual.errors !== "[]" || actual.grants !== dependent.grants) {
      throw new Error(`${dependent.objectType} ${dependent.name} changed before final verification.`);
    }
    if (dependent.objectType === "TRIGGER" && (actual.triggerTable !== plan.canonicalNewName || actual.triggerStatus !== dependent.triggerStatus)) {
      throw new Error(`Trigger ${dependent.name} binding or enabled state changed before final verification.`);
    }
    const fingerprint =
      dependent.objectType === "VIEW"
        ? (
            await api.reviewOracleViewRenameSource({
              source: actual.source,
              owner: target.schema,
              viewName: dependent.name,
              oldName: dependent.rewriteRequired ? plan.canonicalNewName : plan.target.oldName,
              newName: dependent.rewriteRequired ? plan.canonicalNewName : plan.target.oldName,
            })
          ).source?.fingerprint
        : dependent.rewriteRequired
          ? await canonicalTableSource(dependent.objectType, actual.executionSource, plan.canonicalNewName, target.schema, target.databaseType)
          : actual.source;
    if (fingerprint !== dependent.fingerprint) throw new Error(`${dependent.objectType} ${dependent.name} definition changed before final verification.`);
  }
  await verifyGraph(target, plan);
}

async function readOnlyReconcile(target: OracleTableRenameTarget, plan: OracleTableRenamePlan, step: OracleTableRenameStep) {
  try {
    if (step.kind === "rename") {
      const newId = await readTableIdentity(target, plan.canonicalNewName);
      const oldId = await readTableIdentity(target, plan.target.oldName);
      if (newId === plan.tableObjectId && oldId === null) return "confirmed" as const;
      if (newId === null && oldId === plan.tableObjectId) return "not-confirmed" as const;
      return "unknown" as const;
    }
    const dependent = plan.dependents.find((item) => item.name === step.objectName && item.objectType === step.objectType)!;
    const actual = await readSnapshot(target, dependent.name, dependent.objectType);
    if (step.kind === "compile") {
      return actual.objectId === dependent.objectId && actual.source === dependent.source && actual.status === "VALID" && actual.errors === "[]" && actual.grants === dependent.grants ? ("confirmed" as const) : ("unknown" as const);
    }
    if (
      actual.status === "VALID" &&
      actual.errors === "[]" &&
      actual.grants === dependent.grants &&
      (dependent.objectType !== "TRIGGER" || (actual.triggerTable === plan.canonicalNewName && actual.triggerStatus === dependent.triggerStatus)) &&
      (dependent.objectType === "VIEW"
        ? (await api.reviewOracleViewRenameSource({ source: actual.source, owner: plan.target.schema, viewName: dependent.name, oldName: plan.canonicalNewName, newName: plan.canonicalNewName })).source?.fingerprint === dependent.fingerprint
        : (await canonicalTableSource(dependent.objectType, actual.executionSource, plan.canonicalNewName, plan.target.schema, plan.target.databaseType)) === dependent.fingerprint)
    )
      return "confirmed" as const;
    if (actual.objectId === dependent.objectId && actual.source === dependent.source) return "not-confirmed" as const;
    return "unknown" as const;
  } catch {
    return "unknown" as const;
  }
}

export async function executeOracleTableRename(plan: OracleTableRenamePlan, drafts: Record<string, string> = {}, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent()) throw new Error("The table rename target changed. Refresh the preview.");
  if (!plan.executable) throw new Error("Resolve every table dependency issue before execution.");
  const current = await prepareOracleTableRename(plan.target, drafts);
  if (!current.executable || planIdentity(current) !== planIdentity(plan) || !isCurrent()) throw new Error("Table metadata changed. Refresh the rename preview.");
  const frozen = freezeSourceIdentities([
    { connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema, objectType: "TABLE" as const, name: plan.target.oldName },
    ...plan.dependents.map((item) => ({ connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema, objectType: item.objectType, name: item.name })),
  ]);
  const completed: string[] = [];
  let dispatched = false;
  let active = plan.steps[0];
  try {
    for (const step of plan.steps) {
      active = step;
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      const expectedTableId = await readTableIdentity(plan.target, step.kind === "rename" ? plan.target.oldName : plan.canonicalNewName);
      if (expectedTableId !== plan.tableObjectId) throw new Error("The original table identity changed during rename.");
      if (step.kind === "rename") {
        if (await nameIsOccupied(plan.target, plan.canonicalNewName)) throw new Error("The target table name was claimed by another session.");
        await verifyOriginalSnapshots(plan.target, plan);
        await verifyOriginalGraph(plan.target, plan);
      } else {
        if (await nameIsOccupied(plan.target, plan.target.oldName)) throw new Error("The old table name was reused by another object.");
        await verifyGraph(plan.target, plan);
        const dependent = plan.dependents.find((item) => item.name === step.objectName && item.objectType === step.objectType)!;
        const latest = await readSnapshot(plan.target, dependent.name, dependent.objectType);
        const expectedStatus = dependent.objectType === "VIEW" ? "INVALID" : dependent.status;
        if (latest.objectId !== dependent.objectId || latest.grants !== dependent.grants || (step.kind === "replace" && latest.status !== expectedStatus) || (step.kind === "compile" && (!["VALID", "INVALID"].includes(latest.status) || latest.source !== dependent.source)))
          throw new Error(`${dependent.objectType} ${dependent.name} changed after validation.`);
        if (dependent.objectType === "TRIGGER") {
          if (latest.triggerTable !== plan.canonicalNewName || latest.triggerStatus !== dependent.triggerStatus) throw new Error(`Trigger ${dependent.name} binding or enabled state changed after table rename.`);
        }
        const expectedFingerprint = dependent.objectType === "VIEW" ? dependent.originalFingerprint : dependent.fingerprint;
        if (step.kind === "replace" && dependent.objectType === "VIEW" && !expectedFingerprint && latest.source !== dependent.source) throw new Error(`${dependent.objectType} ${dependent.name} source changed after validation.`);
        if (step.kind === "compile") {
          if (latest.source !== dependent.source) throw new Error(`${dependent.objectType} ${dependent.name} source changed after validation.`);
        } else if (dependent.objectType !== "TRIGGER" && latest.source === dependent.source) {
          // RENAME does not rewrite stored routine source. Preserve the exact
          // original snapshot check when its unsupported syntax prevented a
          // canonical reference fingerprint; the validated draft is still
          // the only source sent by the following replace step.
        } else {
          const latestFingerprint =
            dependent.objectType === "VIEW"
              ? ((await api.reviewOracleViewRenameSource({ source: latest.source, owner: plan.target.schema, viewName: dependent.name, oldName: plan.target.oldName, newName: plan.target.oldName })).source?.fingerprint ?? "")
              : await sourceAfterEngineRename(dependent.objectType, latest.executionSource, plan.target.oldName, plan.canonicalNewName, plan.target.schema, plan.target.databaseType);
          if (latestFingerprint !== expectedFingerprint) throw new Error(`${dependent.objectType} ${dependent.name} source changed after validation.`);
        }
      }
      if (!isCurrent()) throw new Error("The rename dialog changed or closed; remaining steps were not sent.");
      if (!dispatched) {
        frozen.markDispatched();
        dispatched = true;
      }
      try {
        await query(plan.target, step.sql);
      } catch (error) {
        const reconciliation = await readOnlyReconcile(plan.target, plan, step);
        throw new OracleTableRenameFailure(plan, completed, `${step.objectType} ${step.objectName}`, reconciliation, error);
      }

      if (step.kind === "rename") {
        const newId = await readTableIdentity(plan.target, plan.canonicalNewName);
        const oldId = await readTableIdentity(plan.target, plan.target.oldName);
        if (newId !== plan.tableObjectId || oldId !== null) throw new Error("The table rename did not preserve the original identity at the new name.");
        await verifyGraph(plan.target, plan);
        completed.push(`TABLE ${plan.canonicalNewName}`);
        continue;
      }

      const dependent = plan.dependents.find((item) => item.name === step.objectName && item.objectType === step.objectType)!;
      const actual = await readSnapshot(plan.target, dependent.name, dependent.objectType);
      if (actual.status !== "VALID" || actual.errors !== "[]" || actual.grants !== dependent.grants) throw new Error(`${dependent.objectType} ${dependent.name} did not preserve validity, errors, and grants.`);
      if (dependent.objectType === "TRIGGER" && (actual.triggerTable !== plan.canonicalNewName || actual.triggerStatus !== dependent.triggerStatus)) throw new Error(`Trigger ${dependent.name} did not preserve table binding and enabled state.`);
      if (step.kind === "compile") {
        if (actual.objectId !== dependent.objectId || actual.source !== dependent.source) throw new Error(`${dependent.objectType} ${dependent.name} did not retain its validated identity and definition after compilation.`);
        await verifyGraph(plan.target, plan);
        completed.push(`${dependent.objectType} ${dependent.name}`);
        continue;
      }
      const actualFingerprint =
        dependent.objectType === "VIEW"
          ? (await api.reviewOracleViewRenameSource({ source: actual.source, owner: plan.target.schema, viewName: dependent.name, oldName: plan.canonicalNewName, newName: plan.canonicalNewName })).source?.fingerprint
          : await canonicalTableSource(dependent.objectType, actual.executionSource, plan.canonicalNewName, plan.target.schema, plan.target.databaseType);
      if (actualFingerprint !== dependent.fingerprint) throw new Error(`${dependent.objectType} ${dependent.name} does not match the approved replacement source.`);
      if (dependent.objectType === "VIEW") dependent.objectId = actual.objectId;
      else if (actual.objectId !== dependent.objectId) throw new Error(`${dependent.objectType} ${dependent.name} identity changed unexpectedly.`);
      await verifyGraph(plan.target, plan);
      completed.push(`${dependent.objectType} ${dependent.name}`);
    }
    await verifyFinalSnapshots(plan.target, plan);
  } catch (error) {
    if (error instanceof OracleTableRenameFailure) throw error;
    if (dispatched) {
      const reconciliation = await readOnlyReconcile(plan.target, plan, active);
      throw new OracleTableRenameFailure(plan, completed, `${active.objectType} ${active.objectName}`, reconciliation, error);
    }
    throw error;
  } finally {
    if (dispatched) {
      const scope = { connectionId: plan.target.connectionId, database: plan.target.database, schema: plan.target.schema };
      invalidateObjectBrowserRowsCache(scope);
      await Promise.allSettled([...new Set([plan.target.oldName, plan.canonicalNewName, ...plan.dependents.map((item) => item.name)])].map((tableName) => invalidateObjectDdlCache({ ...scope, tableName })));
      frozen.finish();
    } else frozen.cancel();
  }
}
