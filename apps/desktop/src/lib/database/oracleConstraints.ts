import * as api from "@/lib/backend/api";
import type { ConstraintInfo, OracleConstraintMetadata } from "@/types/database";
import type { BuildTableStructureChangeSqlOptions, OracleCheckConstraint, OracleConstraintChange, OracleConstraintDefinition, OracleUniqueConstraint, OracleForeignKeyState } from "@/lib/table/tableStructureEditorSql";
import { generateUniqueIndexName } from "@/lib/table/tableStructureEditorState";

export interface OracleConstraintTarget {
  connectionId: string;
  database: string;
  schema: string;
  tableName: string;
  catalog?: string;
  databaseType: "oracle" | "oceanbase-oracle";
}

export interface OracleConstraintSnapshot {
  user: string;
  currentSchema: string;
  database: string;
  databaseName: string;
  objectId: string;
  columns: Array<{ name: string; dataType: string; length: string | null; precision: string | null; scale: string | null; nullable: boolean; charUsed?: string | null; charLength?: string | null; userGenerated?: string | null; hiddenColumn?: string | null }>;
  indexColumnReadMode?: "enhanced" | "strict-base";
  constraints: OracleConstraintDefinition[];
  names: Array<{ name: string; table: string }>;
  indexNames: string[];
  indexes: Array<{
    owner: string;
    name: string;
    tableOwner: string;
    tableName: string;
    indexType: string;
    uniqueness: string;
    status: string;
    partitioned: boolean;
    visibility: string;
    secondary: string | null;
    columns: string[];
    directions: string[];
    keyIsExpression: boolean[];
    includedColumns: string[];
    constraints: Array<{ owner: string; tableName: string; name: string }>;
  }>;
  references: Array<{ owner: string; table: string; name: string; status: string; validated: string }>;
}

export interface OracleConstraintPlan {
  target: OracleConstraintTarget;
  options: BuildTableStructureChangeSqlOptions;
  change: OracleConstraintChange;
  snapshot: OracleConstraintSnapshot;
  snapshotFingerprint: string;
  statements: string[];
  notices: string[];
}

export interface OracleConstraintExecutionResult {
  steps: Array<{ sql: string; state: "committed" | "rejected" | "unknown" | "notExecuted"; error?: string }>;
  readbackError?: string;
  recoverySql?: string;
}

export interface OracleIndexSnapshot {
  user: string;
  currentSchema: string;
  database: string;
  databaseName: string;
  objectId: string;
  columns: OracleConstraintSnapshot["columns"];
  userColumns: OracleConstraintSnapshot["columns"];
  columnReadMode: "enhanced" | "strict-base";
  indexes: OracleConstraintSnapshot["indexes"];
  indexNames: string[];
}

export class OracleConstraintMetadataError extends Error {
  constructor(readonly reason: "incomplete" | "changed" | "invalidData" | "unreadableData") {
    super(reason === "invalidData" ? "Existing rows violate the target constraint." : reason === "unreadableData" ? "Existing rows could not be verified before rebuilding the constraint." : "Constraint metadata is incomplete, unsupported, or changed. Refresh the table definition.");
  }
}

function invalid(reason: OracleConstraintMetadataError["reason"] = "incomplete"): never {
  throw new OracleConstraintMetadataError(reason);
}

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const ident = (value: string) => `"${value.replace(/"/g, '""')}"`;

async function query(target: OracleConstraintTarget, sql: string, stillCurrent: () => boolean = () => true): Promise<unknown[][]> {
  if (!stillCurrent()) invalid("changed");
  const result = await api.executeQuery(target.connectionId, target.database, sql, target.schema, undefined, { catalog: target.catalog, maxRows: 10001 });
  if (!stillCurrent()) invalid("changed");
  if (result.execution_error || result.truncated || result.has_more || result.rows.length >= 10001) invalid();
  return result.rows;
}

function stateFromMetadata(metadata: OracleConstraintMetadata): OracleForeignKeyState {
  const { status, validated, deferrable, deferred, rely } = metadata;
  if (
    !status ||
    !["ENABLED", "DISABLED"].includes(status) ||
    !validated ||
    !["VALIDATED", "NOT VALIDATED"].includes(validated) ||
    !deferrable ||
    !["DEFERRABLE", "NOT DEFERRABLE"].includes(deferrable) ||
    !deferred ||
    !["DEFERRED", "IMMEDIATE"].includes(deferred) ||
    (rely !== null && !["RELY", "NORELY"].includes(rely))
  )
    invalid();
  const result = { enabled: status === "ENABLED", validated: validated === "VALIDATED", deferrable: deferrable === "DEFERRABLE", initiallyDeferred: deferred === "DEFERRED", rely: rely === "RELY" };
  if (result.initiallyDeferred && !result.deferrable) invalid();
  return result;
}

export function oracleConstraintDefinitionFromInfo(info: ConstraintInfo, target?: OracleConstraintTarget): OracleConstraintDefinition {
  const metadata = info.oracle_metadata;
  if (!metadata?.metadataComplete || metadata.owner === "" || !metadata.constraintType) invalid();
  if (target && metadata.owner !== target.schema) invalid("changed");
  const state = stateFromMetadata(metadata);
  if (metadata.constraintType === "C" && info.constraint_type === "CHECK" && info.definition.trim()) {
    const definition: OracleCheckConstraint = { name: info.name, expression: info.definition, state };
    return { kind: "check", definition };
  }
  if (metadata.constraintType === "U" && info.constraint_type === "UNIQUE" && info.columns.length) {
    const index = metadata.index;
    if (!metadata.indexName && !metadata.indexOwner && !metadata.indexSharing && !index) {
      if (state.enabled || (target && info.oracle_metadata?.metadataComplete !== true)) invalid();
      return {
        kind: "unique",
        definition: {
          name: info.name,
          columns: [...info.columns],
          state,
          relyRaw: metadata.rely ?? "NULL",
          index: {
            owner: target?.schema ?? metadata.owner,
            name: "",
            tableOwner: target?.schema ?? metadata.owner,
            tableName: target?.tableName ?? "",
            sharing: "exclusive",
            metadataComplete: true,
            indexType: "NORMAL",
            uniqueness: "NONUNIQUE",
            status: "VALID",
            partitioned: false,
            visibility: "VISIBLE",
            secondary: null,
            columns: [...info.columns],
            directions: info.columns.map(() => "ASC"),
            keyIsExpression: info.columns.map(() => false),
            includedColumns: [],
            newNameAvailable: false,
          },
        },
      };
    }
    if (!metadata.indexName || !metadata.indexOwner || !metadata.indexSharing || !index) invalid();
    if (!index.metadataComplete || index.owner !== metadata.indexOwner || index.tableOwner !== metadata.owner || (target && (index.tableOwner !== target.schema || index.tableName !== target.tableName))) invalid();
    const definition: OracleUniqueConstraint = {
      name: info.name,
      columns: [...info.columns],
      state,
      relyRaw: metadata.rely ?? "NULL",
      index: {
        owner: index.owner,
        name: metadata.indexName,
        tableOwner: index.tableOwner,
        tableName: index.tableName,
        sharing: metadata.indexSharing,
        metadataComplete: index.metadataComplete,
        indexType: index.indexType,
        uniqueness: index.uniqueness,
        status: index.status,
        partitioned: index.partitioned,
        visibility: index.visibility,
        secondary: index.secondary,
        columns: [...index.columns],
        directions: [...index.directions],
        keyIsExpression: [...index.keyIsExpression],
        includedColumns: [...index.includedColumns],
        newNameAvailable: false,
      },
    };
    return { kind: "unique", definition };
  }
  invalid();
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value);
}

function expressionTokens(expression: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < expression.length;) {
    const ch = expression[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (expression.startsWith("--", i)) {
      const newline = expression.indexOf("\n", i + 2);
      i = newline < 0 ? expression.length : newline + 1;
      continue;
    }
    if (expression.startsWith("/*", i)) {
      const end = expression.indexOf("*/", i + 2);
      if (end < 0) return [];
      i = end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let value = ch;
      i++;
      let closed = false;
      while (i < expression.length) {
        value += expression[i]!;
        if (expression[i] === quote) {
          if (expression[i + 1] === quote) {
            value += expression[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) return [];
      tokens.push(value);
      continue;
    }
    if (/[A-Za-z0-9_$#]/.test(ch)) {
      let word = ch;
      i++;
      while (i < expression.length && /[A-Za-z0-9_$#]/.test(expression[i]!)) word += expression[i++]!;
      tokens.push(word.toUpperCase());
      continue;
    }
    const pair = expression.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "||", ":=", "**"].includes(pair)) {
      tokens.push(pair);
      i += 2;
      continue;
    }
    tokens.push(ch);
    i++;
  }
  return tokens;
}

/** Reads the table/session/constraint/index/reference state required before a CHECK/UNIQUE write. */
export async function readOracleIndexSnapshot(target: OracleConstraintTarget, stillCurrent: () => boolean = () => true, ownerNames: string[] = []): Promise<OracleIndexSnapshot> {
  const snapshot = await readOracleConstraintSnapshot(target, undefined, true, stillCurrent, ownerNames);
  const columns = [...snapshot.columns].sort((left, right) => left.name.localeCompare(right.name));
  const userColumns = snapshot.indexColumnReadMode === "enhanced" ? columns.filter((column) => !(column.userGenerated === "NO" && column.hiddenColumn === "YES")) : columns;
  return {
    user: snapshot.user,
    currentSchema: snapshot.currentSchema,
    database: snapshot.database,
    databaseName: snapshot.databaseName,
    objectId: snapshot.objectId,
    columns,
    userColumns,
    columnReadMode: snapshot.indexColumnReadMode ?? "strict-base",
    indexes: snapshot.indexes.filter((index) => index.tableOwner === target.schema && index.tableName === target.tableName),
    indexNames: snapshot.indexNames,
  };
}

export async function readOracleConstraintSnapshot(target: OracleConstraintTarget, change?: OracleConstraintChange, indexesOnly = false, stillCurrent: () => boolean = () => true, requestedIndexNames: string[] = []): Promise<OracleConstraintSnapshot> {
  if (!stillCurrent()) invalid("changed");
  target = { ...target };
  const oceanbase = target.databaseType === "oceanbase-oracle";
  if (change) change = JSON.parse(JSON.stringify(change)) as OracleConstraintChange;
  const baseColumnsSql = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM SYS.ALL_TAB_COLS WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)} ORDER BY COLUMN_NAME`;
  const enhancedColumnsSql = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE, CHAR_USED, CHAR_LENGTH, USER_GENERATED, HIDDEN_COLUMN FROM SYS.ALL_TAB_COLS WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`;
  let indexColumnReadMode: OracleConstraintSnapshot["indexColumnReadMode"];
  const columnsQuery = indexesOnly
    ? (async () => {
        try {
          const rows = await query(target, enhancedColumnsSql, stillCurrent);
          indexColumnReadMode = "enhanced";
          return rows;
        } catch {
          const rows = await query(target, baseColumnsSql, stillCurrent);
          indexColumnReadMode = "strict-base";
          return rows;
        }
      })()
    : query(target, `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM SYS.ALL_TAB_COLS WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)} ORDER BY COLUMN_ID`, stillCurrent);
  const wantedConstraintNames = [...new Set([change?.original?.definition.name, change?.target?.definition.name].filter((name): name is string => !!name))];
  const wantedIndexNames = [
    ...new Set([...requestedIndexNames, ...(change?.original?.kind === "unique" ? [change.original.definition.index.name] : []), ...(change?.target?.kind === "unique" ? [change.target.definition.index.name, change.target.definition.index.newName || ""] : [])].filter(Boolean)),
  ];
  const inList = (column: string, names: string[]) => (names.length ? ` AND ${column} IN (${names.map(literal).join(", ")})` : " AND 1 = 0");
  const sharedUsageNamesSql = `SELECT c.INDEX_OWNER, c.INDEX_NAME, c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME FROM SYS.ALL_CONSTRAINTS c WHERE c.CONSTRAINT_TYPE IN ('P', 'U') AND c.INDEX_NAME IS NOT NULL AND EXISTS (SELECT 1 FROM SYS.ALL_INDEXES i WHERE i.OWNER = c.INDEX_OWNER AND i.INDEX_NAME = c.INDEX_NAME AND i.TABLE_OWNER = ${literal(target.schema)} AND i.TABLE_NAME = ${literal(target.tableName)}) ORDER BY c.INDEX_OWNER, c.INDEX_NAME, c.OWNER, c.TABLE_NAME, c.CONSTRAINT_NAME`;
  const [identity, objects, tableShapes, externalTables, columns, infos, names, indexNames, indexDetails, indexUsage] = await Promise.all([
    query(target, "SELECT USER, SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','DB_NAME') FROM DUAL", stillCurrent),
    query(target, `SELECT OWNER, OBJECT_NAME, OBJECT_ID FROM SYS.ALL_OBJECTS WHERE OWNER = ${literal(target.schema)} AND OBJECT_NAME = ${literal(target.tableName)} AND OBJECT_TYPE = 'TABLE'`, stillCurrent),
    query(target, `SELECT IOT_TYPE, TEMPORARY${oceanbase ? ", EXTERNAL" : ""} FROM SYS.ALL_TABLES WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`, stillCurrent),
    oceanbase ? Promise.resolve([]) : query(target, `SELECT OWNER, TABLE_NAME FROM SYS.ALL_EXTERNAL_TABLES WHERE OWNER = ${literal(target.schema)} AND TABLE_NAME = ${literal(target.tableName)}`, stillCurrent),
    columnsQuery,
    indexesOnly ? Promise.resolve([]) : api.listConstraints(target.connectionId, target.database, target.schema, target.tableName, target.catalog),
    indexesOnly ? Promise.resolve([]) : query(target, `SELECT CONSTRAINT_NAME, TABLE_NAME FROM SYS.ALL_CONSTRAINTS WHERE OWNER = ${literal(target.schema)}${inList("CONSTRAINT_NAME", wantedConstraintNames)} ORDER BY CONSTRAINT_NAME`, stillCurrent),
    query(target, `SELECT INDEX_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(target.schema)}${inList("INDEX_NAME", wantedIndexNames)} ORDER BY INDEX_NAME`, stillCurrent),
    query(
      target,
      `SELECT i.OWNER, i.INDEX_NAME, i.TABLE_OWNER, i.TABLE_NAME, i.INDEX_TYPE, i.UNIQUENESS, i.STATUS, i.PARTITIONED, i.VISIBILITY, i.SECONDARY, ic.COLUMN_NAME, ic.DESCEND, ie.COLUMN_EXPRESSION FROM SYS.ALL_INDEXES i JOIN SYS.ALL_IND_COLUMNS ic ON ic.INDEX_OWNER = i.OWNER AND ic.INDEX_NAME = i.INDEX_NAME LEFT JOIN SYS.ALL_IND_EXPRESSIONS ie ON ie.INDEX_OWNER = ic.INDEX_OWNER AND ie.INDEX_NAME = ic.INDEX_NAME AND ie.TABLE_OWNER = ic.TABLE_OWNER AND ie.TABLE_NAME = ic.TABLE_NAME AND ie.COLUMN_POSITION = ic.COLUMN_POSITION WHERE i.TABLE_OWNER = ${literal(target.schema)} AND i.TABLE_NAME = ${literal(target.tableName)} ORDER BY i.OWNER, i.INDEX_NAME, ic.COLUMN_POSITION`,
      stillCurrent,
    ),
    query(target, sharedUsageNamesSql, stillCurrent),
  ]);
  if (!stillCurrent()) invalid("changed");
  if (identity.length !== 1 || identity[0]?.length !== 3 || identity[0].some((value) => typeof value !== "string" || !value)) invalid();
  if (objects.length !== 1 || objects[0]?.length !== 3 || objects[0][0] !== target.schema || objects[0][1] !== target.tableName || !/^[1-9]\d*$/.test(String(objects[0][2]))) invalid();
  if (tableShapes.length !== 1 || tableShapes[0]?.length !== (oceanbase ? 3 : 2) || (tableShapes[0][0] !== null && tableShapes[0][0] !== "") || tableShapes[0][1] !== "N" || (oceanbase && tableShapes[0][2] !== "NO")) invalid();
  if (externalTables.length !== 0) invalid();
  if (typeof objects[0][2] === "number" && !Number.isSafeInteger(objects[0][2])) invalid();
  const numeric = (value: unknown): string | null => {
    if (value === null) return null;
    if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+$/.test(String(value))) invalid();
    return String(value);
  };
  if (!columns.length) invalid();
  const seenColumns = new Set<string>();
  const columnDefinitions = columns.map((row) => {
    if (row.length < 6 || (!indexesOnly && row.length !== 6) || (indexColumnReadMode === "enhanced" && row.length > 10) || typeof row[0] !== "string" || !row[0] || seenColumns.has(row[0]) || typeof row[1] !== "string" || !row[1] || !["Y", "N"].includes(String(row[5]))) invalid();
    seenColumns.add(row[0]);
    const base = { name: row[0], dataType: row[1], length: numeric(row[2]), precision: numeric(row[3]), scale: numeric(row[4]), nullable: row[5] === "Y" };
    if (indexColumnReadMode !== "enhanced") return base;
    const optionalText = (index: number): string | null => {
      const value = row[index];
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") invalid();
      return value;
    };
    return { ...base, charUsed: optionalText(6), charLength: numeric(row[7] ?? null), userGenerated: optionalText(8), hiddenColumn: optionalText(9) };
  });
  const editableInfos = indexesOnly ? [] : infos.filter((item) => item.constraint_type === "CHECK" || item.constraint_type === "UNIQUE");
  const definitions = editableInfos.map((info) => oracleConstraintDefinitionFromInfo(info, target)).sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  if (!names.every((row) => row.length === 2 && typeof row[0] === "string" && !!row[0] && typeof row[1] === "string" && !!row[1])) invalid();
  const nameRows = names.map((row) => ({ name: String(row[0]), table: String(row[1]) }));
  if (!indexNames.every((row) => row.length === 1 && typeof row[0] === "string" && !!row[0])) invalid();
  if (
    indexDetails.some(
      (row) => row.length !== 13 || row.slice(0, 9).some((value) => typeof value !== "string" || !value) || (row[9] !== null && typeof row[9] !== "string") || typeof row[10] !== "string" || !row[10] || !["ASC", "DESC"].includes(String(row[11])) || (row[12] !== null && typeof row[12] !== "string"),
    )
  )
    invalid();
  if (indexUsage.some((row) => row.length !== 5 || row.some((value) => typeof value !== "string" || !value))) invalid();
  const references: OracleConstraintSnapshot["references"] = [];
  if (!indexesOnly && change?.original?.kind === "unique") {
    const original = change.original.definition;
    const rows = await query(
      target,
      `SELECT OWNER, TABLE_NAME, CONSTRAINT_NAME, STATUS, VALIDATED FROM SYS.ALL_CONSTRAINTS WHERE R_OWNER = ${literal(target.schema)} AND R_CONSTRAINT_NAME = ${literal(original.name)} AND CONSTRAINT_TYPE = 'R' ORDER BY OWNER, TABLE_NAME, CONSTRAINT_NAME`,
      stillCurrent,
    );
    for (const row of rows) {
      if (row.length !== 5 || row.some((value) => typeof value !== "string" || !value)) invalid();
      references.push({ owner: String(row[0]), table: String(row[1]), name: String(row[2]), status: String(row[3]), validated: String(row[4]) });
    }
  }
  return {
    user: String(identity[0]![0]),
    currentSchema: String(identity[0]![1]),
    database: target.database,
    databaseName: String(identity[0]![2]),
    objectId: String(objects[0]![2]),
    columns: columnDefinitions,
    ...(indexesOnly ? { indexColumnReadMode } : {}),
    constraints: definitions,
    names: nameRows,
    indexNames: indexNames.map((row) => String(row[0])),
    indexes: [...new Set(indexDetails.map((row) => `${String(row[0])}\u0000${String(row[1])}`))].sort().map((identity) => {
      const [owner, name] = identity.split("\u0000");
      const rows = indexDetails.filter((row) => row[0] === owner && row[1] === name);
      const first = rows[0]!;
      return {
        owner: String(first[0]),
        name: String(name),
        tableOwner: String(first[2]),
        tableName: String(first[3]),
        indexType: String(first[4]),
        uniqueness: String(first[5]),
        status: String(first[6]),
        partitioned: String(first[7]) === "YES",
        visibility: String(first[8]),
        secondary: first[9] === null ? null : String(first[9]),
        columns: rows.map((row) => (typeof row[12] === "string" && row[12].trim() ? String(row[12]) : String(row[10]))),
        directions: rows.map((row) => String(row[11])),
        keyIsExpression: rows.map((row) => typeof row[12] === "string" && row[12].trim() !== ""),
        includedColumns: [],
        constraints: indexUsage.filter((use) => use[0] === first[0] && use[1] === name).map((use) => ({ owner: String(use[2]), tableName: String(use[3]), name: String(use[4]) })),
      };
    }),
    references,
  };
}

function validateChange(snapshot: OracleConstraintSnapshot, target: OracleConstraintTarget, change: OracleConstraintChange) {
  if (!change.original && !change.target) invalid();
  if (change.original) {
    const actual = snapshot.constraints.find((item) => item.kind === change.original!.kind && item.definition.name === change.original!.definition.name);
    if (!actual || sortedJson(actual) !== sortedJson(change.original)) invalid("changed");
  }
  if (change.target) {
    const name = change.target.definition.name;
    if (!name.trim() || (change.target.kind === "check" && !change.target.definition.expression.trim())) invalid();
    if (change.target.kind === "unique") {
      const columns = change.target.definition.columns;
      if (!columns.length || new Set(columns).size !== columns.length || columns.some((column) => !snapshot.columns.some((item) => item.name === column))) invalid();
      if (target.databaseType === "oceanbase-oracle" && (change.target.definition.state.deferrable || change.target.definition.state.initiallyDeferred || change.target.definition.state.rely)) invalid();
    }
    if (snapshot.names.some((item) => item.name === name && change.original?.definition.name !== name)) invalid("changed");
  }
}

function sameIdentifierSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((name) => right.includes(name));
}

async function constraintRecoveryCandidate(plan: OracleConstraintPlan, snapshot: OracleConstraintSnapshot, stillCurrent: () => boolean): Promise<string | undefined> {
  const original = plan.change.original;
  if (
    !original ||
    !stillCurrent() ||
    snapshot.objectId !== plan.snapshot.objectId ||
    snapshot.user !== plan.snapshot.user ||
    snapshot.currentSchema !== plan.snapshot.currentSchema ||
    snapshot.databaseName !== plan.snapshot.databaseName ||
    JSON.stringify(snapshot.columns) !== JSON.stringify(plan.snapshot.columns)
  )
    return undefined;
  if (snapshot.constraints.some((item) => item.definition.name === original.definition.name)) return undefined;
  let recovery = JSON.parse(JSON.stringify(original)) as OracleConstraintDefinition;
  let indexPolicy: OracleConstraintChange["indexPolicy"] = "none";
  if (recovery.kind === "unique" && plan.target.databaseType === "oracle") {
    const oldIndex = recovery.definition.index;
    const actualIndex = snapshot.indexes.find((index) => index.owner === oldIndex.owner && index.name === oldIndex.name);
    const completeIndexStillMatches =
      !!oldIndex.name &&
      !!actualIndex &&
      actualIndex.tableOwner === plan.target.schema &&
      actualIndex.tableName === plan.target.tableName &&
      actualIndex.indexType === oldIndex.indexType &&
      actualIndex.uniqueness === oldIndex.uniqueness &&
      actualIndex.status === oldIndex.status &&
      actualIndex.partitioned === oldIndex.partitioned &&
      actualIndex.visibility === oldIndex.visibility &&
      actualIndex.secondary === oldIndex.secondary &&
      (recovery.definition.state.deferrable ? actualIndex.uniqueness === "NONUNIQUE" : ["UNIQUE", "NONUNIQUE"].includes(actualIndex.uniqueness)) &&
      sameIdentifierSet(actualIndex.columns, oldIndex.columns) &&
      actualIndex.directions.join("\0") === oldIndex.directions.join("\0") &&
      actualIndex.keyIsExpression.join("\0") === oldIndex.keyIsExpression.join("\0") &&
      actualIndex.includedColumns.length === oldIndex.includedColumns.length &&
      actualIndex.constraints.length === 0;
    if (completeIndexStillMatches) {
      recovery = { ...recovery, definition: { ...recovery.definition, index: { ...oldIndex } } };
      indexPolicy = "keep";
      recovery = { ...recovery, definition: { ...recovery.definition, index: { ...recovery.definition.index, sharing: "exclusive" } } };
    } else {
      const candidate = await availableUniqueIndexName(plan.target, plan.target.tableName, recovery.definition.columns, [...snapshot.indexNames, ...snapshot.names.map((item) => item.name)], stillCurrent);
      if (!candidate) return undefined;
      recovery = { ...recovery, definition: { ...recovery.definition, index: { ...oldIndex, name: "", newName: candidate, newNameAvailable: true } } };
    }
    if (!recovery.definition.state.enabled) recovery = { ...recovery, definition: { ...recovery.definition, index: { ...recovery.definition.index, name: "", newName: undefined, newNameAvailable: false } } };
  } else if (recovery.kind === "unique") {
    recovery = { ...recovery, definition: { ...recovery.definition, index: { ...recovery.definition.index, name: "", metadataComplete: false } } };
  }
  const recoveryOptions = { ...plan.options, oracleConstraintChanges: [{ original: null, target: recovery, indexPolicy }] };
  const built = await api.buildTableStructureChangeSql(recoveryOptions);
  if (!stillCurrent() || built.warnings.length || built.statements.length !== 1) return undefined;
  return built.statements[0];
}

async function availableUniqueIndexName(target: OracleConstraintTarget, tableName: string, columns: string[], occupied: string[], stillCurrent: () => boolean): Promise<string | undefined> {
  const taken = [...occupied];
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = generateUniqueIndexName(tableName, columns, taken, 30) || generateUniqueIndexName("DBX_UQ", [], taken, 30);
    if (!candidate) return undefined;
    const [indexes, constraints] = await Promise.all([
      query(target, `SELECT INDEX_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(target.schema)} AND INDEX_NAME = ${literal(candidate)}`, stillCurrent),
      query(target, `SELECT CONSTRAINT_NAME FROM SYS.ALL_CONSTRAINTS WHERE OWNER = ${literal(target.schema)} AND CONSTRAINT_NAME = ${literal(candidate)}`, stillCurrent),
    ]);
    if (!indexes.length && !constraints.length) return candidate;
    taken.push(candidate);
  }
  return undefined;
}

async function prepareUniqueTargetIndex(snapshot: OracleConstraintSnapshot, target: OracleConstraintTarget, change: OracleConstraintChange, stillCurrent: () => boolean): Promise<OracleConstraintChange> {
  if (change.target?.kind !== "unique") return change;
  const next = JSON.parse(JSON.stringify(change)) as OracleConstraintChange;
  const targetDefinition = next.target!.definition as OracleUniqueConstraint;
  const original = next.original?.kind === "unique" ? next.original.definition : undefined;
  const oldIndex = original?.index;
  if (target.databaseType === "oceanbase-oracle") {
    targetDefinition.index =
      oldIndex && original
        ? {
            ...oldIndex,
            owner: target.schema,
            name: targetDefinition.name,
            tableOwner: target.schema,
            tableName: target.tableName,
            columns: [...targetDefinition.columns],
            directions: targetDefinition.columns.map(() => "ASC"),
            keyIsExpression: targetDefinition.columns.map(() => false),
            includedColumns: [],
          }
        : {
            owner: target.schema,
            name: "",
            tableOwner: target.schema,
            tableName: target.tableName,
            sharing: "exclusive",
            metadataComplete: false,
            indexType: "NORMAL",
            uniqueness: "UNIQUE",
            status: "VALID",
            partitioned: false,
            visibility: "VISIBLE",
            secondary: null,
            columns: [...targetDefinition.columns],
            directions: targetDefinition.columns.map(() => "ASC"),
            keyIsExpression: targetDefinition.columns.map(() => false),
            includedColumns: [],
            newNameAvailable: false,
          };
    return next;
  }
  if (!targetDefinition.state.enabled) {
    targetDefinition.index = {
      owner: target.schema,
      name: "",
      tableOwner: target.schema,
      tableName: target.tableName,
      sharing: "exclusive",
      metadataComplete: true,
      indexType: "NORMAL",
      uniqueness: "NONUNIQUE",
      status: "VALID",
      partitioned: false,
      visibility: "VISIBLE",
      secondary: "N",
      columns: [...targetDefinition.columns],
      directions: targetDefinition.columns.map(() => "ASC"),
      keyIsExpression: targetDefinition.columns.map(() => false),
      includedColumns: [],
      newNameAvailable: false,
    };
    return next;
  }
  if (
    oldIndex &&
    !!oldIndex.name &&
    oldIndex.metadataComplete &&
    oldIndex.sharing === "exclusive" &&
    sameIdentifierSet(oldIndex.columns, targetDefinition.columns) &&
    change.indexPolicy !== "drop" &&
    (targetDefinition.state.deferrable ? oldIndex.uniqueness === "NONUNIQUE" : ["UNIQUE", "NONUNIQUE"].includes(oldIndex.uniqueness))
  ) {
    targetDefinition.index = { ...oldIndex, columns: [...oldIndex.columns], directions: [...oldIndex.directions], keyIsExpression: [...oldIndex.keyIsExpression], includedColumns: [...oldIndex.includedColumns], newNameAvailable: false };
    return next;
  }
  let candidate: string | undefined;
  if (targetDefinition.index.newName && targetDefinition.index.newNameAvailable) {
    const frozen = targetDefinition.index.newName;
    const [indexes, constraints] = await Promise.all([
      query(target, `SELECT INDEX_NAME FROM SYS.ALL_INDEXES WHERE OWNER = ${literal(target.schema)} AND INDEX_NAME = ${literal(frozen)}`, stillCurrent),
      query(target, `SELECT CONSTRAINT_NAME FROM SYS.ALL_CONSTRAINTS WHERE OWNER = ${literal(target.schema)} AND CONSTRAINT_NAME = ${literal(frozen)}`, stillCurrent),
    ]);
    if (indexes.length || constraints.length) invalid("changed");
    candidate = frozen;
  } else {
    candidate = await availableUniqueIndexName(target, target.tableName, targetDefinition.columns, [...snapshot.indexNames, ...snapshot.names.map((item) => item.name)], stillCurrent);
  }
  if (!candidate) invalid("changed");
  targetDefinition.index = {
    owner: target.schema,
    name: "",
    tableOwner: target.schema,
    tableName: target.tableName,
    sharing: "exclusive",
    metadataComplete: false,
    indexType: "NORMAL",
    uniqueness: targetDefinition.state.deferrable || !targetDefinition.state.validated ? "NONUNIQUE" : "UNIQUE",
    status: "VALID",
    partitioned: false,
    visibility: "VISIBLE",
    secondary: "N",
    columns: [...targetDefinition.columns],
    directions: targetDefinition.columns.map(() => "ASC"),
    keyIsExpression: targetDefinition.columns.map(() => false),
    includedColumns: [],
    newNameAvailable: true,
    newName: candidate,
  };
  return next;
}

function oceanbaseCheckTokens(expression: string): string[] {
  let tokens = expressionTokens(expression);
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    if (token === ")" && --depth < 0) return [];
  }
  if (depth !== 0) return [];
  // OceanBase wraps CHECK dictionary expressions; preserve all internal grouping.
  while (tokens[0] === "(" && tokens[tokens.length - 1] === ")") {
    depth = 0;
    const end = tokens.findIndex((token) => {
      if (token === "(") depth++;
      if (token === ")") depth--;
      return depth === 0;
    });
    if (end !== tokens.length - 1) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function readbackMatches(target: OracleConstraintTarget, actual: OracleConstraintDefinition | undefined, expected: OracleConstraintDefinition): boolean {
  if (!actual || actual.kind !== expected.kind || actual.definition.name !== expected.definition.name || sortedJson(actual.definition.state) !== sortedJson(expected.definition.state)) return false;
  if (expected.kind === "check" && actual.kind === "check") {
    if (target.databaseType === "oceanbase-oracle") {
      const actualTokens = oceanbaseCheckTokens(actual.definition.expression);
      const expectedTokens = oceanbaseCheckTokens(expected.definition.expression);
      return actualTokens.length > 0 && expectedTokens.length > 0 && sortedJson(actualTokens) === sortedJson(expectedTokens);
    }
    return sortedJson(expressionTokens(actual.definition.expression)) === sortedJson(expressionTokens(expected.definition.expression));
  }
  if (expected.kind !== "unique" || actual.kind !== "unique") return false;
  if (sortedJson(actual.definition.columns) !== sortedJson(expected.definition.columns)) return false;
  const index = actual.definition.index;
  const expectedUniqueness = expected.definition.index.uniqueness;
  if (!expected.definition.state.enabled && !expected.definition.index.name) return true;
  if (
    !index.metadataComplete ||
    index.owner !== target.schema ||
    index.tableOwner !== target.schema ||
    index.tableName !== target.tableName ||
    index.indexType !== "NORMAL" ||
    index.uniqueness !== expectedUniqueness ||
    index.status !== "VALID" ||
    index.partitioned ||
    index.visibility !== "VISIBLE" ||
    index.columns.length !== expected.definition.columns.length ||
    !sameIdentifierSet(index.columns, expected.definition.columns) ||
    index.directions.length !== index.columns.length ||
    index.directions.some((direction) => direction !== "ASC") ||
    index.keyIsExpression.some(Boolean) ||
    index.includedColumns.length
  )
    return false;
  if (target.databaseType === "oceanbase-oracle") return !!index.name && index.secondary === null;
  const expectedIndexName = expected.definition.index.newName || expected.definition.index.name;
  return !!expectedIndexName && index.name === expectedIndexName;
}

async function checkCheckRows(target: OracleConstraintTarget, expression: string, stillCurrent: () => boolean) {
  let rows: unknown[][];
  try {
    rows = await query(target, `SELECT 1 FROM ${ident(target.schema)}.${ident(target.tableName)} WHERE NOT (\n${expression}\n) AND ROWNUM <= 1`, stillCurrent);
  } catch {
    invalid("unreadableData");
  }
  if (rows!.some((row) => row.length !== 1 || (row[0] !== 1 && row[0] !== "1"))) invalid("unreadableData");
  if (rows!.length) invalid("invalidData");
}

async function checkUniqueRows(target: OracleConstraintTarget, columns: string[], stillCurrent: () => boolean) {
  const names = columns.map(ident);
  const nonNull = names.map((name) => `${name} IS NOT NULL`).join(" OR ");
  let rows: unknown[][];
  try {
    rows = await query(target, `SELECT 1 FROM (SELECT 1 FROM ${ident(target.schema)}.${ident(target.tableName)} WHERE ${nonNull} GROUP BY ${names.join(", ")} HAVING COUNT(*) > 1) WHERE ROWNUM <= 1`, stillCurrent);
  } catch {
    invalid("unreadableData");
  }
  if (rows!.some((row) => row.length !== 1 || (row[0] !== 1 && row[0] !== "1"))) invalid("unreadableData");
  if (rows!.length) invalid("invalidData");
}

/** Builds one checked constraint change and its non-destructive data preflight. */
export async function prepareOracleConstraintPlan(target: OracleConstraintTarget, options: BuildTableStructureChangeSqlOptions, change: OracleConstraintChange, stillCurrent: () => boolean = () => true): Promise<OracleConstraintPlan> {
  target = { ...target };
  change = JSON.parse(JSON.stringify(change)) as OracleConstraintChange;
  options = { ...JSON.parse(JSON.stringify(options)), databaseType: target.databaseType, schema: target.schema, tableName: target.tableName, foreignKeys: [] };
  const snapshot = await readOracleConstraintSnapshot(target, change, false, stillCurrent);
  if (!stillCurrent()) invalid("changed");
  validateChange(snapshot, target, change);
  change = await prepareUniqueTargetIndex(snapshot, target, change, stillCurrent);
  options.oracleConstraintChanges = [change];
  const generated = await api.buildTableStructureChangeSql(options);
  if (generated.warnings.length || !generated.statements.length) throw new Error(generated.warnings.join("\n") || "The constraint plan is empty.");
  const hasDrop = generated.statements.some((statement) => /\bDROP\s+CONSTRAINT\b/i.test(statement));
  const checkTarget = change.target?.kind === "check" ? change.target.definition : undefined;
  const checkSource = change.original?.kind === "check" ? change.original.definition : undefined;
  if (checkTarget && checkTarget.state.validated && checkSource && (checkSource.expression !== checkTarget.expression || hasDrop)) await checkCheckRows(target, checkTarget.expression, stillCurrent);
  const uniqueTarget = change.target?.kind === "unique" ? change.target.definition : undefined;
  const uniqueSource = change.original?.kind === "unique" ? change.original.definition : undefined;
  if (uniqueSource && hasDrop && snapshot.references.length) invalid("changed");
  if (uniqueTarget && uniqueSource && uniqueTarget.state.validated && hasDrop) {
    await checkUniqueRows(target, uniqueTarget.columns, stillCurrent);
  }
  if (!stillCurrent()) invalid("changed");
  const dropsConstraint = generated.statements.some((statement) => /\bDROP\s+CONSTRAINT\b/i.test(statement));
  const notices = target.databaseType === "oceanbase-oracle" && change.original?.kind === "unique" && dropsConstraint ? ["oracleConstraint.pairedIndexImpact"] : [];
  return { target, options, change, snapshot, snapshotFingerprint: JSON.stringify(snapshot), statements: [...generated.statements], notices };
}

/** Rechecks the fixed table identity before each DDL, stops on first failure, and never retries. */
export async function executeOracleConstraintPlan(plan: OracleConstraintPlan, timeoutSecs: number, guards: (() => boolean) | { canStart?: () => boolean; connectionCurrent?: () => boolean }): Promise<OracleConstraintExecutionResult | undefined> {
  const canStart = typeof guards === "function" ? guards : (guards.canStart ?? (() => true));
  const connectionCurrent = typeof guards === "function" ? guards : (guards.connectionCurrent ?? (() => true));
  if (!canStart() || !connectionCurrent()) return undefined;
  const fresh = await prepareOracleConstraintPlan(plan.target, plan.options, plan.change, connectionCurrent);
  if (!connectionCurrent()) return undefined;
  if (!canStart()) return undefined;
  if (fresh.snapshotFingerprint !== plan.snapshotFingerprint || JSON.stringify(fresh.statements) !== JSON.stringify(plan.statements)) invalid("changed");
  const steps: OracleConstraintExecutionResult["steps"] = plan.statements.map((sql) => ({ sql, state: "notExecuted" }));
  for (const step of steps) {
    if (!canStart() || !connectionCurrent()) break;
    try {
      const result = await api.executeQuery(plan.target.connectionId, plan.target.database, step.sql.replace(/;\s*$/, ""), plan.target.schema, undefined, { catalog: plan.target.catalog, timeoutSecs });
      if (!connectionCurrent()) {
        step.state = "unknown";
        step.error = "Connection or target changed during execution; outcome is unknown.";
        return { steps, readbackError: "Connection or target changed during constraint DDL; readback is unknown." };
      }
      if (result.execution_error) {
        step.state = "rejected";
        step.error = result.error?.detail || "Constraint statement rejected";
        try {
          const actual = await readOracleConstraintSnapshot(plan.target, plan.change, false, connectionCurrent);
          if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during failure readback; actual state is unknown." };
          if (actual.objectId !== plan.snapshot.objectId) return { steps, readbackError: "Target table was replaced after a rejected constraint statement." };
          if (plan.change.target && actual.constraints.some((item) => readbackMatches(plan.target, item, plan.change.target!))) {
            step.error += " Actual target definition is present after readback.";
          } else if (plan.change.original && actual.constraints.some((item) => sortedJson(item) === sortedJson(plan.change.original))) {
            step.error += " Original definition remains after readback.";
          } else {
            step.error += " Readback shows a partial or unexpected constraint state; inspect before recovery.";
          }
          const recoverySql = await constraintRecoveryCandidate(plan, actual, () => canStart() && connectionCurrent());
          if (recoverySql) step.error += ` Manual recovery candidate: ${recoverySql}`;
        } catch (readbackError) {
          return { steps, readbackError: readbackError instanceof Error ? readbackError.message : String(readbackError) };
        }
        break;
      }
      step.state = "committed";
      if (!canStart()) break;
    } catch (error) {
      step.state = "unknown";
      step.error = error instanceof Error ? error.message : String(error);
      if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during unknown constraint outcome; readback is unknown." };
      try {
        const actual = await readOracleConstraintSnapshot(plan.target, plan.change, false, connectionCurrent);
        if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during unknown-outcome readback; actual state is unknown." };
        if (actual.objectId !== plan.snapshot.objectId) return { steps, readbackError: "Target table was replaced after an unknown constraint outcome." };
        if (plan.change.target && actual.constraints.some((item) => readbackMatches(plan.target, item, plan.change.target!))) {
          step.error += " Actual target definition is present after readback.";
        } else if (plan.change.original && actual.constraints.some((item) => sortedJson(item) === sortedJson(plan.change.original))) {
          step.error += " Original definition remains after readback.";
        } else {
          step.error += " Readback shows a partial or unexpected constraint state; inspect before recovery.";
        }
        const recoverySql = await constraintRecoveryCandidate(plan, actual, () => canStart() && connectionCurrent());
        if (recoverySql) step.error += ` Manual recovery candidate: ${recoverySql}`;
      } catch (readbackError) {
        return { steps, readbackError: readbackError instanceof Error ? readbackError.message : String(readbackError) };
      }
      break;
    }
    if (!canStart()) break;
    if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during execution; readback is unknown." };
    try {
      const current = await readOracleConstraintSnapshot(plan.target, plan.change, false, connectionCurrent);
      if (!connectionCurrent()) return { steps, readbackError: "Connection or target changed during readback; actual state is unknown." };
      if (
        current.user !== plan.snapshot.user ||
        current.currentSchema !== plan.snapshot.currentSchema ||
        current.database !== plan.snapshot.database ||
        current.databaseName !== plan.snapshot.databaseName ||
        current.objectId !== plan.snapshot.objectId ||
        JSON.stringify(current.columns) !== JSON.stringify(plan.snapshot.columns)
      ) {
        return { steps, readbackError: "Target identity changed during constraint DDL; later statements stopped." };
      }
    } catch (error) {
      return { steps, readbackError: error instanceof Error ? error.message : String(error) };
    }
  }
  const outcome: OracleConstraintExecutionResult = { steps };
  const oldUnique = plan.change.original?.kind === "unique" ? plan.change.original.definition : undefined;
  const oldIndexName = oldUnique?.index.name;
  const plannedIndexName = plan.change.target?.kind === "unique" ? plan.change.target.definition.index.newName || plan.change.target.definition.index.name : undefined;
  const destructiveIndexChange =
    !!oldIndexName && (plan.change.target === null || plan.change.target?.kind !== "unique" || plan.change.target.definition.columns.join("\0") !== oldUnique?.columns.join("\0") || plan.change.target.definition.state.deferrable !== oldUnique?.state.deferrable || plan.change.indexPolicy === "drop");
  if (!connectionCurrent()) {
    outcome.readbackError = "Connection or target changed during execution; readback is unknown.";
    return outcome;
  }
  if (steps.some((step) => step.state !== "notExecuted")) {
    try {
      const readback = await readOracleConstraintSnapshot(plan.target, plan.change, false, connectionCurrent);
      if (!connectionCurrent()) outcome.readbackError = "Connection or target changed during readback; result is unknown.";
      else if (readback.objectId !== plan.snapshot.objectId) outcome.readbackError = "Target table was replaced during constraint DDL.";
      else if (steps.every((step) => step.state === "committed") && plan.change.target && !readback.constraints.some((item) => readbackMatches(plan.target, item, plan.change.target!))) outcome.readbackError = "Constraint readback differs from the submitted definition.";
      else if (!plan.change.target && readback.constraints.some((item) => item.definition.name === plan.change.original?.definition.name)) outcome.readbackError = "Deleted constraint is still present after readback.";
      else if (oldIndexName && plan.change.indexPolicy === "keep" && !readback.indexNames.includes(oldIndexName)) outcome.readbackError = "The selected KEEP INDEX supporting index is missing after readback.";
      else if (oldIndexName && destructiveIndexChange && plan.target.databaseType === "oracle" && plan.change.indexPolicy !== "keep" && readback.indexNames.includes(oldIndexName) && plannedIndexName !== oldIndexName)
        outcome.readbackError = "The replaced or dropped supporting index remains after readback.";
      else if (plannedIndexName && plan.change.target?.kind === "unique" && plan.change.target.definition.state.enabled && plan.change.target.definition.index.newName && !readback.indexNames.includes(plannedIndexName))
        outcome.readbackError = "The planned supporting index is missing after readback.";
      if (oldUnique && !readback.constraints.some((item) => item.kind === "unique" && item.definition.name === oldUnique.name) && plan.change.target?.kind === "unique" && destructiveIndexChange && canStart())
        outcome.recoverySql = await constraintRecoveryCandidate(plan, readback, () => canStart() && connectionCurrent());
    } catch (error) {
      outcome.readbackError = error instanceof Error ? error.message : String(error);
    }
  }
  return outcome;
}
